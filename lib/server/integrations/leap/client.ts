/**
 * The LEAP API as the rest of the product sees it (LeapApi), and the HTTP client that
 * implements it against LEAP's REST API with OAuth 2.0 authorization-code tokens.
 *
 * Token handling: one connection per firm (tenant). Tokens live in a LeapTokenStore
 * (Postgres, encrypted — adapters.ts); the client refreshes 60 s before expiry and once
 * more on a 401, then gives up with a non-retryable LeapError so the sync marks the
 * connection as needing reconnection instead of hammering LEAP.
 *
 * Every URL comes from endpoints.ts; every payload goes through mapping.ts. This file
 * knows about retries, pagination and multipart uploads, and nothing about field names.
 */
import crypto from 'node:crypto';
import { LEAP_API_KEY_HEADER, LEAP_ENDPOINTS, LEAP_SCOPES, LEAP_WEBHOOK_SIGNATURE_HEADER } from './endpoints';
import { pick, toCard, toDocument, toMatter, toMatterType, toNote, toParty, toTask, toWebhookEvent } from './mapping';
import { LeapError, type LeapCard, type LeapDocument, type LeapFirm, type LeapListOptions, type LeapMatter, type LeapMatterParty, type LeapMatterType, type LeapNote, type LeapPage, type LeapTask, type LeapTokens, type LeapWebhookEvent } from './types';

/** Everything CONVEYi asks of LEAP. mock.ts implements it in memory; LeapHttpClient over HTTP. */
export interface LeapApi {
  readonly name: string;
  firm(): Promise<LeapFirm>;
  matterTypes(): Promise<LeapMatterType[]>;
  listMatters(opts?: LeapListOptions): Promise<LeapPage<LeapMatter>>;
  getMatter(id: string): Promise<LeapMatter | null>;
  matterParties(matterId: string): Promise<LeapMatterParty[]>;
  getCard(id: string): Promise<LeapCard | null>;
  listDocuments(matterId: string, opts?: LeapListOptions): Promise<LeapPage<LeapDocument>>;
  getDocument(id: string): Promise<LeapDocument | null>;
  downloadDocument(id: string): Promise<{ bytes: Buffer; mimeType: string | null; fileName: string | null }>;
  uploadDocument(matterId: string, input: { fileName: string; mimeType: string; bytes: Buffer; folder?: string | null; category?: string | null }): Promise<LeapDocument>;
  listTasks(matterId: string): Promise<LeapTask[]>;
  createTask(matterId: string, input: { title: string; description?: string | null; dueDate?: string | null; assigneeStaffId?: string | null; externalRef?: string | null }): Promise<LeapTask>;
  completeTask(taskId: string, note?: string | null): Promise<LeapTask>;
  addNote(matterId: string, body: string): Promise<LeapNote>;
  listNotes(matterId: string): Promise<LeapNote[]>;
  /** Register our webhook endpoint (idempotent by URL). Returns the subscription id. */
  subscribeWebhook(url: string, events: string[]): Promise<{ id: string }>;
}

export interface LeapTokenStore {
  load(tenantId: string): Promise<LeapTokens | null>;
  save(tenantId: string, tokens: LeapTokens): Promise<void>;
  /** The refresh token was rejected: the firm has to reconnect. */
  markDisconnected(tenantId: string, reason: string): Promise<void>;
}

export interface LeapClientConfig {
  /** e.g. https://auth.<region host>  — from LEAP_AUTH_BASE_URL. */
  authBaseUrl: string;
  /** e.g. https://api.<region host>   — from LEAP_API_BASE_URL. */
  apiBaseUrl: string;
  clientId: string;
  clientSecret: string;
  /** The app's API key, sent on every request (LEAP "Security & API Credentials"). Optional until confirmed. */
  apiKey?: string | null;
  redirectUri: string;
  webhookSecret?: string | null;
  maxRetries?: number;
  backoffMs?: number;
  pageSize?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type HttpTransport = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Buffer | FormData }) => Promise<HttpResponse>;

export const fetchTransport: HttpTransport = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body as BodyInit | undefined });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: res.status, headers, text: () => res.text(), arrayBuffer: () => res.arrayBuffer() };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** PKCE helpers (LEAP's authorization-code flow; harmless if LEAP ignores the verifier). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export class LeapHttpClient implements LeapApi {
  readonly name = 'leap';
  private inflightRefresh: Promise<LeapTokens> | null = null;

  constructor(
    private cfg: LeapClientConfig,
    private tenantId: string,
    private tokens: LeapTokenStore,
    private transport: HttpTransport = fetchTransport,
    private now: () => number = () => Date.now()
  ) {}

  // ───────────── OAuth ─────────────

  static authorizeUrl(cfg: Pick<LeapClientConfig, 'authBaseUrl' | 'clientId' | 'redirectUri'>, state: string, challenge: string): string {
    const qs = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri, scope: LEAP_SCOPES.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256' });
    return `${cfg.authBaseUrl.replace(/\/+$/, '')}${LEAP_ENDPOINTS.authorize}?${qs}`;
  }

  /** Exchange the authorization code and persist the tokens for this tenant. */
  async connectWithCode(code: string, verifier: string): Promise<LeapTokens> {
    const t = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.redirectUri, code_verifier: verifier });
    await this.tokens.save(this.tenantId, t);
    return t;
  }

  private async tokenRequest(params: Record<string, string>): Promise<LeapTokens> {
    const res = await this.transport(`${this.cfg.authBaseUrl.replace(/\/+$/, '')}${LEAP_ENDPOINTS.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...(this.cfg.apiKey ? { [LEAP_API_KEY_HEADER]: this.cfg.apiKey } : {}) },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...params }).toString(),
    });
    const text = await res.text();
    if (res.status !== 200) throw new LeapError(`LEAP token request failed (${res.status}): ${text.slice(0, 200)}`, res.status, res.status >= 500);
    const body = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
    return { accessToken: body.access_token, refreshToken: body.refresh_token ?? null, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000, scope: body.scope ?? null };
  }

  private async accessToken(force = false): Promise<string> {
    const current = await this.tokens.load(this.tenantId);
    if (!current) throw new LeapError('LEAP is not connected for this firm — connect it from /integrations/leap.', 503, false);
    if (!force && current.expiresAt - 60_000 > this.now()) return current.accessToken;
    if (!current.refreshToken) throw new LeapError('LEAP token expired and no refresh token is held — reconnect.', 401, false);
    if (!this.inflightRefresh) {
      this.inflightRefresh = this.tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refreshToken })
        .then(async (t) => {
          const merged = { ...t, refreshToken: t.refreshToken ?? current.refreshToken };
          await this.tokens.save(this.tenantId, merged);
          return merged;
        })
        .catch(async (err: LeapError) => {
          if (!err.retryable) await this.tokens.markDisconnected(this.tenantId, err.message);
          throw err;
        })
        .finally(() => (this.inflightRefresh = null));
    }
    return (await this.inflightRefresh).accessToken;
  }

  // ───────────── transport ─────────────

  private async request<T>(method: string, path: string, body?: unknown, opts: { raw?: boolean; query?: Record<string, string | number | undefined | null>; form?: FormData } = {}): Promise<T> {
    const max = this.cfg.maxRetries ?? 3;
    const backoff = this.cfg.backoffMs ?? 500;
    const qs = opts.query ? Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '') : [];
    const url = `${this.cfg.apiBaseUrl.replace(/\/+$/, '')}${path}${qs.length ? `?${new URLSearchParams(qs.map(([k, v]) => [k, String(v)]))}` : ''}`;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let res: HttpResponse;
      try {
        const token = await this.accessToken(refreshed && attempt > 0 ? false : false);
        res = await this.transport(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: opts.raw ? '*/*' : 'application/json',
            ...(this.cfg.apiKey ? { [LEAP_API_KEY_HEADER]: this.cfg.apiKey } : {}),
            ...(body !== undefined && !opts.form ? { 'content-type': 'application/json' } : {}),
          },
          body: opts.form ?? (body !== undefined ? JSON.stringify(body) : undefined),
        });
      } catch (err) {
        if (err instanceof LeapError) throw err;
        if (attempt >= max) throw new LeapError(`LEAP unreachable: ${(err as Error).message}`, 0, true);
        await sleep(backoff * 2 ** attempt);
        continue;
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.accessToken(true);
        continue;
      }
      if (res.status === 404) return null as T;
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= max) throw new LeapError(`LEAP error ${res.status} after ${attempt + 1} attempts`, res.status, true);
        const ra = Number(res.headers['retry-after']);
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff * 2 ** attempt);
        continue;
      }
      if (res.status >= 400) throw new LeapError(`LEAP rejected the request (${res.status}): ${(await res.text()).slice(0, 300)}`, res.status, false);
      if (opts.raw) return { bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers } as unknown as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : null) as T;
    }
  }

  /** LEAP list responses: an array, or { items | data | results | value: [...] , next | nextCursor | nextLink | offset }. */
  private page<T>(body: unknown, map: (raw: unknown) => T, requested: number, cursor: string | null): LeapPage<T> {
    const arr = Array.isArray(body) ? body : ((pick(body, ['items', 'data', 'results', 'value', 'matters', 'documents', 'cards', 'tasks', 'notes']) as unknown[] | undefined) ?? []);
    const explicitNext = pick(body, ['next', 'nextCursor', 'nextPageToken', 'nextLink', 'continuationToken']);
    let next: string | null = explicitNext ? String(explicitNext) : null;
    if (!next && !Array.isArray(body)) {
      const total = pick(body, ['total', 'totalCount', 'count']);
      const offset = Number(cursor ?? 0);
      if (total !== undefined && offset + arr.length < Number(total)) next = String(offset + arr.length);
      else if (total === undefined && arr.length >= requested && requested > 0) next = String(offset + arr.length);
    }
    return { items: arr.map(map), next };
  }

  // ───────────── reads ─────────────

  async firm(): Promise<LeapFirm> {
    const r = await this.request<unknown>('GET', LEAP_ENDPOINTS.firm);
    return { id: String(pick(r, ['id', 'firmId']) ?? ''), name: String(pick(r, ['name', 'firmName']) ?? ''), region: (pick(r, ['region', 'country']) as LeapFirm['region']) ?? null };
  }

  async matterTypes(): Promise<LeapMatterType[]> {
    const r = await this.request<unknown>('GET', LEAP_ENDPOINTS.matterTypes);
    return this.page(r, (x) => toMatterType(x)!, 0, null).items.filter(Boolean);
  }

  async listMatters(opts: LeapListOptions = {}): Promise<LeapPage<LeapMatter>> {
    const limit = opts.limit ?? this.cfg.pageSize ?? 100;
    const r = await this.request<unknown>('GET', LEAP_ENDPOINTS.matters, undefined, { query: { limit, offset: opts.cursor ?? undefined, cursor: opts.cursor ?? undefined, updatedSince: opts.updatedSince ?? undefined, status: 'open' } });
    return this.page(r, toMatter, limit, opts.cursor ?? null);
  }

  async getMatter(id: string): Promise<LeapMatter | null> {
    const r = await this.request<unknown>('GET', LEAP_ENDPOINTS.matter(id));
    return r ? toMatter(r) : null;
  }

  async matterParties(matterId: string): Promise<LeapMatterParty[]> {
    const r = await this.request<unknown>('GET', LEAP_ENDPOINTS.matterParties(matterId));
    return r ? this.page(r, toParty, 0, null).items : [];
  }

  async getCard(id: string): Promise<LeapCard | null> {
    const r = await this.request<unknown>('GET', LEAP_ENDPOINTS.card(id));
    return r ? toCard(r) : null;
  }

  async listDocuments(matterId: string, opts: LeapListOptions = {}): Promise<LeapPage<LeapDocument>> {
    const limit = opts.limit ?? this.cfg.pageSize ?? 100;
    const r = await this.request<unknown>('GET', LEAP_ENDPOINTS.matterDocuments(matterId), undefined, { query: { limit, offset: opts.cursor ?? undefined, cursor: opts.cursor ?? undefined, updatedSince: opts.updatedSince ?? undefined } });
    return this.page(r, (x) => toDocument(x, matterId), limit, opts.cursor ?? null);
  }

  async getDocument(id: string): Promise<LeapDocument | null> {
    const r = await this.request<unknown>('GET', LEAP_ENDPOINTS.document(id));
    return r ? toDocument(r) : null;
  }

  async downloadDocument(id: string): Promise<{ bytes: Buffer; mimeType: string | null; fileName: string | null }> {
    const r = await this.request<{ bytes: Buffer; headers: Record<string, string> } | null>('GET', LEAP_ENDPOINTS.documentDownload(id), undefined, { raw: true });
    if (!r) throw new LeapError('Document not found in LEAP.', 404, false);
    const cd = r.headers['content-disposition'] ?? '';
    const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    return { bytes: r.bytes, mimeType: r.headers['content-type'] ?? null, fileName: m ? decodeURIComponent(m[1]) : null };
  }

  // ───────────── writes ─────────────

  async uploadDocument(matterId: string, input: { fileName: string; mimeType: string; bytes: Buffer; folder?: string | null; category?: string | null }): Promise<LeapDocument> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), input.fileName);
    form.append('name', input.fileName);
    if (input.folder) form.append('folder', input.folder);
    if (input.category) form.append('category', input.category);
    const r = await this.request<unknown>('POST', LEAP_ENDPOINTS.matterDocuments(matterId), undefined, { form });
    return toDocument(r, matterId);
  }

  async listTasks(matterId: string): Promise<LeapTask[]> {
    const r = await this.request<unknown>('GET', LEAP_ENDPOINTS.matterTasks(matterId));
    return r ? this.page(r, (x) => toTask(x, matterId), 0, null).items : [];
  }

  async createTask(matterId: string, input: { title: string; description?: string | null; dueDate?: string | null; assigneeStaffId?: string | null; externalRef?: string | null }): Promise<LeapTask> {
    const r = await this.request<unknown>('POST', LEAP_ENDPOINTS.matterTasks(matterId), { title: input.title, description: input.description ?? null, dueDate: input.dueDate ?? null, assigneeId: input.assigneeStaffId ?? null, externalRef: input.externalRef ?? null });
    return toTask(r, matterId);
  }

  async completeTask(taskId: string, note?: string | null): Promise<LeapTask> {
    const r = await this.request<unknown>('PATCH', LEAP_ENDPOINTS.task(taskId), { completed: true, completedAt: new Date(this.now()).toISOString(), note: note ?? null });
    return toTask(r);
  }

  async addNote(matterId: string, body: string): Promise<LeapNote> {
    const r = await this.request<unknown>('POST', LEAP_ENDPOINTS.matterNotes(matterId), { body });
    return toNote(r, matterId);
  }

  async listNotes(matterId: string): Promise<LeapNote[]> {
    const r = await this.request<unknown>('GET', LEAP_ENDPOINTS.matterNotes(matterId));
    return r ? this.page(r, (x) => toNote(x, matterId), 0, null).items : [];
  }

  async subscribeWebhook(url: string, events: string[]): Promise<{ id: string }> {
    const r = await this.request<unknown>('POST', LEAP_ENDPOINTS.webhooks, { url, events });
    return { id: String(pick(r, ['id', 'subscriptionId', 'webhookId']) ?? url) };
  }

  // ───────────── webhooks ─────────────

  /** HMAC-SHA256 (hex or base64) over the raw body; constant-time compare. Unsigned deliveries are refused when a secret is configured. */
  static verifySignature(secret: string, rawBody: string, header: string | null): boolean {
    if (!header) return false;
    const mac = crypto.createHmac('sha256', secret).update(rawBody).digest();
    const candidates = [mac.toString('hex'), mac.toString('base64')];
    const given = header.replace(/^(sha256=|hmac-sha256=)/i, '').trim();
    return candidates.some((c) => c.length === given.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(given)));
  }

  static parseWebhook(rawBody: string, deliveryHeader?: string | null): LeapWebhookEvent {
    const fallback = deliveryHeader ?? crypto.createHash('sha256').update(rawBody).digest('hex');
    return toWebhookEvent(JSON.parse(rawBody), fallback);
  }

  static signatureHeader(): string {
    return LEAP_WEBHOOK_SIGNATURE_HEADER;
  }
}
