import { NextRequest, NextResponse } from 'next/server';
import { config } from '@/lib/server/config';
import { overview, firms, firm, billing, usage, errors } from '@/lib/server/internal-console';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The owner's console, a page at a time (?page=overview|firms|firm|billing|usage|errors). Gated by INTERNAL_DASHBOARD_KEY. */
export async function GET(req: NextRequest) {
  const key = config.internalDashboardKey;
  const got = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!key || !got || got !== key) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const days = Math.max(1, Math.min(365, Number(sp.get('days')) || 30));
  const uuid = (v: string | null) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
  try {
    switch (sp.get('page')) {
      case 'overview': return NextResponse.json(await overview());
      case 'firms': return NextResponse.json({ firms: await firms() });
      case 'firm': { const id = uuid(sp.get('id')); if (!id) return NextResponse.json({ error: 'Which firm?' }, { status: 400 }); return NextResponse.json(await firm(id)); }
      case 'billing': return NextResponse.json(await billing());
      case 'usage': return NextResponse.json(await usage(days));
      case 'errors': return NextResponse.json(await errors(days, sp.get('source') || null, uuid(sp.get('firm'))));
      default: return NextResponse.json({ error: 'Unknown page' }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
