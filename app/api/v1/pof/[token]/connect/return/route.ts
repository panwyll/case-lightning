import { NextRequest, NextResponse } from 'next/server';
import { runAsSystem } from '@/lib/server/db';
import { openRequestByToken } from '@/lib/server/engine/pof-store';
import { openBanking } from '@/lib/server/open-banking';
import { finishConnection, getConnection, saveAccountDocument } from '@/lib/server/open-banking/store';
import { paths } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The bank sends the client back here. The accounts they shared are fetched (transactions, balance,
 * holder) and each becomes a document on the case tagged to the form; the client lands back on the form
 * with the account attached to the source it was for.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const id = req.nextUrl.searchParams.get('c') ?? '';
  const back = (q: string) => NextResponse.redirect(new URL(`${paths.proofOfFunds(token)}?${q}`, req.nextUrl.origin));
  try {
    const result = await runAsSystem(async () => {
      const pof = await openRequestByToken(token);
      const c = /^[0-9a-f-]{36}$/i.test(id) ? await getConnection(id) : null;
      if (!pof || pof.status !== 'requested' || !c || c.request_id !== pof.id || !c.provider_ref) return { ok: false as const, reason: 'This bank connection is not valid any more.' };
      if (c.status === 'linked') return { ok: true as const };
      const provider = openBanking();
      if (!provider) return { ok: false as const, reason: 'Connecting a bank is not available.' };
      const got = await provider.collect(c.provider_ref, { id: c.institution_id, name: c.institution_name });
      if (got.status !== 'linked' || !got.accounts.length) {
        await finishConnection(c.id, got.status === 'expired' ? 'expired' : 'failed', [], got.reason ?? 'The bank did not share any accounts.');
        return { ok: false as const, reason: got.reason ?? 'The bank did not share any accounts.' };
      }
      const docs: string[] = [];
      for (const a of got.accounts) docs.push(await saveAccountDocument(c, a, provider.name));
      await finishConnection(c.id, 'linked', docs);
      return { ok: true as const };
    });
    return result.ok ? back(`connected=${encodeURIComponent(id)}`) : back(`connectFailed=${encodeURIComponent(result.reason)}`);
  } catch (err) {
    return back(`connectFailed=${encodeURIComponent(err instanceof Error ? err.message : 'The bank connection did not complete.')}`);
  }
}
