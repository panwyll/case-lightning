import { NextRequest, NextResponse } from 'next/server';
import { devDocuments, devReset, devRun, devUpload, devView, devWork } from '@/lib/server/dev-harness';
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
  if (/^matters\/[^/]+\/engine$/.test(p)) return NextResponse.json(await devView());
  if (p.startsWith('decisions')) return NextResponse.json({ decisions: [] });
  return NextResponse.json({});
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if (process.env.NODE_ENV === 'production') return gone();
  const p = (await params).path.join('/');
  const body = await req.json().catch(() => ({}));
  try {
    if (p === 'reset') { devReset(); return NextResponse.json({ ok: true }); }
    if (/^matters\/[^/]+\/engine\/upload$/.test(p)) { await wait(1500); return NextResponse.json(await devUpload(body.fileName, body.role ?? 'auto')); }
    if (/^matters\/[^/]+\/engine$/.test(p)) { await wait(800); return NextResponse.json(await devRun(body)); }
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: (e as { status?: number }).status ?? 400 });
  }
}
