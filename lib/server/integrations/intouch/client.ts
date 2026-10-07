/**
 * The InTouch API as the rest of the product sees it (InTouchApi), and the HTTP client
 * that implements it against InTouch's Public Customer Matter API (endpoints.ts).
 *
 * Auth (documented): a static API key the firm generates in InTouch API Management > Keys,
 * sent in `x-intouch-o-token` on every request, over HTTPS. There is no OAuth, no token
 * to refresh and nothing to store but the key. A 401/403 means InTouch did not accept the
 * key: that is a non-retryable InTouchError, so the sync marks the connection as needing
 * attention instead of hammering InTouch.
 *
 * InTouch gives no uptime guarantee, so transient failures (network, 429, 5xx) are retried
 * with backoff. Every URL comes from endpoints.ts; every payload goes through mapping.ts
 * (which unwraps InTouch's envelope and parses permissively, as InTouch asks). This file
 * knows about retries, pagination and downloads, and nothing about field names.
 */
import { INTOUCH_API_TOKEN_HEADER, INTOUCH_ENDPOINTS, MILESTONE_WORDS, type InTouchMilestone } from './endpoints';
import { pick, primaryClient, taskForMilestone, toCase, toDocument, toHtml, toTask, toWebhookEvent, unwrap } from './mapping';
import { InTouchError, type InTouchAccount, type InTouchCase, type InTouchDocument, type InTouchListOptions, type InTouchPage, type InTouchParty, type InTouchTask, type InTouchWebhookEvent } from './types';

/**
 * Everything CONVEYi asks of InTouch. mock.ts implements it over HTTP. Webhooks are not
 * here: InTouch has no API to subscribe — the firm adds our URL in InTouch.
 */
export interface InTouchApi {
  readonly name: string;
  /** Proves the key: reads one matter. InTouch has no "who am I". */
  account(): Promise<InTouchAccount>;
  listCases(opts?: InTouchListOptions): Promise<InTouchPage<InTouchCase>>;
  getCase(id: string): Promise<InTouchCase | null>;
  /** The matter's primary client: the one person InTouch's API carries. */
  caseParties(caseId: string): Promise<InTouchParty[]>;
  listDocuments(caseId: string, opts?: InTouchListOptions): Promise<InTouchPage<InTouchDocument>>;
  downloadDocument(id: string, caseId: string): Promise<{ bytes: Buffer; mimeType: string | null; fileName: string | null }>;
  tasks(caseId: string): Promise<InTouchTask[]>;
  /**
   * Tell the client portal where the case has got to, one way: the engine is the truth. Done by
   * completing the matter's task for that milestone; where the firm's workflow has none, a note.
   */
  pushMilestone(caseId: string, milestone: InTouchMilestone, note?: string | null): Promise<'task' | 'note'>;
  /** File a document on the matter (write-back). Returns InTouch's id for it when it can be found, so it is never mirrored back. */
  uploadDocument(caseId: string, file: { fileName: string; mimeType: string; bytes: Buffer; category?: string }): Promise<{ id: string }>;
  /** Add a note to the matter's folder (write-back). */
  addNote(caseId: string, text: string): Promise<void>;
  /** File a record of an email we sent on the matter (it does not send anything). */
  fileEmail(caseId: string, email: { at: string; subject: string; text: string; from?: { email: string; name?: string | null } | null; to?: Array<{ email: string; name?: string | null }> }): Promise<{ id: string | null }>;
}

export interface InTouchClientConfig {
  /** InTouch's API address (https://go.intouchapp.co.uk unless the firm's differs). */
  apiBaseUrl: string;
  /** The API key the firm generated in InTouch (API Management > Keys). */
  apiToken: string;
  maxRetries?: number;
  backoffMs?: number;
  pageSize?: number;
  /** Most pages a single listing reads (a firm with 10,000 matters is not read in one sync). */
  maxPages?: number;
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
type Query = Record<string, string | number | boolean | Array<string> | undefined | null>;

export class InTouchHttpClient implements InTouchApi {
  readonly name = 'intouch';
  /** Matters as last read from the list: the API has no read-one, so a matter's primary client and header come from here. */
  private matters = new Map<string, { c: InTouchCase; raw: unknown }>();
  /** Whether InTouch takes ordering by last update (unknown until asked; a refusal falls back to unordered). */
  private ordered: boolean | null = null;

  constructor(
    private cfg: InTouchClientConfig,
    readonly tenantId: string | null = null,
    private transport: HttpTransport = fetchTransport,
    readonly now: () => number = () => Date.now()
  ) {}

  // ───────────── transport ─────────────

  private url(path: string, query?: Query): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === '') continue;
      for (const x of Array.isArray(v) ? v : [v]) qs.append(k, String(x));
    }
    const q = qs.toString();
    return `${this.cfg.apiBaseUrl.replace(/\/+$/, '')}${path}${q ? `?${q}` : ''}`;
  }

  private async request<T>(method: string, path: string, body?: unknown, opts: { query?: Query; multipart?: { boundary: string; bytes: Buffer } } = {}): Promise<T> {
    const max = this.cfg.maxRetries ?? 3;
    const backoff = this.cfg.backoffMs ?? 500;
    const url = this.url(path, opts.query);
    if (!this.cfg.apiToken) throw new InTouchError('InTouch is not connected for this firm — connect it from the integrations page.', 503, false);
    for (let attempt = 0; ; attempt++) {
      let res: HttpResponse;
      try {
        res = await this.transport(url, {
          method,
          headers: {
            [INTOUCH_API_TOKEN_HEADER]: this.cfg.apiToken,
            accept: 'application/json',
            ...(opts.multipart ? { 'content-type': `multipart/form-data; boundary=${opts.multipart.boundary}` } : body !== undefined ? { 'content-type': 'application/json; charset=utf-8' } : {}),
          },
          body: opts.multipart ? opts.multipart.bytes : body !== undefined ? JSON.stringify(body) : undefined,
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
      const text = await res.text();
      if (res.status >= 400) {
        let why = text.slice(0, 300);
        try { const j = JSON.parse(text) as { message?: string; errors?: string[] }; why = [j.message, ...(j.errors ?? [])].filter(Boolean).join('; ') || why; } catch { /* not JSON */ }
        throw new InTouchError(`InTouch rejected the request (${res.status}): ${why}`, res.status, false);
      }
      return unwrap(text ? JSON.parse(text) : null) as T;
    }
  }

  private pageSize(opts?: InTouchListOptions) {
    return opts?.limit ?? this.cfg.pageSize ?? 100;
  }

  // ───────────── resources ─────────────

  async account(): Promise<InTouchAccount> {
    const data = await this.request<unknown>('GET', INTOUCH_ENDPOINTS.matters, undefined, { query: { page: 1, pageSize: 1 } });
    // Everywhere else a 404 is "no such thing"; here it means the address is wrong.
    if (data === null) throw new InTouchError('InTouch did not recognise that address.', 404, false);
    const first = ((pick(data, ['matters']) as unknown[] | undefined) ?? [])[0];
    const team = first ? (pick(first, ['feeEarnerTeamName']) as string | undefined) : undefined;
    return { id: '', name: team ? `InTouch · ${team}` : 'InTouch', reference: null };
  }

  /**
   * One page of matters, newest change first where InTouch will order them. With `updatedSince`,
   * the page stops at the first matter older than it and says there is nothing after: InTouch has
   * no "changed since" filter, so this is how an incremental sync stays short.
   */
  async listCases(opts?: InTouchListOptions): Promise<InTouchPage<InTouchCase>> {
    const pageSize = this.pageSize(opts);
    const page = Number(opts?.cursor ?? 1) || 1;
    const read = async (ordered: boolean) => this.request<unknown>('GET', INTOUCH_ENDPOINTS.matters, undefined, { query: { page, pageSize, ...(ordered ? { orderBy: 'lastUpdated', orderByDirection: 'desc' } : {}) } });
    let data: unknown;
    if (this.ordered !== false) {
      try { data = await read(true); this.ordered = true; } catch (err) {
        if (!(err instanceof InTouchError) || err.status !== 400) throw err;
        this.ordered = false;
        data = await read(false);
      }
    } else data = await read(false);
    const raws = (pick(data, ['matters', 'items']) as unknown[] | undefined) ?? (Array.isArray(data) ? data : []);
    const items: InTouchCase[] = [];
    let older = false;
    for (const raw of raws) {
      const c = toCase(raw);
      if (!c.id) continue;
      this.matters.set(c.id, { c, raw });
      if (opts?.updatedSince && this.ordered && c.updatedAt && c.updatedAt < opts.updatedSince) { older = true; break; }
      if (opts?.updatedSince && c.updatedAt && c.updatedAt < opts.updatedSince) continue;
      items.push(c);
    }
    const more = !older && raws.length >= pageSize && page < (this.cfg.maxPages ?? 50);
    return { items, next: more ? String(page + 1) : null };
  }

  /** A matter by its guid: from what the list showed, else the newest pages of the list (a webhook's matter has just changed, so it is near the top). */
  async getCase(id: string): Promise<InTouchCase | null> {
    const hit = this.matters.get(id);
    if (hit) return hit.c;
    let cursor: string | null = '1';
    for (let n = 0; cursor && n < 5; n++) {
      const page: InTouchPage<InTouchCase> = await this.listCases({ cursor, limit: 100 });
      const found = page.items.find((c) => c.id === id);
      if (found) return found;
      cursor = page.next;
    }
    return null;
  }

  async caseParties(caseId: string): Promise<InTouchParty[]> {
    if (!this.matters.has(caseId)) await this.getCase(caseId);
    const raw = this.matters.get(caseId)?.raw;
    const p = raw ? primaryClient(raw, caseId) : null;
    return p ? [p] : [];
  }

  async listDocuments(caseId: string, opts?: InTouchListOptions): Promise<InTouchPage<InTouchDocument>> {
    const pageSize = this.pageSize(opts);
    const page = Number(opts?.cursor ?? 1) || 1;
    const data = await this.request<unknown>('GET', INTOUCH_ENDPOINTS.folder(caseId), undefined, { query: { page, pageSize } });
    const raws = (pick(data, ['items']) as unknown[] | undefined) ?? (Array.isArray(data) ? data : []);
    const items = raws.map((r) => toDocument(r, caseId)).filter((d): d is InTouchDocument => !!d && !!d.id);
    return { items, next: raws.length >= pageSize && page < (this.cfg.maxPages ?? 50) ? String(page + 1) : null };
  }

  /**
   * The file's bytes: InTouch hands out a download URL, which is fetched as it is. The firm's API
   * key is never sent to it — it is a link to stored content, not InTouch's API.
   */
  async downloadDocument(id: string, caseId: string): Promise<{ bytes: Buffer; mimeType: string | null; fileName: string | null }> {
    const data = await this.request<unknown>('GET', INTOUCH_ENDPOINTS.downloadUrl(caseId, id));
    const link = pick(data, ['downloadUrl', 'url']);
    if (typeof link !== 'string' || !/^https:\/\//i.test(link)) throw new InTouchError('InTouch did not give a download link for that file.', 502, false);
    const res = await this.transport(link, { method: 'GET', headers: { accept: '*/*' } });
    if (res.status >= 400) throw new InTouchError(`The file could not be downloaded (${res.status}).`, res.status, res.status >= 500);
    const disposition = res.headers['content-disposition'] ?? '';
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    return { bytes: Buffer.from(await res.arrayBuffer()), mimeType: res.headers['content-type'] ?? null, fileName: m ? decodeURIComponent(m[1]) : null };
  }

  async tasks(caseId: string): Promise<InTouchTask[]> {
    const out: InTouchTask[] = [];
    for (let page = 1; page <= 10; page++) {
      const data = await this.request<unknown>('GET', INTOUCH_ENDPOINTS.tasks(caseId), undefined, { query: { page } });
      const raws = (pick(data, ['tasks', 'items']) as unknown[] | undefined) ?? [];
      out.push(...raws.map(toTask).filter((t) => t.id));
      // The task list's page size is InTouch's own; a short or empty page is the last.
      if (raws.length < 20) break;
    }
    return out;
  }

  async pushMilestone(caseId: string, milestone: InTouchMilestone, note?: string | null): Promise<'task' | 'note'> {
    const task = taskForMilestone(milestone, await this.tasks(caseId));
    if (task) {
      await this.request<unknown>('POST', INTOUCH_ENDPOINTS.completeTask(task.id));
      return 'task';
    }
    await this.addNote(caseId, `CONVEYi · ${MILESTONE_WORDS[milestone]}${note ? `: ${note}` : ''}`);
    return 'note';
  }

  /** The upload's body format is not in InTouch's definition: multipart form data with the file under "file". */
  async uploadDocument(caseId: string, file: { fileName: string; mimeType: string; bytes: Buffer; category?: string }): Promise<{ id: string }> {
    const boundary = `----conveyi${this.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const safe = file.fileName.replace(/["\r\n]/g, '_');
    const bytes = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safe}"\r\nContent-Type: ${file.mimeType || 'application/octet-stream'}\r\n\r\n`),
      file.bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    await this.request<unknown>('POST', INTOUCH_ENDPOINTS.uploadFile(caseId), undefined, { query: { overwrite: false, feeEarnerReview: false, label: [file.category ?? 'CONVEYi'] }, multipart: { boundary, bytes } });
    // The upload returns nothing: InTouch's id for the file is read back from the folder, so the next sync knows it is ours.
    const page = await this.listDocuments(caseId, { limit: 50 });
    const mine = page.items.filter((d) => d.fileName === file.fileName || d.fileName === safe).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
    return { id: mine?.id ?? `name:${file.fileName}` };
  }

  async addNote(caseId: string, text: string): Promise<void> {
    await this.request<unknown>('POST', INTOUCH_ENDPOINTS.fileNote(caseId), { htmlContent: toHtml(text).slice(0, 100_000), label1: 'CONVEYi' });
  }

  async fileEmail(caseId: string, email: { at: string; subject: string; text: string; from?: { email: string; name?: string | null } | null; to?: Array<{ email: string; name?: string | null }> }): Promise<{ id: string | null }> {
    const addr = (a: { email: string; name?: string | null }) => ({ email: a.email.slice(0, 120), ...(a.name ? { displayName: a.name.slice(0, 200) } : {}) });
    const data = await this.request<unknown>('POST', INTOUCH_ENDPOINTS.fileEmail(caseId), {
      emailDateTime: new Date(email.at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      htmlContent: toHtml(email.text),
      subject: email.subject.slice(0, 1000),
      ...(email.from ? { from: addr(email.from) } : {}),
      ...(email.to?.length ? { to: email.to.map(addr) } : {}),
    });
    const id = pick(data, ['matterEmailGuid']);
    return { id: typeof id === 'string' ? id : null };
  }
}

export { toWebhookEvent, type InTouchWebhookEvent };
