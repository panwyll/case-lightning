/**
 * Component #4 — InfoTrack integration (searches, AML/ID, HM Land Registry routing).
 *
 * One partner API covers the three external calls a freehold purchase needs, which
 * keeps auth and error handling to a single surface. This module has four layers:
 *
 *   HttpTransport        — a fetch-shaped function; swapped for a fake in tests
 *   InfoTrackClient      — OAuth2 client-credentials token cache, retry with backoff
 *                          on 429/5xx/network, typed request/response mapping, webhook
 *                          signature verification
 *   InfoTrack*Provider   — the engine ports (SearchProvider, IdCheckProvider, title)
 *   handleInfoTrackResult— webhook → order lookup → download → file document → engine
 *
 * Failure policy (spec #4): a provider error is thrown to the caller, which logs it
 * and leaves the matter in a state a human can see (an un-ordered search is a stage
 * blocker; the /engine route's `record_search_ordered` is the manual fallback). A
 * stuck API call never silently stalls a live transaction.
 *
 * Endpoint paths and payload field names live in ENDPOINTS / the mappers below so
 * they can be aligned with InfoTrack's API specification on partner onboarding
 * without touching the engine.
 */
import crypto from 'node:crypto';
import type { IdCheckProvider, SearchProvider } from '../engine/ports';
import type { SearchType } from '../engine/types';

// ───────────────────────────── transport ─────────────────────────────

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type HttpTransport = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;

export const fetchTransport: HttpTransport = async (url, init) => {
  const res = await fetch(url, init);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: res.status, headers, text: () => res.text(), arrayBuffer: () => res.arrayBuffer() };
};

export class InfoTrackError extends Error {
  status: number;
  retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = 'InfoTrackError';
    this.status = status;
    this.retryable = retryable;
  }
}

// ───────────────────────────── client ─────────────────────────────

export interface InfoTrackConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  tokenUrl?: string;
  webhookSecret?: string;
  /** Where InfoTrack should POST results — passed on every order so routing never depends on a dashboard setting. */
  callbackUrl?: string;
  maxRetries?: number;
  /** Base delay for exponential backoff (ms). Tests set this to 0. */
  backoffMs?: number;
}

/** Endpoint map — align with the partner spec on onboarding; the mappers below are the only other place that knows the wire shape. */
export const ENDPOINTS = {
  token: '/oauth/token',
  orderSearch: '/v1/orders/searches',
  orderOfficialCopies: '/v1/orders/land-registry/official-copies',
  orderIdCheck: '/v1/orders/aml-id-checks',
  order: (ref: string) => `/v1/orders/${encodeURIComponent(ref)}`,
  document: (ref: string) => `/v1/orders/${encodeURIComponent(ref)}/document`,
};

/** InfoTrack product codes per engine search type (their catalogue names; confirm on onboarding). */
export const SEARCH_PRODUCT: Record<SearchType, string> = {
  LLC1: 'LLC1',
  CON29: 'CON29R',
  DRAINAGE_WATER: 'CON29DW',
  ENVIRONMENTAL: 'ENVIRO',
  CHANCEL: 'CHANCEL',
};

export interface OrderResult {
  reference: string;
  status: string;
  estimatedReturn?: string | null;
}

export interface WebhookEvent {
  deliveryId: string;
  reference: string;
  event: 'order.completed' | 'order.failed' | 'order.updated' | string;
  documentUrl?: string | null;
  documentName?: string | null;
  status?: string | null;
  raw: unknown;
}

export class InfoTrackClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private cfg: InfoTrackConfig,
    private transport: HttpTransport = fetchTransport,
    private now: () => number = () => Date.now()
  ) {}

  get name(): string {
    return 'infotrack';
  }

  /** OAuth2 client-credentials, cached until 60s before expiry. */
  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    const url = this.cfg.tokenUrl ?? `${this.cfg.baseUrl}${ENDPOINTS.token}`;
    const res = await this.transport(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }).toString(),
    });
    if (res.status !== 200) throw new InfoTrackError(`InfoTrack token request failed (${res.status})`, res.status, res.status >= 500);
    const body = JSON.parse(await res.text()) as { access_token: string; expires_in?: number };
    this.token = { value: body.access_token, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** Authenticated request with retry on 429/5xx/network and a single token refresh on 401. */
  private async request<T>(method: string, path: string, body?: unknown, opts: { raw?: boolean } = {}): Promise<T> {
    const max = this.cfg.maxRetries ?? 3;
    const backoff = this.cfg.backoffMs ?? 500;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let res: HttpResponse;
      try {
        res = await this.transport(`${this.cfg.baseUrl}${path}`, {
          method,
          headers: { authorization: `Bearer ${await this.accessToken()}`, accept: opts.raw ? '*/*' : 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (attempt >= max) throw new InfoTrackError(`InfoTrack unreachable: ${(err as Error).message}`, 0, true);
        await sleep(backoff * 2 ** attempt);
        continue;
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.token = null;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= max) throw new InfoTrackError(`InfoTrack error ${res.status} after ${attempt + 1} attempts`, res.status, true);
        const ra = Number(res.headers['retry-after']);
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff * 2 ** attempt);
        continue;
      }
      if (res.status >= 400) throw new InfoTrackError(`InfoTrack rejected the request (${res.status}): ${(await res.text()).slice(0, 300)}`, res.status, false);
      if (opts.raw) return Buffer.from(await res.arrayBuffer()) as unknown as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : null) as T;
    }
  }

  async orderSearch(input: { matterRef: string; searchType: SearchType; address: string; uprn?: string | null }): Promise<OrderResult> {
    const r = await this.request<{ orderId: string; status: string; estimatedCompletion?: string }>('POST', ENDPOINTS.orderSearch, {
      product: SEARCH_PRODUCT[input.searchType],
      clientReference: input.matterRef,
      property: { address: input.address, uprn: input.uprn ?? undefined },
      callbackUrl: this.cfg.callbackUrl,
    });
    return { reference: r.orderId, status: r.status, estimatedReturn: r.estimatedCompletion ?? null };
  }

  async orderOfficialCopies(input: { matterRef: string; titleNumber?: string | null; address: string }): Promise<OrderResult> {
    const r = await this.request<{ orderId: string; status: string }>('POST', ENDPOINTS.orderOfficialCopies, {
      clientReference: input.matterRef,
      titleNumber: input.titleNumber ?? undefined,
      property: { address: input.address },
      documents: ['REGISTER', 'TITLE_PLAN'],
      callbackUrl: this.cfg.callbackUrl,
    });
    return { reference: r.orderId, status: r.status };
  }

  async orderIdCheck(input: { matterRef: string; party: { name: string; email?: string | null; phone?: string | null } }): Promise<OrderResult> {
    const r = await this.request<{ orderId: string; status: string }>('POST', ENDPOINTS.orderIdCheck, {
      clientReference: input.matterRef,
      subject: input.party,
      checks: ['IDENTITY', 'PEP_SANCTIONS', 'ADDRESS'],
      callbackUrl: this.cfg.callbackUrl,
    });
    return { reference: r.orderId, status: r.status };
  }

  async getOrder(reference: string): Promise<{ status: string; documentUrl?: string | null; raw: unknown }> {
    const r = await this.request<{ status: string; document?: { url?: string } }>('GET', ENDPOINTS.order(reference));
    return { status: r.status, documentUrl: r.document?.url ?? null, raw: r };
  }

  /** Download a result document. Accepts a full URL (from the webhook) or falls back to the order's document endpoint. */
  async downloadDocument(reference: string, url?: string | null): Promise<Buffer> {
    if (url && /^https?:\/\//.test(url)) {
      const path = url.startsWith(this.cfg.baseUrl) ? url.slice(this.cfg.baseUrl.length) : null;
      if (path) return this.request<Buffer>('GET', path, undefined, { raw: true });
      // Off-host signed URL: plain GET, no bearer.
      const res = await this.transport(url, { method: 'GET', headers: { accept: '*/*' } });
      if (res.status !== 200) throw new InfoTrackError(`Document download failed (${res.status})`, res.status, res.status >= 500);
      return Buffer.from(await res.arrayBuffer());
    }
    return this.request<Buffer>('GET', ENDPOINTS.document(reference), undefined, { raw: true });
  }

  // ── webhooks ──

  /** HMAC-SHA256 over the raw body, hex, in `x-infotrack-signature`. Constant-time compare. */
  static verifySignature(secret: string, rawBody: string, signature: string | null): boolean {
    if (!signature) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const given = signature.replace(/^sha256=/i, '').trim().toLowerCase();
    if (given.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
  }

  static parseWebhook(rawBody: string): WebhookEvent {
    const raw = JSON.parse(rawBody) as Record<string, unknown>;
    const order = (raw.order ?? raw.data ?? raw) as Record<string, unknown>;
    const document = (order.document ?? raw.document ?? null) as Record<string, unknown> | null;
    const reference = String(order.orderId ?? order.id ?? raw.orderId ?? raw.reference ?? '');
    if (!reference) throw new InfoTrackError('Webhook has no order reference', 400, false);
    return {
      deliveryId: String(raw.eventId ?? raw.deliveryId ?? crypto.createHash('sha256').update(rawBody).digest('hex')),
      reference,
      event: String(raw.event ?? raw.type ?? 'order.updated'),
      documentUrl: (document?.url as string | undefined) ?? null,
      documentName: (document?.fileName as string | undefined) ?? (document?.name as string | undefined) ?? null,
      status: (order.status as string | undefined) ?? null,
      raw,
    };
  }
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// ───────────────────────────── order bookkeeping ─────────────────────────────

export interface IntegrationOrder {
  tenantId: string;
  matterId: string;
  provider: string;
  kind: 'search' | 'official_copies' | 'id_check' | 'ap1';
  subject: string | null;
  providerRef: string;
  status: 'ORDERED' | 'RETURNED' | 'FAILED' | 'CANCELLED';
}

export interface IntegrationOrderStore {
  record(order: IntegrationOrder, request: unknown): Promise<void>;
  find(provider: string, providerRef: string): Promise<IntegrationOrder | null>;
  update(provider: string, providerRef: string, status: IntegrationOrder['status'], result?: unknown): Promise<void>;
}

export class MemoryOrderStore implements IntegrationOrderStore {
  orders = new Map<string, IntegrationOrder & { request: unknown; result?: unknown }>();
  async record(order: IntegrationOrder, request: unknown) {
    this.orders.set(`${order.provider}:${order.providerRef}`, { ...order, request });
  }
  async find(provider: string, providerRef: string) {
    return this.orders.get(`${provider}:${providerRef}`) ?? null;
  }
  async update(provider: string, providerRef: string, status: IntegrationOrder['status'], result?: unknown) {
    const o = this.orders.get(`${provider}:${providerRef}`);
    if (o) Object.assign(o, { status, result });
  }
}

/** What the providers need to know about a matter to place an order. */
export interface MatterLookup {
  (tenantId: string, matterId: string): Promise<{ matterRef: string; address: string; buyerNames: string[]; clientEmail?: string | null; clientPhone?: string | null; titleNumber?: string | null }>;
}

// ───────────────────────────── engine ports ─────────────────────────────

export class InfoTrackSearchProvider implements SearchProvider {
  readonly name = 'infotrack';
  constructor(
    private client: InfoTrackClient,
    private orders: IntegrationOrderStore,
    private lookup: MatterLookup
  ) {}
  async orderSearch(input: { tenantId: string; matterId: string; searchType: SearchType }): Promise<{ reference: string }> {
    const m = await this.lookup(input.tenantId, input.matterId);
    const r = await this.client.orderSearch({ matterRef: m.matterRef, searchType: input.searchType, address: m.address });
    await this.orders.record({ tenantId: input.tenantId, matterId: input.matterId, provider: 'infotrack', kind: 'search', subject: input.searchType, providerRef: r.reference, status: 'ORDERED' }, { searchType: input.searchType, address: m.address });
    return { reference: r.reference };
  }
}

export class InfoTrackIdCheckProvider implements IdCheckProvider {
  readonly name = 'infotrack';
  constructor(
    private client: InfoTrackClient,
    private orders: IntegrationOrderStore,
    private lookup: MatterLookup
  ) {}
  async requestCheck(input: { tenantId: string; matterId: string }): Promise<{ reference: string }> {
    const m = await this.lookup(input.tenantId, input.matterId);
    const name = m.buyerNames[0];
    if (!name) throw new InfoTrackError('No buyer name on the matter to run an ID check for.', 400, false);
    const r = await this.client.orderIdCheck({ matterRef: m.matterRef, party: { name, email: m.clientEmail ?? null, phone: m.clientPhone ?? null } });
    await this.orders.record({ tenantId: input.tenantId, matterId: input.matterId, provider: 'infotrack', kind: 'id_check', subject: name, providerRef: r.reference, status: 'ORDERED' }, { name });
    return { reference: r.reference };
  }
}

/** HMLR official copies via InfoTrack — the engine's title sub-flow starts when the register arrives. */
export class InfoTrackTitleProvider {
  readonly name = 'infotrack';
  constructor(
    private client: InfoTrackClient,
    private orders: IntegrationOrderStore,
    private lookup: MatterLookup
  ) {}
  async orderOfficialCopies(input: { tenantId: string; matterId: string; titleNumber?: string | null }): Promise<{ reference: string }> {
    const m = await this.lookup(input.tenantId, input.matterId);
    const r = await this.client.orderOfficialCopies({ matterRef: m.matterRef, titleNumber: input.titleNumber ?? m.titleNumber ?? null, address: m.address });
    await this.orders.record({ tenantId: input.tenantId, matterId: input.matterId, provider: 'infotrack', kind: 'official_copies', subject: input.titleNumber ?? m.titleNumber ?? null, providerRef: r.reference, status: 'ORDERED' }, {});
    return { reference: r.reference };
  }
}

// ───────────────────────────── webhook → engine ─────────────────────────────

export interface ResultFiler {
  /** Store the downloaded bytes as a document on the matter; returns the document id. */
  file(input: { tenantId: string; matterId: string; fileName: string; mimeType: string; bytes: Buffer; docType: string; providerRef: string }): Promise<string>;
}

export interface ResultRouter {
  searchReturned(tenantId: string, matterId: string, searchType: SearchType, documentId: string): Promise<unknown>;
  titleReceived(tenantId: string, matterId: string, documentId: string): Promise<unknown>;
  idCheckResultReceived(tenantId: string, matterId: string, documentId: string): Promise<unknown>;
}

export type WebhookOutcome = { status: 'PROCESSED'; kind: IntegrationOrder['kind']; documentId: string } | { status: 'IGNORED'; reason: string } | { status: 'FAILED'; reason: string };

/**
 * The webhook handler proper (route-agnostic so it is unit-testable). Trust model: the
 * body is signed, but the only thing taken from it is the order reference and the
 * document URL — matter, tenant and sub-flow all come from OUR order record.
 */
export async function handleInfoTrackResult(deps: { client: InfoTrackClient; orders: IntegrationOrderStore; filer: ResultFiler; router: ResultRouter; log?: (m: string, d?: unknown) => void }, event: WebhookEvent): Promise<WebhookOutcome> {
  const order = await deps.orders.find('infotrack', event.reference);
  if (!order) return { status: 'IGNORED', reason: `unknown order reference ${event.reference}` };
  if (order.status !== 'ORDERED') return { status: 'IGNORED', reason: `order already ${order.status}` };
  if (event.event === 'order.failed' || event.status === 'FAILED') {
    await deps.orders.update('infotrack', event.reference, 'FAILED', event.raw);
    return { status: 'FAILED', reason: 'provider reported the order failed — re-order or record manually' };
  }
  if (event.event !== 'order.completed' && event.status !== 'COMPLETED') return { status: 'IGNORED', reason: `not a completion event (${event.event}${event.status ? `/${event.status}` : ''})` };

  const bytes = await deps.client.downloadDocument(event.reference, event.documentUrl);
  const docType = order.kind === 'search' ? `SEARCH_${order.subject}` : order.kind === 'official_copies' ? 'TITLE_REGISTER' : 'ID_CHECK_REPORT';
  const fileName = event.documentName ?? `${docType.toLowerCase()}-${event.reference}.pdf`;
  const documentId = await deps.filer.file({ tenantId: order.tenantId, matterId: order.matterId, fileName, mimeType: 'application/pdf', bytes, docType, providerRef: event.reference });
  await deps.orders.update('infotrack', event.reference, 'RETURNED', { documentId, at: new Date().toISOString() });

  if (order.kind === 'search') await deps.router.searchReturned(order.tenantId, order.matterId, order.subject as SearchType, documentId);
  else if (order.kind === 'official_copies') await deps.router.titleReceived(order.tenantId, order.matterId, documentId);
  else if (order.kind === 'id_check') await deps.router.idCheckResultReceived(order.tenantId, order.matterId, documentId);
  return { status: 'PROCESSED', kind: order.kind, documentId };
}
