/**
 * The InTouch API as the rest of the product sees it (InTouchApi), and the HTTP client
 * that implements it.
 *
 * Auth (documented): a static API key the firm generates in InTouch under Settings > API,
 * sent in `x-intouch-o-token` on every request, over HTTPS. There is no OAuth, no token
 * to refresh and nothing to store but the key. A 401/403 means InTouch did not accept the
 * key: that is a non-retryable InTouchError, so the sync marks the connection as needing
 * attention instead of hammering InTouch.
 *
 * InTouch gives no uptime guarantee, so transient failures (network, 429, 5xx) are retried
 * with backoff. Every URL comes from endpoints.ts; every payload goes through mapping.ts
 * (which parses permissively, as InTouch asks). This file knows about retries, pagination
 * and downloads, and nothing about field names.
 */
import { INTOUCH_API_TOKEN_HEADER, INTOUCH_ENDPOINTS, type InTouchMilestone } from './endpoints';
import { milestoneBody, pick, toAccount, toCase, toDocument, toForm, toIdentityCheck, toParty, toWebhookEvent } from './mapping';
import { InTouchError, type InTouchAccount, type InTouchCase, type InTouchDocument, type InTouchForm, type InTouchIdentityCheck, type InTouchListOptions, type InTouchPage, type InTouchParty, type InTouchWebhookEvent } from './types';

/**
 * Everything CONVEYi asks of InTouch. mock.ts implements it over HTTP. Webhooks are not
 * here: InTouch has no API to subscribe — the firm adds our URL in the InTouch UI.
 */
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
  /** File a document on the case (write-back). Returns InTouch's id for it, so it is never mirrored back. */
  uploadDocument(caseId: string, file: { fileName: string; mimeType: string; bytes: Buffer; category?: string }): Promise<{ id: string }>;
  /** Add a line to the case's notes (write-back). */
  addNote(caseId: string, text: string): Promise<void>;
}

export interface InTouchClientConfig {
  /** The firm's InTouch API address (assumed; the reference is inside the firm's account). */
  apiBaseUrl: string;
  /** The API key the firm generated in InTouch (Settings > API > Keys). */
  apiToken: string;
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

export class InTouchHttpClient implements InTouchApi {
  readonly name = 'intouch';

  constructor(
    private cfg: InTouchClientConfig,
    readonly tenantId: string | null = null,
    private transport: HttpTransport = fetchTransport,
    readonly now: () => number = () => Date.now()
  ) {}

  // ───────────── transport ─────────────

  private async request<T>(method: string, path: string, body?: unknown, opts: { raw?: boolean; query?: Record<string, string | number | undefined | null> } = {}): Promise<T> {
    const max = this.cfg.maxRetries ?? 3;
    const backoff = this.cfg.backoffMs ?? 500;
    const qs = opts.query ? Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '') : [];
    const url = `${this.cfg.apiBaseUrl.replace(/\/+$/, '')}${path}${qs.length ? `?${new URLSearchParams(qs.map(([k, v]) => [k, String(v)]))}` : ''}`;
    if (!this.cfg.apiToken) throw new InTouchError('InTouch is not connected for this firm — connect it from the integrations page.', 503, false);
    for (let attempt = 0; ; attempt++) {
      let res: HttpResponse;
      try {
        res = await this.transport(url, {
          method,
          headers: {
            [INTOUCH_API_TOKEN_HEADER]: this.cfg.apiToken,
            accept: opts.raw ? '*/*' : 'application/json',
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
      if (res.status === 401 || res.status === 403) throw new InTouchError('InTouch did not accept the API key.', res.status, false);
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
    const body = await this.request<unknown>('GET', INTOUCH_ENDPOINTS.account);
    // Everywhere else a 404 is "no such thing"; here it means the address is wrong.
    if (!body) throw new InTouchError('InTouch did not recognise that address.', 404, false);
    return toAccount(body);
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

  async uploadDocument(caseId: string, file: { fileName: string; mimeType: string; bytes: Buffer; category?: string }): Promise<{ id: string }> {
    const body = await this.request<unknown>('POST', INTOUCH_ENDPOINTS.uploadDocument(caseId), { fileName: file.fileName, mimeType: file.mimeType, category: file.category ?? 'conveyi', content: file.bytes.toString('base64') });
    const id = (body as { id?: unknown; document?: { id?: unknown } } | null)?.id ?? (body as { document?: { id?: unknown } } | null)?.document?.id;
    if (typeof id !== 'string' && typeof id !== 'number') throw new InTouchError('InTouch did not return an id for the uploaded document.', 502);
    return { id: String(id) };
  }

  async addNote(caseId: string, text: string): Promise<void> {
    await this.request<unknown>('POST', INTOUCH_ENDPOINTS.caseNotes(caseId), { text, source: 'CONVEYi' });
  }

  async requestForm(caseId: string, code: string): Promise<{ id: string }> {
    const body = await this.request<unknown>('POST', INTOUCH_ENDPOINTS.requestForm(caseId), { code });
    return { id: String(pick(body, ['id', 'formId']) ?? '') };
  }
}

export { toWebhookEvent, type InTouchWebhookEvent };
