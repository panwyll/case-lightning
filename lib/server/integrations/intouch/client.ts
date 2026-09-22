/**
 * The InTouch API as the rest of the product sees it (InTouchApi), and the HTTP client
 * that implements it.
 *
 * Auth: a firm's connection is server-to-server, so the default grant is
 * client-credentials with the firm's own client id/secret; the authorization-code path is
 * kept for the case where InTouch requires a person to consent. Tokens live in an
 * InTouchTokenStore (Postgres, encrypted — adapters.ts); the client refreshes 60s before
 * expiry and once more on a 401, then gives up with a non-retryable InTouchError so the
 * sync marks the connection as needing attention instead of hammering InTouch.
 *
 * Every URL comes from endpoints.ts; every payload goes through mapping.ts. This file
 * knows about retries, pagination and downloads, and nothing about field names.
 */
import crypto from 'node:crypto';
import { INTOUCH_API_KEY_HEADER, INTOUCH_ENDPOINTS, INTOUCH_SCOPES, INTOUCH_WEBHOOK_SIGNATURE_HEADER, type InTouchMilestone } from './endpoints';
import { milestoneBody, pick, toAccount, toCase, toDocument, toForm, toIdentityCheck, toParty, toWebhookEvent } from './mapping';
import { InTouchError, type InTouchAccount, type InTouchCase, type InTouchDocument, type InTouchForm, type InTouchIdentityCheck, type InTouchListOptions, type InTouchPage, type InTouchParty, type InTouchTokens, type InTouchWebhookEvent } from './types';

/** Everything CONVEYi asks of InTouch. mock.ts implements it in memory. */
export interface InTouchApi {
  readonly name: string;
  account(): Promise<InTouchAccount>;
  listCases(opts?: InTouchListOptions): Promise<InTouchPage<InTouchCase>>;
  getCase(id: string): Promise<InTouchCase | null>;
  caseParties(caseId: string): Promise<InTouchParty[]>;
  identityChecks(caseId: string): Promise<InTouchIdentityCheck[]>;
  getIdentityCheck(id: string): Promise<InTouchIdentityCheck | null>;
  forms(caseId: string): Promise<InTouchForm[]>;
  getForm(id: string): Promise<InTouchForm | null>;
  listDocuments(caseId: string, opts?: InTouchListOptions): Promise<InTouchPage<InTouchDocument>>;
  getDocument(id: string): Promise<InTouchDocument | null>;
  downloadDocument(id: string): Promise<{ bytes: Buffer; mimeType: string | null; fileName: string | null }>;
  /** Tell the client portal where the case has got to. One way: the engine is the truth. */
  pushMilestone(caseId: string, milestone: InTouchMilestone, note?: string | null, at?: string | null): Promise<void>;
  /** Ask InTouch to run an identity check on a party (when the firm drives it from here). */
  requestIdentityCheck(caseId: string, partyId: string): Promise<{ id: string }>;
  /** Ask InTouch to send the client a form to fill in. */
  requestForm(caseId: string, code: string): Promise<{ id: string }>;
  subscribeWebhook(url: string, events: readonly string[]): Promise<{ id: string }>;
}

export interface InTouchTokenStore {
  load(tenantId: string): Promise<InTouchTokens | null>;
  save(tenantId: string, tokens: InTouchTokens): Promise<void>;
  markDisconnected(tenantId: string, reason: string): Promise<void>;
}

export interface InTouchClientConfig {
  apiBaseUrl: string;
  /** Defaults to apiBaseUrl when InTouch issues tokens from the same host. */
  authBaseUrl?: string | null;
  clientId: string;
  clientSecret: string;
  apiKey?: string | null;
  redirectUri?: string | null;
  webhookSecret?: string | null;
  /** 'client_credentials' (default) or 'authorization_code'. */
  grant?: 'client_credentials' | 'authorization_code';
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
export type HttpTransport = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Buffer }) => Promise<HttpResponse>;

export const fetchTransport: HttpTransport = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body as BodyInit | undefined });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  return { status: res.status, headers, text: () => res.text(), arrayBuffer: () => res.arrayBuffer() };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Verify a webhook signature: HMAC-SHA256 hex over the RAW body, compared in constant
 * time. An unsigned delivery is rejected when a secret is configured — an unauthenticated
 * webhook is an open door into the case file.
 */
export function verifyWebhookSignature(rawBody: string, header: string | null, secret: string | null): boolean {
  if (!secret) return true; // nothing configured yet: the route decides whether to allow it
  if (!header) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const given = header.replace(/^sha256=/i, '').trim();
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class InTouchHttpClient implements InTouchApi {
  readonly name = 'intouch';
  private inflight: Promise<InTouchTokens> | null = null;

  constructor(
    private cfg: InTouchClientConfig,
    private tenantId: string,
    private tokens: InTouchTokenStore,
    private transport: HttpTransport = fetchTransport,
    private now: () => number = () => Date.now()
  ) {}

  private get authBase(): string {
    return (this.cfg.authBaseUrl || this.cfg.apiBaseUrl).replace(/\/+$/, '');
  }

  // ───────────── auth ─────────────

  static authorizeUrl(cfg: Pick<InTouchClientConfig, 'apiBaseUrl' | 'authBaseUrl' | 'clientId' | 'redirectUri'>, state: string): string {
    const qs = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri ?? '', scope: INTOUCH_SCOPES.join(' '), state });
    return `${(cfg.authBaseUrl || cfg.apiBaseUrl).replace(/\/+$/, '')}${INTOUCH_ENDPOINTS.authorize}?${qs}`;
  }

  /** Exchange an authorization code (only used when InTouch requires user consent). */
  async connectWithCode(code: string): Promise<InTouchTokens> {
    const t = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.redirectUri ?? '' });
    await this.tokens.save(this.tenantId, t);
    return t;
  }

  /** Connect with the firm's own credentials — the normal path. */
  async connectWithClientCredentials(): Promise<InTouchTokens> {
    const t = await this.tokenRequest({ grant_type: 'client_credentials', scope: INTOUCH_SCOPES.join(' ') });
    await this.tokens.save(this.tenantId, t);
    return t;
  }

  private async tokenRequest(params: Record<string, string>): Promise<InTouchTokens> {
    const res = await this.transport(`${this.authBase}${INTOUCH_ENDPOINTS.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...(this.cfg.apiKey ? { [INTOUCH_API_KEY_HEADER]: this.cfg.apiKey } : {}) },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...params }).toString(),
    });
    const text = await res.text();
    if (res.status !== 200) throw new InTouchError(`InTouch token request failed (${res.status}): ${text.slice(0, 200)}`, res.status, res.status >= 500);
    const body = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
    return { accessToken: body.access_token, refreshToken: body.refresh_token ?? null, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000, scope: body.scope ?? null };
  }

  private async accessToken(force = false): Promise<string> {
    const current = await this.tokens.load(this.tenantId);
    if (!current) throw new InTouchError('InTouch is not connected for this firm — connect it from the integrations page.', 503, false);
    if (!force && current.expiresAt - 60_000 > this.now()) return current.accessToken;
    if (!this.inflight) {
      // A client-credentials connection just asks for another token; an authorization-code
      // one needs its refresh token, and without one the firm has to reconnect.
      const renew =
        current.refreshToken
          ? this.tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refreshToken })
          : (this.cfg.grant ?? 'client_credentials') === 'client_credentials'
          ? this.tokenRequest({ grant_type: 'client_credentials', scope: INTOUCH_SCOPES.join(' ') })
          : Promise.reject(new InTouchError('InTouch token expired and no refresh token is held — reconnect.', 401, false));
      this.inflight = renew
        .then(async (t) => {
          const merged = { ...t, refreshToken: t.refreshToken ?? current.refreshToken };
          await this.tokens.save(this.tenantId, merged);
          return merged;
        })
        .catch(async (err: InTouchError) => {
          if (!err.retryable) await this.tokens.markDisconnected(this.tenantId, err.message);
          throw err;
        })
        .finally(() => (this.inflight = null));
    }
    return (await this.inflight).accessToken;
  }

  // ───────────── transport ─────────────

  private async request<T>(method: string, path: string, body?: unknown, opts: { raw?: boolean; query?: Record<string, string | number | undefined | null> } = {}): Promise<T> {
    const max = this.cfg.maxRetries ?? 3;
    const backoff = this.cfg.backoffMs ?? 500;
    const qs = opts.query ? Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '') : [];
    const url = `${this.cfg.apiBaseUrl.replace(/\/+$/, '')}${path}${qs.length ? `?${new URLSearchParams(qs.map(([k, v]) => [k, String(v)]))}` : ''}`;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let res: HttpResponse;
      try {
        const token = await this.accessToken(false);
        res = await this.transport(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: opts.raw ? '*/*' : 'application/json',
            ...(this.cfg.apiKey ? { [INTOUCH_API_KEY_HEADER]: this.cfg.apiKey } : {}),
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (err instanceof InTouchError) throw err;
        if (attempt >= max) throw new InTouchError(`InTouch unreachable: ${(err as Error).message}`, 0, true);
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
        if (attempt >= max) throw new InTouchError(`InTouch error ${res.status} after ${attempt + 1} attempts`, res.status, true);
        const ra = Number(res.headers['retry-after']);
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff * 2 ** attempt);
        continue;
      }
      if (res.status >= 400) throw new InTouchError(`InTouch rejected the request (${res.status}): ${(await res.text()).slice(0, 300)}`, res.status, false);
      if (opts.raw) return { bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers } as unknown as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : null) as T;
    }
  }

  /** List responses: an array, or { items | data | results | cases | documents, next | cursor }. */
  private page<T>(body: unknown, map: (raw: unknown) => T, requested: number, cursor: string | null): InTouchPage<T> {
    const arr = Array.isArray(body) ? body : ((pick(body, ['items', 'data', 'results', 'cases', 'documents', 'records']) as unknown[] | undefined) ?? []);
    const explicit = pick(body, ['next', 'nextCursor', 'nextPageToken', 'nextLink', 'continuationToken']);
    let next: string | null = explicit ? String(explicit) : null;
    if (!next && !Array.isArray(body)) {
      const total = Number(pick(body, ['total', 'totalCount', 'count']) ?? NaN);
      const offset = Number(cursor ?? 0);
      if (Number.isFinite(total) && offset + arr.length < total) next = String(offset + arr.length);
    }
    // An offset-paged API with no envelope: a full page implies there may be more.
    if (!next && Array.isArray(body) && arr.length >= requested) next = String(Number(cursor ?? 0) + arr.length);
    return { items: arr.map(map), next };
  }

  private listQuery(opts?: InTouchListOptions) {
    const limit = opts?.limit ?? this.cfg.pageSize ?? 100;
    return { limit, cursor: opts?.cursor ?? undefined, offset: opts?.cursor ?? undefined, updatedSince: opts?.updatedSince ?? undefined };
  }

  // ───────────── resources ─────────────

  async account(): Promise<InTouchAccount> {
    return toAccount(await this.request<unknown>('GET', INTOUCH_ENDPOINTS.account));
  }

  async listCases(opts?: InTouchListOptions): Promise<InTouchPage<InTouchCase>> {
    const q = this.listQuery(opts);
    const body = await this.request<unknown>('GET', INTOUCH_ENDPOINTS.cases, undefined, { query: q });
    return this.page(body, toCase, q.limit, opts?.cursor ?? null);
  }

  async getCase(id: string): Promise<InTouchCase | null> {
    const body = await this.request<unknown>('GET', INTOUCH_ENDPOINTS.case(id));
    return body ? toCase(body) : null;
  }

  async caseParties(caseId: string): Promise<InTouchParty[]> {
    const body = await this.request<unknown>('GET', INTOUCH_ENDPOINTS.caseParties(caseId));
    const arr = Array.isArray(body) ? body : ((pick(body, ['items', 'data', 'parties', 'results']) as unknown[] | undefined) ?? []);
    return arr.map((r) => toParty(r, caseId));
  }

  async identityChecks(caseId: string): Promise<InTouchIdentityCheck[]> {
    const body = await this.request<unknown>('GET', INTOUCH_ENDPOINTS.caseIdentityChecks(caseId));
    const arr = Array.isArray(body) ? body : ((pick(body, ['items', 'data', 'checks', 'identityChecks', 'results']) as unknown[] | undefined) ?? []);
    return arr.map((r) => toIdentityCheck(r, caseId));
  }

  async getIdentityCheck(id: string): Promise<InTouchIdentityCheck | null> {
    const body = await this.request<unknown>('GET', INTOUCH_ENDPOINTS.identityCheck(id));
    return body ? toIdentityCheck(body, String(pick(body, ['caseId', 'case.id']) ?? '')) : null;
  }

  async forms(caseId: string): Promise<InTouchForm[]> {
    const body = await this.request<unknown>('GET', INTOUCH_ENDPOINTS.caseForms(caseId));
    const arr = Array.isArray(body) ? body : ((pick(body, ['items', 'data', 'forms', 'results']) as unknown[] | undefined) ?? []);
    return arr.map((r) => toForm(r, caseId));
  }

  async getForm(id: string): Promise<InTouchForm | null> {
    const body = await this.request<unknown>('GET', INTOUCH_ENDPOINTS.form(id));
    return body ? toForm(body, String(pick(body, ['caseId', 'case.id']) ?? '')) : null;
  }

  async listDocuments(caseId: string, opts?: InTouchListOptions): Promise<InTouchPage<InTouchDocument>> {
    const q = this.listQuery(opts);
    const body = await this.request<unknown>('GET', INTOUCH_ENDPOINTS.caseDocuments(caseId), undefined, { query: q });
    return this.page(body, (r) => toDocument(r, caseId), q.limit, opts?.cursor ?? null);
  }

  async getDocument(id: string): Promise<InTouchDocument | null> {
    const body = await this.request<unknown>('GET', INTOUCH_ENDPOINTS.document(id));
    return body ? toDocument(body, String(pick(body, ['caseId', 'case.id']) ?? '')) : null;
  }

  async downloadDocument(id: string): Promise<{ bytes: Buffer; mimeType: string | null; fileName: string | null }> {
    const res = await this.request<{ bytes: Buffer; headers: Record<string, string> }>('GET', INTOUCH_ENDPOINTS.documentDownload(id), undefined, { raw: true });
    const disposition = res.headers['content-disposition'] ?? '';
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    return { bytes: res.bytes, mimeType: res.headers['content-type'] ?? null, fileName: m ? decodeURIComponent(m[1]) : null };
  }

  async pushMilestone(caseId: string, milestone: InTouchMilestone, note?: string | null, at?: string | null): Promise<void> {
    await this.request<unknown>('POST', INTOUCH_ENDPOINTS.caseMilestones(caseId), milestoneBody(milestone, note, at));
  }

  async requestIdentityCheck(caseId: string, partyId: string): Promise<{ id: string }> {
    const body = await this.request<unknown>('POST', INTOUCH_ENDPOINTS.requestIdentityCheck(caseId), { partyId });
    return { id: String(pick(body, ['id', 'checkId', 'identityCheckId']) ?? '') };
  }

  async requestForm(caseId: string, code: string): Promise<{ id: string }> {
    const body = await this.request<unknown>('POST', INTOUCH_ENDPOINTS.requestForm(caseId), { code });
    return { id: String(pick(body, ['id', 'formId']) ?? '') };
  }

  async subscribeWebhook(url: string, events: readonly string[]): Promise<{ id: string }> {
    const body = await this.request<unknown>('POST', INTOUCH_ENDPOINTS.webhooks, { url, events: [...events], secret: this.cfg.webhookSecret ?? undefined });
    return { id: String(pick(body, ['id', 'subscriptionId', 'webhookId']) ?? '') };
  }
}

export { toWebhookEvent, INTOUCH_WEBHOOK_SIGNATURE_HEADER, type InTouchWebhookEvent };
