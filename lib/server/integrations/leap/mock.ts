/**
 * A LEAP you can run without LEAP.
 *
 * MockLeap is an in-memory LeapApi with seed helpers — the unit tests drive the sync and
 * write-back against it. MockLeapServer wraps it in a tiny HTTP server that serves the
 * SAME endpoint map (endpoints.ts) with the SAME raw JSON shapes mapping.ts expects, so
 * LeapHttpClient (OAuth, paging, retries, uploads, downloads, webhook signing) is
 * exercised end to end in tests and in the demo — and the moment the real reference is
 * in hand, any difference is a one-line change in endpoints.ts / mapping.ts, re-run
 * against the mock, re-run against LEAP.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { LEAP_ENDPOINTS, LEAP_WEBHOOK_DELIVERY_HEADER, LEAP_WEBHOOK_SIGNATURE_HEADER } from './endpoints';
import type { LeapApi } from './client';
import { LeapError, type LeapCard, type LeapDocument, type LeapFirm, type LeapListOptions, type LeapMatter, type LeapMatterParty, type LeapMatterType, type LeapNote, type LeapPage, type LeapPartyRole, type LeapTask } from './types';

export interface MockLeapOptions {
  firm?: Partial<LeapFirm>;
  /** Prefix for generated ids (a fresh prefix per demo run keeps mirrors from colliding). */
  idPrefix?: string | null;
  now?: () => Date;
  /** Called for every change (the HTTP server turns these into webhook deliveries). */
  onEvent?: (event: { type: string; matterId: string | null; documentId?: string | null; cardId?: string | null; taskId?: string | null }) => void;
}

export class MockLeap implements LeapApi {
  readonly name = 'mock-leap';
  private matters = new Map<string, LeapMatter>();
  private parties = new Map<string, LeapMatterParty[]>();
  private cards = new Map<string, LeapCard>();
  private documents = new Map<string, LeapDocument & { bytes: Buffer }>();
  private tasks = new Map<string, LeapTask>();
  private notes = new Map<string, LeapNote[]>();
  private types: LeapMatterType[] = [
    { id: 'mt-conv-purchase-fh', name: 'Purchase — Freehold', areaOfLaw: 'Conveyancing' },
    { id: 'mt-conv-purchase-lh', name: 'Purchase — Leasehold', areaOfLaw: 'Conveyancing' },
    { id: 'mt-conv-sale-fh', name: 'Sale — Freehold', areaOfLaw: 'Conveyancing' },
    { id: 'mt-wills', name: 'Will', areaOfLaw: 'Wills & Probate' },
  ];
  private seq = 0;
  webhooks: Array<{ id: string; url: string; events: string[] }> = [];
  readonly firmInfo: LeapFirm;

  constructor(private opts: MockLeapOptions = {}) {
    this.firmInfo = { id: 'firm-demo', name: 'Demo Conveyancing LLP', region: 'uk', ...opts.firm };
  }

  private id(prefix: string) {
    return `${this.opts.idPrefix ? `${this.opts.idPrefix}-` : ''}${prefix}-${String(++this.seq).padStart(4, '0')}`;
  }
  private nowIso() {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }
  private emit(type: string, matterId: string | null, extra: { documentId?: string | null; cardId?: string | null; taskId?: string | null } = {}) {
    this.opts.onEvent?.({ type, matterId, ...extra });
  }

  // ───────────── seed helpers ─────────────

  seedMatter(input: { number: string; description: string; matterTypeId?: string; propertyAddress?: string | null; responsible?: { id: string; name: string; email: string | null } | null; exchangeDate?: string | null; completionDate?: string | null; purchasePrice?: string | null; status?: LeapMatter['status'] }): LeapMatter {
    const id = this.id('m');
    const m: LeapMatter = {
      id,
      number: input.number,
      description: input.description,
      status: input.status ?? 'open',
      matterType: this.types.find((t) => t.id === (input.matterTypeId ?? 'mt-conv-purchase-fh')) ?? null,
      responsibleStaff: input.responsible ?? null,
      propertyAddress: input.propertyAddress ?? null,
      exchangeDate: input.exchangeDate ?? null,
      completionDate: input.completionDate ?? null,
      purchasePrice: input.purchasePrice ?? null,
      fields: {},
      createdAt: this.nowIso(),
      updatedAt: this.nowIso(),
    };
    this.matters.set(id, m);
    this.parties.set(id, []);
    this.notes.set(id, []);
    this.emit('MatterCreated', id);
    return m;
  }

  updateMatter(id: string, patch: Partial<LeapMatter>): LeapMatter {
    const m = this.matters.get(id);
    if (!m) throw new LeapError('no such matter', 404);
    Object.assign(m, patch, { updatedAt: this.nowIso() });
    this.emit(m.status === 'closed' ? 'MatterClosed' : 'MatterUpdated', id);
    return m;
  }

  seedCard(input: Partial<LeapCard> & { name: string }): LeapCard {
    const c: LeapCard = { id: this.id('c'), type: input.type ?? (input.organisation ? 'company' : 'person'), firstName: input.firstName ?? null, lastName: input.lastName ?? null, email: input.email?.toLowerCase() ?? null, phone: input.phone ?? null, organisation: input.organisation ?? null, name: input.name };
    this.cards.set(c.id, c);
    return c;
  }

  addParty(matterId: string, card: LeapCard, rawRole: string, role?: LeapPartyRole): void {
    const list = this.parties.get(matterId);
    if (!list) throw new LeapError('no such matter', 404);
    list.push({ card, rawRole, role: role ?? (rawRole.toLowerCase() as LeapPartyRole) });
    this.emit('MatterUpdated', matterId, { cardId: card.id });
  }

  seedDocument(matterId: string, input: { name: string; bytes: Buffer; mimeType?: string | null; folder?: string | null; category?: string | null; createdBy?: string | null }): LeapDocument {
    if (!this.matters.has(matterId)) throw new LeapError('no such matter', 404);
    const ext = input.name.includes('.') ? input.name.split('.').pop()!.toLowerCase() : null;
    const d: LeapDocument & { bytes: Buffer } = { id: this.id('d'), matterId, name: input.name, extension: ext, mimeType: input.mimeType ?? (ext === 'pdf' ? 'application/pdf' : 'application/octet-stream'), sizeBytes: input.bytes.length, folder: input.folder ?? null, category: input.category ?? null, createdAt: this.nowIso(), updatedAt: this.nowIso(), createdBy: input.createdBy ?? null, bytes: input.bytes };
    this.documents.set(d.id, d);
    this.emit('DocumentCreated', matterId, { documentId: d.id });
    return d;
  }

  // ───────────── LeapApi ─────────────

  async firm(): Promise<LeapFirm> {
    return this.firmInfo;
  }
  async matterTypes(): Promise<LeapMatterType[]> {
    return [...this.types];
  }
  async listMatters(opts: LeapListOptions = {}): Promise<LeapPage<LeapMatter>> {
    const all = [...this.matters.values()].filter((m) => m.status === 'open' && (!opts.updatedSince || (m.updatedAt ?? '') > opts.updatedSince)).sort((a, b) => a.id.localeCompare(b.id));
    return pageOf(all, opts);
  }
  async getMatter(id: string): Promise<LeapMatter | null> {
    return this.matters.get(id) ?? null;
  }
  async matterParties(matterId: string): Promise<LeapMatterParty[]> {
    return [...(this.parties.get(matterId) ?? [])];
  }
  async getCard(id: string): Promise<LeapCard | null> {
    return this.cards.get(id) ?? null;
  }
  async listDocuments(matterId: string, opts: LeapListOptions = {}): Promise<LeapPage<LeapDocument>> {
    const all = [...this.documents.values()].filter((d) => d.matterId === matterId && (!opts.updatedSince || (d.updatedAt ?? '') > opts.updatedSince)).map(({ bytes: _b, ...d }) => d);
    return pageOf(all, opts);
  }
  async getDocument(id: string): Promise<LeapDocument | null> {
    const d = this.documents.get(id);
    if (!d) return null;
    const { bytes: _b, ...rest } = d;
    return rest;
  }
  async downloadDocument(id: string) {
    const d = this.documents.get(id);
    if (!d) throw new LeapError('Document not found in LEAP.', 404, false);
    return { bytes: d.bytes, mimeType: d.mimeType, fileName: d.name };
  }
  async uploadDocument(matterId: string, input: { fileName: string; mimeType: string; bytes: Buffer; folder?: string | null; category?: string | null }): Promise<LeapDocument> {
    return this.seedDocument(matterId, { name: input.fileName, bytes: input.bytes, mimeType: input.mimeType, folder: input.folder, category: input.category, createdBy: 'conveyi' });
  }
  async listTasks(matterId: string): Promise<LeapTask[]> {
    return [...this.tasks.values()].filter((t) => t.matterId === matterId);
  }
  async createTask(matterId: string, input: { title: string; description?: string | null; dueDate?: string | null; assigneeStaffId?: string | null; externalRef?: string | null }): Promise<LeapTask> {
    if (!this.matters.has(matterId)) throw new LeapError('no such matter', 404);
    const t: LeapTask = { id: this.id('t'), matterId, title: input.title, description: input.description ?? null, dueDate: input.dueDate ?? null, completed: false, assigneeStaffId: input.assigneeStaffId ?? null, externalRef: input.externalRef ?? null };
    this.tasks.set(t.id, t);
    this.emit('TaskCreated', matterId, { taskId: t.id });
    return t;
  }
  async completeTask(taskId: string): Promise<LeapTask> {
    const t = this.tasks.get(taskId);
    if (!t) throw new LeapError('no such task', 404);
    t.completed = true;
    this.emit('TaskUpdated', t.matterId, { taskId });
    return t;
  }
  async addNote(matterId: string, body: string): Promise<LeapNote> {
    const list = this.notes.get(matterId);
    if (!list) throw new LeapError('no such matter', 404);
    const n: LeapNote = { id: this.id('n'), matterId, body, createdAt: this.nowIso(), createdBy: 'conveyi' };
    list.push(n);
    return n;
  }
  async listNotes(matterId: string): Promise<LeapNote[]> {
    return [...(this.notes.get(matterId) ?? [])];
  }
  async subscribeWebhook(url: string, events: string[]): Promise<{ id: string }> {
    const existing = this.webhooks.find((w) => w.url === url);
    if (existing) {
      existing.events = events;
      return { id: existing.id };
    }
    const w = { id: this.id('wh'), url, events };
    this.webhooks.push(w);
    return { id: w.id };
  }

  /** Test helper: everything about a matter, raw. */
  dump(matterId: string) {
    return { matter: this.matters.get(matterId) ?? null, parties: this.parties.get(matterId) ?? [], documents: [...this.documents.values()].filter((d) => d.matterId === matterId).map(({ bytes: _b, ...d }) => d), tasks: [...this.tasks.values()].filter((t) => t.matterId === matterId), notes: this.notes.get(matterId) ?? [] };
  }
}

function pageOf<T>(all: T[], opts: LeapListOptions): LeapPage<T> {
  const limit = opts.limit ?? 100;
  const offset = Number(opts.cursor ?? 0);
  const items = all.slice(offset, offset + limit);
  return { items, next: offset + items.length < all.length ? String(offset + items.length) : null };
}

// ───────────────────────────── HTTP mock ─────────────────────────────

export interface MockLeapServerOptions {
  idPrefix?: string | null;
  clientId?: string;
  clientSecret?: string;
  apiKey?: string | null;
  webhookSecret?: string;
  /** Simulate flakiness: fail the first N API calls with 503 (tests the client's retry). */
  failFirst?: number;
  log?: (msg: string) => void;
}

/**
 * Serves the endpoint map over HTTP around a MockLeap. OAuth: /oauth/authorize redirects
 * straight back with a code (no login screen); /oauth/token issues short-lived access
 * tokens + a refresh token. Webhook deliveries are POSTed to every subscribed URL with
 * the assumed signature header.
 */
export class MockLeapServer {
  readonly leap: MockLeap;
  private server: http.Server | null = null;
  private codes = new Map<string, string>();
  private access = new Map<string, number>();
  private refresh = new Set<string>();
  private failures = 0;
  port = 0;
  deliveries: Array<{ url: string; status: number | null; body: unknown }> = [];

  constructor(private opts: MockLeapServerOptions = {}, leap?: MockLeap) {
    this.leap = leap ?? new MockLeap({ idPrefix: opts.idPrefix ?? null, onEvent: (e) => void this.deliver(e) });
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port = 0): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(port, '127.0.0.1', () => r()));
    this.port = (this.server.address() as { port: number }).port;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  /** Push a webhook to every subscriber (the mock's "LEAP notifies you"). */
  async deliver(e: { type: string; matterId: string | null; documentId?: string | null; cardId?: string | null; taskId?: string | null }): Promise<void> {
    const body = JSON.stringify({ id: crypto.randomUUID(), eventType: e.type, firmId: this.leap.firmInfo.id, occurredAt: new Date().toISOString(), data: { matterId: e.matterId, documentId: e.documentId ?? undefined, cardId: e.cardId ?? undefined, taskId: e.taskId ?? undefined } });
    for (const w of this.leap.webhooks) {
      const headers: Record<string, string> = { 'content-type': 'application/json', [LEAP_WEBHOOK_DELIVERY_HEADER]: crypto.randomUUID() };
      if (this.opts.webhookSecret) headers[LEAP_WEBHOOK_SIGNATURE_HEADER] = crypto.createHmac('sha256', this.opts.webhookSecret).update(body).digest('hex');
      try {
        const r = await fetch(w.url, { method: 'POST', headers, body });
        this.deliveries.push({ url: w.url, status: r.status, body: JSON.parse(body) });
      } catch {
        this.deliveries.push({ url: w.url, status: null, body: JSON.parse(body) });
      }
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.baseUrl);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    this.opts.log?.(`${req.method} ${url.pathname}`);
    try {
      // ── mock-only inspection / control (no auth; never exists on the real API) ──
      if (url.pathname.startsWith('/__mock/')) {
        const L = this.leap;
        const all = (await L.listMatters({ limit: 10_000 })).items;
        if (url.pathname === '/__mock/matters' && req.method === 'GET') return json(200, all.map((m) => ({ ...L.dump(m.id) })));
        const mm = url.pathname.match(/^\/__mock\/matters\/([^/]+)$/);
        if (mm && req.method === 'GET') {
          const target = all.find((m) => m.number === decodeURIComponent(mm[1])) ?? (await L.getMatter(decodeURIComponent(mm[1])));
          return target ? json(200, L.dump(target.id)) : json(404, { error: 'not found' });
        }
        if (mm && req.method === 'POST') {
          const target = all.find((m) => m.number === decodeURIComponent(mm[1]));
          if (!target) return json(404, { error: 'not found' });
          const b = JSON.parse(raw.toString('utf8')) as { name: string; folder?: string; lines?: string[]; close?: boolean };
          if (b.close) return json(200, L.updateMatter(target.id, { status: 'closed' }));
          const { textPdf } = await import('../../engine/text-pdf');
          const d = L.seedDocument(target.id, { name: b.name, folder: b.folder ?? null, bytes: textPdf(b.lines ?? [b.name]) });
          return json(201, d);
        }
        if (url.pathname === '/__mock/deliveries') return json(200, this.deliveries.slice(-50));
        return json(404, { error: 'no such mock route' });
      }
      // ── OAuth ──
      if (url.pathname === LEAP_ENDPOINTS.authorize) {
        const code = crypto.randomBytes(12).toString('hex');
        this.codes.set(code, url.searchParams.get('code_challenge') ?? '');
        const back = new URL(url.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        res.writeHead(302, { location: back.toString() });
        res.end();
        return;
      }
      if (url.pathname === LEAP_ENDPOINTS.token) {
        const p = new URLSearchParams(raw.toString('utf8'));
        if (this.opts.clientId && p.get('client_id') !== this.opts.clientId) return json(401, { error: 'invalid_client' });
        if (this.opts.clientSecret && p.get('client_secret') !== this.opts.clientSecret) return json(401, { error: 'invalid_client' });
        if (p.get('grant_type') === 'authorization_code') {
          const challenge = this.codes.get(p.get('code') ?? '');
          if (challenge === undefined) return json(400, { error: 'invalid_grant' });
          if (challenge && crypto.createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') !== challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verifier mismatch' });
          this.codes.delete(p.get('code')!);
        } else if (p.get('grant_type') === 'refresh_token') {
          if (!this.refresh.has(p.get('refresh_token') ?? '')) return json(400, { error: 'invalid_grant' });
        } else return json(400, { error: 'unsupported_grant_type' });
        const access = crypto.randomBytes(16).toString('hex');
        const refresh = crypto.randomBytes(16).toString('hex');
        this.access.set(access, Date.now() + 3600_000);
        this.refresh.add(refresh);
        return json(200, { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: 'Bearer', scope: 'matters:read documents:read documents:write tasks:write notes:write' });
      }
      // ── API auth ──
      const auth = req.headers.authorization ?? '';
      const token = auth.replace(/^Bearer /, '');
      const exp = this.access.get(token);
      if (!exp || exp < Date.now()) return json(401, { error: 'unauthorized' });
      if (this.opts.apiKey && req.headers['x-api-key'] !== this.opts.apiKey) return json(403, { error: 'missing api key' });
      if (this.opts.failFirst && this.failures < this.opts.failFirst) {
        this.failures += 1;
        return json(503, { error: 'try again' });
      }
      const L = this.leap;
      const path = url.pathname;
      const q = url.searchParams;
      const listOpts = { limit: q.get('limit') ? Number(q.get('limit')) : undefined, cursor: q.get('offset') ?? q.get('cursor'), updatedSince: q.get('updatedSince') };
      const paged = <T>(p: LeapPage<T>) => ({ items: p.items, next: p.next, total: undefined });
      let m: RegExpMatchArray | null;
      if (req.method === 'GET' && path === LEAP_ENDPOINTS.firm) return json(200, await L.firm());
      if (req.method === 'GET' && path === LEAP_ENDPOINTS.matterTypes) return json(200, { items: await L.matterTypes() });
      if (req.method === 'GET' && path === LEAP_ENDPOINTS.matters) return json(200, paged(await L.listMatters(listOpts)));
      if ((m = path.match(/^\/api\/v1\/matters\/([^/]+)$/)) && req.method === 'GET') {
        const x = await L.getMatter(decodeURIComponent(m[1]));
        return x ? json(200, x) : json(404, { error: 'not found' });
      }
      if ((m = path.match(/^\/api\/v1\/matters\/([^/]+)\/cards$/)) && req.method === 'GET') return json(200, { items: (await L.matterParties(decodeURIComponent(m[1]))).map((p) => ({ role: p.rawRole, card: p.card })) });
      if ((m = path.match(/^\/api\/v1\/matters\/([^/]+)\/documents$/)) && req.method === 'GET') return json(200, paged(await L.listDocuments(decodeURIComponent(m[1]), listOpts)));
      if ((m = path.match(/^\/api\/v1\/matters\/([^/]+)\/documents$/)) && req.method === 'POST') {
        const { fields, file } = parseMultipart(raw, req.headers['content-type'] ?? '');
        if (!file) return json(400, { error: 'file missing' });
        const d = await L.uploadDocument(decodeURIComponent(m[1]), { fileName: fields.name ?? file.filename, mimeType: file.mimeType, bytes: file.bytes, folder: fields.folder ?? null, category: fields.category ?? null });
        return json(201, d);
      }
      if ((m = path.match(/^\/api\/v1\/matters\/([^/]+)\/tasks$/)) && req.method === 'GET') return json(200, { items: await L.listTasks(decodeURIComponent(m[1])) });
      if ((m = path.match(/^\/api\/v1\/matters\/([^/]+)\/tasks$/)) && req.method === 'POST') {
        const b = JSON.parse(raw.toString('utf8'));
        return json(201, await L.createTask(decodeURIComponent(m[1]), { title: b.title, description: b.description, dueDate: b.dueDate, assigneeStaffId: b.assigneeId, externalRef: b.externalRef }));
      }
      if ((m = path.match(/^\/api\/v1\/matters\/([^/]+)\/notes$/)) && req.method === 'GET') return json(200, { items: await L.listNotes(decodeURIComponent(m[1])) });
      if ((m = path.match(/^\/api\/v1\/matters\/([^/]+)\/notes$/)) && req.method === 'POST') return json(201, await L.addNote(decodeURIComponent(m[1]), JSON.parse(raw.toString('utf8')).body));
      if ((m = path.match(/^\/api\/v1\/cards\/([^/]+)$/)) && req.method === 'GET') {
        const x = await L.getCard(decodeURIComponent(m[1]));
        return x ? json(200, x) : json(404, { error: 'not found' });
      }
      if ((m = path.match(/^\/api\/v1\/documents\/([^/]+)\/download$/)) && req.method === 'GET') {
        try {
          const d = await L.downloadDocument(decodeURIComponent(m[1]));
          res.writeHead(200, { 'content-type': d.mimeType ?? 'application/octet-stream', 'content-disposition': `attachment; filename="${d.fileName}"` });
          res.end(d.bytes);
        } catch {
          json(404, { error: 'not found' });
        }
        return;
      }
      if ((m = path.match(/^\/api\/v1\/documents\/([^/]+)$/)) && req.method === 'GET') {
        const x = await L.getDocument(decodeURIComponent(m[1]));
        return x ? json(200, x) : json(404, { error: 'not found' });
      }
      if ((m = path.match(/^\/api\/v1\/tasks\/([^/]+)$/)) && req.method === 'PATCH') return json(200, await L.completeTask(decodeURIComponent(m[1])));
      if (path === LEAP_ENDPOINTS.webhooks && req.method === 'POST') {
        const b = JSON.parse(raw.toString('utf8'));
        return json(201, await L.subscribeWebhook(b.url, b.events ?? []));
      }
      json(404, { error: `no route ${req.method} ${path}` });
    } catch (err) {
      json(err instanceof LeapError ? err.status || 500 : 500, { error: (err as Error).message });
    }
  }
}

/** Minimal multipart/form-data parser (one file + text fields) for the mock upload route. */
export function parseMultipart(raw: Buffer, contentType: string): { fields: Record<string, string>; file: { filename: string; mimeType: string; bytes: Buffer } | null } {
  const m = contentType.match(/boundary=("?)([^";]+)\1/);
  const fields: Record<string, string> = {};
  let file: { filename: string; mimeType: string; bytes: Buffer } | null = null;
  if (!m) return { fields, file };
  const boundary = Buffer.from(`--${m[2]}`);
  let pos = raw.indexOf(boundary);
  while (pos >= 0) {
    const start = pos + boundary.length;
    if (raw.slice(start, start + 2).toString() === '--') break;
    const next = raw.indexOf(boundary, start);
    const part = raw.slice(start + 2, next - 2); // strip leading CRLF and trailing CRLF
    const sep = part.indexOf('\r\n\r\n');
    const head = part.slice(0, sep).toString('utf8');
    const body = part.slice(sep + 4);
    const name = head.match(/name="([^"]+)"/)?.[1] ?? '';
    const filename = head.match(/filename="([^"]*)"/)?.[1];
    if (filename !== undefined) file = { filename, mimeType: head.match(/Content-Type: ([^\r\n]+)/i)?.[1] ?? 'application/octet-stream', bytes: Buffer.from(body) };
    else fields[name] = body.toString('utf8');
    pos = next;
  }
  return { fields, file };
}
