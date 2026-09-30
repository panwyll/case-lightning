import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/server/http';
import { devPofBanks, isDevPof } from '@/lib/server/dev-pof';
import { runAsSystem } from '@/lib/server/db';
import { openRequestByToken } from '@/lib/server/engine/pof-store';
import { openBanking } from '@/lib/server/open-banking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The banks a client can connect from their proof-of-funds form (UK), searched by name. `available: false` when no provider is set up. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    if (isDevPof(token)) return ok(devPofBanks((req.nextUrl.searchParams.get('q') ?? '').trim()));
    const pof = await runAsSystem(() => openRequestByToken(token));
    if (!pof || pof.status !== 'requested') throw Object.assign(new Error('This link is not valid or has already been used.'), { status: 404 });
    const provider = openBanking();
    if (!provider) return ok({ available: false, banks: [] });
    const q = (req.nextUrl.searchParams.get('q') ?? '').trim().toLowerCase();
    const all = await provider.institutions('gb');
    const banks = (q ? all.filter((b) => b.name.toLowerCase().includes(q)) : all).slice(0, 40);
    return ok({ available: true, banks });
  } catch (error) {
    return fail(error);
  }
}
