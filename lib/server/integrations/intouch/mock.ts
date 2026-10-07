/**
 * An in-memory InTouch that serves the Public Customer Matter API as endpoints.ts maps it:
 * the { success, message, errors, data } envelope, the paged matters list, tasks and their
 * completion, the matter folder with its download links, file upload (multipart), notes and
 * filed emails.
 *
 * The tests drive the SAME HTTP client against this transport, so the API-key header,
 * retries, paging, the envelope and the mapping seam are all real. A download link is served
 * from a separate host, as InTouch's are, so the tests also prove the firm's key is never sent
 * to it.
 */
import { INTOUCH_API_TOKEN_HEADER, INTOUCH_ENDPOINTS } from './endpoints';
import type { HttpResponse, HttpTransport } from './client';

export interface MockCaseSeed {
  guid?: string;
  reference?: string;
  state?: string;
  templateName?: string;
  addressLine1?: string;
  addressLine2?: string;
  postcode?: string;
  primaryClientForename?: string;
  primaryClientSurname?: string;
  primaryClientEmail?: string;
  feeEarnerFullName?: string;
  feeEarnerTeamName?: string;
  lastUpdated?: string;
  tasks?: string[];
}

interface Stored {
  raw: Record<string, unknown>;
  tasks: Array<{ guid: string; name: string; state: string; isCompleted: boolean; completedOn: string | null }>;
  folder: Array<Record<string, unknown>>;
  notes: Array<{ htmlContent: string; label1?: string }>;
  emails: Array<Record<string, unknown>>;
}

const DOWNLOAD_HOST = 'https://files.mock-intouch.test';

const envelope = (status: number, data: unknown, message = ''): HttpResponse => {
  const body = { success: status < 400, message, errors: status < 400 ? [] : [message || 'error'], additionalData: {}, ...(data === undefined ? {} : { data }) };
  return { status, headers: { 'content-type': 'application/json' }, text: async () => JSON.stringify(body), arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer };
};

export class MockInTouch {
  readonly cases = new Map<string, Stored>();
  readonly bytes = new Map<string, Buffer>();
  /** Every request the client made — tests assert on paths, not on internals. */
  readonly calls: Array<{ method: string; path: string; query: Record<string, string[]>; body?: unknown; headers: Record<string, string> }> = [];
  /** Flip to make the next N requests fail, to exercise retry and backoff. */
  failNext = 0;
  failStatus = 500;
  /** Make the list refuse orderBy (InTouch's allowed values are not documented). */
  rejectOrderBy = false;
  private seq = 0;

  /** `apiToken`: the only key this InTouch accepts in `x-intouch-o-token`. */
  constructor(private opts: { apiToken?: string } = {}) {}

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
  }

  seed(seed: MockCaseSeed = {}): string {
    const guid = seed.guid ?? this.id('aaaaaaaa');
    const raw: Record<string, unknown> = {
      guid,
      reference: seed.reference ?? `IT${this.seq}`,
      itrCode: `ITR${this.seq}`,
      state: seed.state ?? 'Live',
      templateGuid: this.id('bbbbbbbb'),
      templateName: seed.templateName ?? 'Freehold Purchase',
      addressLine1: seed.addressLine1 ?? '12 Example Street',
      addressLine2: seed.addressLine2 ?? 'Reading',
      addressLine3: '',
      addressLine4: '',
      postcode: seed.postcode ?? 'RG1 1AA',
      primaryClientForename: seed.primaryClientForename ?? 'Priya',
      primaryClientMiddleName: '',
      primaryClientSurname: seed.primaryClientSurname ?? 'Okafor',
      primaryClientOrganisation: '',
      primaryClientEmail: seed.primaryClientEmail ?? 'priya@example.com',
      primaryClientPhone: '07700 900123',
      feeEarnerFullName: seed.feeEarnerFullName ?? 'Alice Okafor',
      feeEarnerTeamName: seed.feeEarnerTeamName ?? 'Residential',
      createdOn: '2026-09-01T09:00:00Z',
      lastUpdated: seed.lastUpdated ?? '2026-09-20T09:00:00Z',
    };
    const tasks = (seed.tasks ?? ['Client onboarding', 'Searches ordered', 'Enquiries raised', 'Report on title sent', 'Ready to exchange', 'Exchange of contracts', 'Completion']).map((name) => ({ guid: this.id('cccccccc'), name, state: 'Open', isCompleted: false, completedOn: null }));
    this.cases.set(guid, { raw, tasks, folder: [], notes: [], emails: [] });
    return guid;
  }

  /** A file in the matter's folder (the ID report, a completed TA6, a client's upload). */
  addFile(caseGuid: string, input: { name?: string; label?: string; type?: string; content?: string; createdOn?: string } = {}): string {
    const c = this.cases.get(caseGuid)!;
    const guid = this.id('dddddddd');
    const name = input.name ?? 'Client upload.pdf';
    c.folder.push({ guid, type: input.type ?? 'File', description: name, fields: { fileName: name, ...(input.label ? { label: input.label } : {}) }, getDownloadUrl: `${INTOUCH_ENDPOINTS.downloadUrl(caseGuid, guid)}`, createdOn: input.createdOn ?? '2026-09-20T11:05:00Z', lastUpdated: input.createdOn ?? '2026-09-20T11:05:00Z' });
    this.bytes.set(guid, Buffer.from(input.content ?? `%PDF-1.4 mock ${guid}`));
    return guid;
  }

  touch(caseGuid: string, at: string): void {
    this.cases.get(caseGuid)!.raw.lastUpdated = at;
  }

  notesFor(caseGuid: string): string[] {
    return (this.cases.get(caseGuid)?.notes ?? []).map((n) => n.htmlContent);
  }

  completedTasks(caseGuid: string): string[] {
    return (this.cases.get(caseGuid)?.tasks ?? []).filter((t) => t.isCompleted).map((t) => t.name);
  }

  /** A webhook body in InTouch's documented envelope (flat keys with literal dots). */
  static webhookBody(event: string, data: Record<string, unknown>, by: { name?: string; email?: string } = {}): string {
    return JSON.stringify({ event, 'triggered.by.name': by.name ?? 'Priya Okafor', 'triggered.by.email': by.email ?? 'priya@example.com', timestamp: '2026-09-20T17:01:23Z', data });
  }

  /** The transport to hand to InTouchHttpClient. */
  transport: HttpTransport = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname;
    const query: Record<string, string[]> = {};
    u.searchParams.forEach((v, k) => (query[k] ??= []).push(v));
    const isJson = (init.headers['content-type'] ?? '').startsWith('application/json');
    const body = init.body && isJson ? JSON.parse(String(init.body)) : init.body;
    this.calls.push({ method: init.method, path, query, body, headers: init.headers });

    // A download link: another host, no API key wanted (and none should arrive).
    if (`${u.protocol}//${u.host}` === DOWNLOAD_HOST) {
      const bytes = this.bytes.get(path.slice(1));
      if (!bytes) return { status: 404, headers: {}, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
      return { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${path.slice(1)}.pdf"` }, text: async () => bytes.toString('utf8'), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    }

    if (this.failNext > 0) {
      this.failNext -= 1;
      return envelope(this.failStatus, undefined, 'mock failure');
    }
    // Every request needs the firm's API key.
    if ((init.headers[INTOUCH_API_TOKEN_HEADER] ?? '') !== (this.opts.apiToken ?? 'mock-key')) return envelope(401, undefined, 'unauthorised');

    if (path === INTOUCH_ENDPOINTS.matters && init.method === 'GET') {
      if (this.rejectOrderBy && query.orderBy) return envelope(400, undefined, `Invalid orderBy ${query.orderBy[0]}`);
      const page = Number(query.page?.[0] ?? 1);
      const size = Number(query.pageSize?.[0] ?? 50);
      let all = [...this.cases.values()].map((c) => c.raw);
      if (query.orderBy?.[0] === 'lastUpdated') all = all.sort((a, b) => String(b.lastUpdated).localeCompare(String(a.lastUpdated)) * (query.orderByDirection?.[0] === 'asc' ? -1 : 1));
      return envelope(200, { matters: all.slice((page - 1) * size, page * size) });
    }

    const tm = /^\/api\/v2\/public\/mattertasks\/([^/]+)\/complete$/.exec(path);
    if (tm && init.method === 'POST') {
      for (const c of this.cases.values()) {
        const t = c.tasks.find((x) => x.guid === decodeURIComponent(tm[1]));
        if (t) { t.isCompleted = true; t.state = 'Complete'; t.completedOn = '2026-09-21T09:00:00Z'; return envelope(200, undefined); }
      }
      return envelope(404, undefined, 'no such task');
    }

    const mm = /^\/api\/v2\/public\/matters\/([^/]+)(\/.*)?$/.exec(path);
    if (mm) {
      const guid = decodeURIComponent(mm[1]);
      const rest = mm[2] ?? '';
      const c = this.cases.get(guid);
      if (!c) return envelope(404, undefined, 'no such matter');
      if (rest === '/tasks' && init.method === 'GET') return envelope(200, { tasks: c.tasks });
      if (rest === '/folder/list' && init.method === 'GET') {
        const page = Number(query.page?.[0] ?? 1);
        const size = Number(query.pageSize?.[0] ?? 50);
        return envelope(200, { items: c.folder.slice((page - 1) * size, page * size) });
      }
      const dl = /^\/folder\/([^/]+)\/download-url$/.exec(rest);
      if (dl && init.method === 'GET') {
        const id = decodeURIComponent(dl[1]);
        return this.bytes.has(id) ? envelope(200, { guid: id, downloadUrl: `${DOWNLOAD_HOST}/${id}` }) : envelope(404, undefined, 'no such item');
      }
      if (rest === '/files' && init.method === 'POST') {
        const raw = Buffer.isBuffer(init.body) ? init.body.toString('latin1') : String(init.body ?? '');
        const name = /filename="([^"]+)"/.exec(raw)?.[1] ?? 'upload';
        const content = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n--[^\r\n]+--\r\n$/, '');
        this.addFile(guid, { name, label: query.label?.[0], content, createdOn: '2026-09-22T10:00:00Z' });
        return envelope(200, undefined);
      }
      if (rest === '/folder/notes' && init.method === 'POST') {
        c.notes.push(body as { htmlContent: string; label1?: string });
        return envelope(200, { matterNoteGuid: this.id('eeeeeeee') });
      }
      if (rest === '/folder/emails' && init.method === 'POST') {
        c.emails.push(body as Record<string, unknown>);
        return envelope(200, { matterEmailGuid: this.id('ffffffff') });
      }
    }
    return envelope(404, undefined, `mock InTouch has no route for ${init.method} ${path}`);
  };
}
