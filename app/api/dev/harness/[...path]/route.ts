import { NextRequest, NextResponse } from 'next/server';
import { devDecision, devDocuments, devEmailTask, devEmailThread, devOpenSource, devReset, devResolve, devRun, devUpload, devView, devWork } from '@/lib/server/dev-harness';
import { machineSpec } from '@/lib/server/engine/spec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Local development only (see lib/server/dev-harness.ts): the /api/v1 calls the /dev/harness page makes. */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gone = () => new NextResponse('Not found', { status: 404 });

export async function GET(_req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if (process.env.NODE_ENV === 'production') return gone();
  const p = (await params).path.join('/');
  if (p.startsWith('engine/my-work')) return NextResponse.json(await devWork());
  if (p.startsWith('tasks/dismissed')) return NextResponse.json({ dismissed: [] });
  if (p === 'engine/spec') return NextResponse.json(machineSpec());
  if (/^matters\/[^/]+\/engine\/events/.test(p)) return NextResponse.json({ events: [] });
  if (/^matters\/[^/]+\/engine\/documents/.test(p)) return NextResponse.json(await devDocuments());
  if (/^matters\/[^/]+\/emails\/thread$/.test(p)) { await wait(500); return NextResponse.json(devEmailThread()); }
  if (/^matters\/[^/]+\/engine$/.test(p)) return NextResponse.json(await devView());
  if (p === 'dev/email-task') return NextResponse.json({ eventId: await devEmailTask() });
  if (/^decisions\/[A-Za-z0-9-]{3,40}$/.test(p)) { const d = await devDecision(p.split('/')[1]); return d ? NextResponse.json(d) : NextResponse.json({ error: 'Decision not found.' }, { status: 404 }); }
  if (p.startsWith('decisions')) return NextResponse.json({ decisions: [] });
  if (p === 'admin/templates') {
    const { messageInfo } = await import('@/lib/server/engine/messages');
    const { CLIENT_UPDATES, CHASES } = await import('@/lib/server/comms/templates');
    const pick = { ...CLIENT_UPDATES, ...CHASES } as Record<string, { subject: string; body: string }>;
    const names = ['searches_ordered', 'chase_contract_pack', 'deposit_request'];
    return NextResponse.json({ engine: messageInfo(), docTemplates: [{ id: 'd1', name: 'Client care letter', step: 'Instruction, once the case is enrolled' }, { id: 'd2', name: 'Completion statement', step: 'Completion, after exchange' }, { id: 'd3', name: 'Deposit request letter', step: 'Contract & Exchange, once the contract is approved' }, { id: 'd4', name: 'Report on title', step: 'Title, once resolved' }, { id: 'd5', name: 'Our welcome pack', step: null }], templates: [...names.map((n, i) => ({ id: `t${i}`, name: n, category: 'Engine', subjectTemplate: pick[n]?.subject ?? '', bodyTemplate: pick[n]?.body ?? '', styleTag: 'NEUTRAL', attachDocTemplateIds: i === 2 ? ['d1'] : [] })), { id: 'tf', name: 'Welcome letter', category: 'General', subjectTemplate: 'Welcome', bodyTemplate: 'Dear {{buyer_names}},', styleTag: 'NEUTRAL', attachDocTemplateIds: [] }] });
  }
  if (/^admin\/doc-templates\/[^/]+\/cases$/.test(p)) {
    return NextResponse.json({ cases: Array.from({ length: 14 }, (_, i) => ({ matterId: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`, matterRef: `DEV-${String(i + 1).padStart(3, '0')}`, propertyAddress: `${i + 2} Oak Street, Leeds LS1 2AB`, ready: i % 3 !== 2, reason: i % 3 === 2 ? 'Contract not approved yet' : null, previous: null })) });
  }
  if (p === 'admin/doc-templates') {
    const { EXAMPLE_TEMPLATES, DOC_USAGE } = await import('@/lib/server/doc-templates');
    return NextResponse.json({ templates: [...EXAMPLE_TEMPLATES.map((t, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: t.name, description: t.description, file_name: t.fileName, file_size_bytes: 14_000, has_llm_prompts: t.hasLlmPrompts, usage: DOC_USAGE[t.name] ?? null })), { id: '00000000-0000-4000-8000-999999999999', name: 'Our welcome pack', description: null, file_name: 'welcome.docx', file_size_bytes: 9_000, has_llm_prompts: false, usage: null }] });
  }
  return NextResponse.json({});
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if (process.env.NODE_ENV === 'production') return gone();
  const p = (await params).path.join('/');
  const body = await req.json().catch(() => ({}));
  try {
    if (p === 'reset') { devReset(); return NextResponse.json({ ok: true }); }
    if (/^decisions\/[A-Za-z0-9-]{3,40}\/open-source$/.test(p)) return NextResponse.json(await devOpenSource(p.split('/')[1]));
    if (/^decisions\/[A-Za-z0-9-]{3,40}\/resolve$/.test(p)) { await wait(700); return NextResponse.json(await devResolve(p.split('/')[1], body)); }
    if (/^matters\/[^/]+\/engine\/upload$/.test(p)) { await wait(1500); return NextResponse.json(await devUpload(body.fileName, body.role ?? 'auto')); }
    if (/^matters\/[^/]+\/engine$/.test(p)) { await wait(800); return NextResponse.json(await devRun(body)); }
    if (/^admin\/doc-templates\/[^/]+\/generate$/.test(p)) {
      const { EXAMPLE_TEMPLATES, createMinimalDocx, fillTemplate } = await import('@/lib/server/doc-templates');
      const { docxHtml, docxText } = await import('@/lib/server/doc-generate');
      const i = Number(p.split('/')[2].slice(-12));
      const t = EXAMPLE_TEMPLATES[i] ?? EXAMPLE_TEMPLATES[0];
      const buf = await fillTemplate(createMinimalDocx(t.paragraphs), { vars: { matter_ref: 'SMI-OAK', property_address: '14 Oak Street, Leeds LS1 2AB', buyer_names: 'Mr & Mrs Smith', seller_names: 'Ms Jones', firm_name: 'Your Firm LLP', today: '29 September 2026', assigned_to: 'Alex Carter', lender: 'Santander', completion_date: '2 August 2026', exchange_date: '19 July 2026' }, isPremium: false, userId: 'dev', tenantId: 'dev' });
      await wait(400);
      return NextResponse.json({ preview: docxText(buf), html: await docxHtml(buf), fileName: t.fileName, previous: null, sample: !body.matterId });
    }
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: (e as { status?: number }).status ?? 400 });
  }
}
