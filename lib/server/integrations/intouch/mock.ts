/**
 * An in-memory InTouch that serves exactly the endpoint map in endpoints.ts.
 *
 * This is not a convenience: it is how the connector is exercised end to end while the
 * real reference is inside the firm's InTouch account. The tests drive the SAME HTTP
 * client against this transport, so the API-key header, retries, pagination and the
 * mapping seam are all real. When the reference opens, the same tests re-run against
 * InTouch and any disagreement shows up as a mapping fix, not a rewrite.
 */
import { INTOUCH_API_TOKEN_HEADER, INTOUCH_ENDPOINTS } from './endpoints';
import type { HttpResponse, HttpTransport } from './client';

export interface MockCaseSeed {
  id?: string;
  reference?: string;
  status?: string;
  type?: string;
  tenure?: string;
  propertyAddress?: string;
  postcode?: string;
  price?: string | number;
  feeEarner?: { id?: string; name?: string; email?: string };
  firmReference?: string;
  parties?: Array<Record<string, unknown>>;
  identityChecks?: Array<Record<string, unknown>>;
  forms?: Array<Record<string, unknown>>;
  documents?: Array<Record<string, unknown>>;
  updatedAt?: string;
}

interface Stored {
  raw: Record<string, unknown>;
  parties: Array<Record<string, unknown>>;
  identityChecks: Array<Record<string, unknown>>;
  forms: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
  milestones: Array<Record<string, unknown>>;
  notes?: Array<{ text: string }>;
}

const json = (status: number, body: unknown): HttpResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  text: async () => JSON.stringify(body),
  arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
});

export class MockInTouch {
  readonly cases = new Map<string, Stored>();
  readonly bytes = new Map<string, Buffer>();
  /** Every request the client made — tests assert on paths, not on internals. */
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  /** Flip to make the next N requests fail, to exercise retry and backoff. */
  failNext = 0;
  failStatus = 500;
  private seq = 0;

  /** `apiToken`: the only key this InTouch accepts in `x-intouch-o-token`. */
  constructor(private opts: { apiToken?: string } = {}) {}

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(4, '0')}`;
  }

  seed(seed: MockCaseSeed = {}): string {
    const id = seed.id ?? this.id('case');
    const raw: Record<string, unknown> = {
      id,
      reference: seed.reference ?? `IT-${id.toUpperCase()}`,
      status: seed.status ?? 'active',
      type: seed.type ?? 'purchase',
      tenure: seed.tenure ?? 'freehold',
      propertyAddress: seed.propertyAddress ?? '12 Example Street, Reading',
      postcode: seed.postcode ?? 'RG1 1AA',
      price: seed.price ?? '£425,000',
      feeEarner: seed.feeEarner ?? { id: 'staff-1', name: 'Alice Okafor', email: 'alice@demo-conveyancing.co.uk' },
      firmReference: seed.firmReference ?? null,
      createdAt: '2026-09-01T09:00:00.000Z',
      updatedAt: seed.updatedAt ?? '2026-09-20T09:00:00.000Z',
    };
    this.cases.set(id, {
      raw,
      parties: seed.parties ?? [{ id: this.id('party'), role: 'client', firstName: 'Priya', lastName: 'Okafor', email: 'priya@example.com' }],
      identityChecks: seed.identityChecks ?? [],
      forms: seed.forms ?? [],
      documents: seed.documents ?? [],
      milestones: [],
    });
    return id;
  }

  /** Add a completed identity check to a case (as InTouch would after the client finishes). */
  addIdentityCheck(caseId: string, input: { outcome?: string; partyId?: string; partyName?: string; flags?: Array<Record<string, unknown>>; withReport?: boolean } = {}): string {
    const c = this.cases.get(caseId)!;
    const id = this.id('idcheck');
    let documentId: string | null = null;
    if (input.withReport !== false) documentId = this.addDocument(caseId, { fileName: 'Identity report.pdf', category: 'id_report', uploadedBy: 'intouch' });
    c.identityChecks.push({
      id,
      outcome: input.outcome ?? 'clear',
      partyId: input.partyId ?? (c.parties[0]?.id as string | undefined) ?? null,
      partyName: input.partyName ?? 'Priya Okafor',
      provider: 'InTouch Verify',
      completedAt: '2026-09-20T10:00:00.000Z',
      flags: input.flags ?? [],
      documentId,
    });
    return id;
  }

  addForm(caseId: string, input: { code?: string; status?: string; answers?: Record<string, unknown>; withPdf?: boolean } = {}): string {
    const c = this.cases.get(caseId)!;
    const id = this.id('form');
    const code = input.code ?? 'ta6';
    const documentId = input.withPdf === false ? null : this.addDocument(caseId, { fileName: `${code.toUpperCase()} completed.pdf`, category: 'form', uploadedBy: 'client' });
    c.forms.push({ id, code, status: input.status ?? 'completed', completedAt: '2026-09-20T11:00:00.000Z', documentId, answers: input.answers ?? { disputes: 'No', alterations: 'Conservatory 2019, building regs certificate held' } });
    return id;
  }

  addDocument(caseId: string, input: { fileName?: string; category?: string; uploadedBy?: string; content?: string } = {}): string {
    const c = this.cases.get(caseId)!;
    const id = this.id('doc');
    c.documents.push({ id, fileName: input.fileName ?? 'Client upload.pdf', mimeType: 'application/pdf', size: 2048, category: input.category ?? 'client_upload', uploadedBy: input.uploadedBy ?? 'client', createdAt: '2026-09-20T11:05:00.000Z' });
    this.bytes.set(id, Buffer.from(input.content ?? `%PDF-1.4 mock ${id}`));
    return id;
  }

  notesFor(caseId: string): string[] {
    return (this.cases.get(caseId)?.notes ?? []).map((n) => n.text);
  }

  milestonesFor(caseId: string): Array<Record<string, unknown>> {
    return this.cases.get(caseId)?.milestones ?? [];
  }

  /** A webhook body in InTouch's documented envelope (flat keys with literal dots). */
  static webhookBody(event: string, data: Record<string, unknown>, by: { name?: string; email?: string } = {}): string {
    return JSON.stringify({ event, 'triggered.by.name': by.name ?? 'Priya Okafor', 'triggered.by.email': by.email ?? 'priya@example.com', timestamp: '2026-09-20T17:01:23Z', data });
  }

  /** The transport to hand to InTouchHttpClient. */
  transport: HttpTransport = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname;
    const body = init.body ? safeParse(String(init.body)) : undefined;
    this.calls.push({ method: init.method, path, body });

    if (this.failNext > 0) {
      this.failNext -= 1;
      return json(this.failStatus, { error: 'mock failure' });
    }

    // Every request needs the firm's API key.
    if ((init.headers[INTOUCH_API_TOKEN_HEADER] ?? '') !== (this.opts.apiToken ?? 'mock-key')) return json(401, { error: 'unauthorised' });

    if (path === INTOUCH_ENDPOINTS.account) return json(200, { id: 'acct-1', name: 'Demo Conveyancing LLP', reference: 'DEMO' });

    if (path === INTOUCH_ENDPOINTS.cases && init.method === 'GET') {
      const since = u.searchParams.get('updatedSince');
      const limit = Number(u.searchParams.get('limit') ?? 100);
      const offset = Number(u.searchParams.get('cursor') ?? u.searchParams.get('offset') ?? 0);
      const all = [...this.cases.values()].map((c) => c.raw).filter((r) => !since || String(r.updatedAt ?? '') > since);
      const slice = all.slice(offset, offset + limit);
      return json(200, { items: slice, total: all.length });
    }

    // ── per-case resources ──
    const caseMatch = /^\/api\/v1\/cases\/([^/]+)(\/.*)?$/.exec(path);
    if (caseMatch) {
      const id = decodeURIComponent(caseMatch[1]);
      const rest = caseMatch[2] ?? '';
      const c = this.cases.get(id);
      if (!c) return json(404, { error: 'not found' });
      if (rest === '' && init.method === 'GET') return json(200, c.raw);
      if (rest === '/parties') return json(200, { items: c.parties });
      if (rest === '/identity-checks' && init.method === 'GET') return json(200, { items: c.identityChecks });
      if (rest === '/identity-checks' && init.method === 'POST') {
        const newId = this.addIdentityCheck(id, { outcome: 'pending', partyId: (body as { partyId?: string })?.partyId, withReport: false });
        return json(200, { id: newId });
      }
      if (rest === '/forms' && init.method === 'GET') return json(200, { items: c.forms });
      if (rest === '/forms' && init.method === 'POST') {
        const newId = this.addForm(id, { code: (body as { code?: string })?.code, status: 'requested', withPdf: false });
        return json(200, { id: newId });
      }
      if (rest === '/documents' && init.method === 'GET') return json(200, { items: c.documents, total: c.documents.length });
      if (rest === '/documents' && init.method === 'POST') {
        const b = body as { fileName?: string; content?: string; category?: string };
        const newId = this.addDocument(id, { fileName: b?.fileName, category: b?.category ?? 'conveyi', uploadedBy: 'conveyi', content: Buffer.from(b?.content ?? '', 'base64').toString('utf8') });
        return json(201, { id: newId });
      }
      if (rest === '/notes' && init.method === 'POST') {
        (c.notes ??= []).push({ text: String((body as { text?: string })?.text ?? '') });
        return json(201, { ok: true });
      }
      if (rest === '/milestones' && init.method === 'POST') {
        c.milestones.push({ ...(body as Record<string, unknown>), receivedAt: new Date().toISOString() });
        return json(202, { ok: true });
      }
    }

    // ── document / form / check by id ──
    const docDl = /^\/api\/v1\/documents\/([^/]+)\/download$/.exec(path);
    if (docDl) {
      const bytes = this.bytes.get(decodeURIComponent(docDl[1]));
      if (!bytes) return json(404, { error: 'not found' });
      return {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${decodeURIComponent(docDl[1])}.pdf"` },
        text: async () => bytes.toString('utf8'),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      };
    }
    const one = (re: RegExp, get: (c: Stored, id: string) => Record<string, unknown> | undefined) => {
      const m = re.exec(path);
      if (!m) return null;
      const wanted = decodeURIComponent(m[1]);
      for (const [caseId, c] of this.cases) {
        const found = get(c, wanted);
        if (found) return json(200, { ...found, caseId });
      }
      return json(404, { error: 'not found' });
    };
    const doc = one(/^\/api\/v1\/documents\/([^/]+)$/, (c, id) => c.documents.find((d) => d.id === id));
    if (doc) return doc;
    const form = one(/^\/api\/v1\/forms\/([^/]+)$/, (c, id) => c.forms.find((f) => f.id === id));
    if (form) return form;
    const check = one(/^\/api\/v1\/identity-checks\/([^/]+)$/, (c, id) => c.identityChecks.find((x) => x.id === id));
    if (check) return check;

    return json(404, { error: `mock InTouch has no route for ${init.method} ${path}` });
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
