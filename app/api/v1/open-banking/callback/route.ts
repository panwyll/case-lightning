import { NextRequest, NextResponse } from 'next/server';
import { runAsSystem, queryOne } from '@/lib/server/db';
import { openBanking, HISTORY_DAYS } from '@/lib/server/open-banking';
import { finishConnection, getConnection, saveAccountDocument } from '@/lib/server/open-banking/store';
import { callbackUrl, readState } from '@/lib/server/open-banking/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Where every bank sends the client back (the one URL registered with the provider). The signed state
 * names our connection; the accounts shared are read and each becomes a document on the case tagged to
 * the form. The client goes on to /pof/return, whose browser knows which form they came from.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const id = readState(sp.get('state'));
  const done = (q: Record<string, string>) => NextResponse.redirect(new URL(`/pof/return?${new URLSearchParams(q).toString()}`, req.nextUrl.origin));
  if (!id) return done({ s: 'fail', m: 'This bank connection is not valid.' });
  if (sp.get('error')) {
    await runAsSystem(() => finishConnection(id, 'failed', [], `The bank connection was cancelled (${sp.get('error')}).`)).catch(() => {});
    return done({ c: id, s: 'fail', m: 'The bank connection was cancelled. You can try again, or upload statements instead.' });
  }
  try {
    const result = await runAsSystem(async () => {
      const c = await getConnection(id);
      if (!c || !c.provider_ref) return { ok: false as const, reason: 'This bank connection is not valid any more.' };
      if (c.status === 'linked') return { ok: true as const };
      const open = await queryOne<{ ok: boolean }>(`select (status = 'requested' and expires_at > now()) as ok from proof_of_funds_request where id = $1`, [c.request_id]);
      if (!open?.ok) return { ok: false as const, reason: 'This form has already been submitted or has expired.' };
      const provider = openBanking();
      if (!provider) return { ok: false as const, reason: 'Connecting a bank is not available.' };
      const got = await provider.collect(c.provider_ref, { id: c.institution_id, name: c.institution_name }, { code: sp.get('code'), callbackUrl: callbackUrl(), historyDays: HISTORY_DAYS });
      if (got.status !== 'linked' || !got.accounts.length) {
        await finishConnection(c.id, got.status === 'expired' ? 'expired' : 'failed', [], got.reason ?? 'The bank did not share any accounts.');
        return { ok: false as const, reason: got.reason ?? 'The bank did not share any accounts.' };
      }
      const docs: string[] = [];
      for (const a of got.accounts) docs.push(await saveAccountDocument(c, a, provider.name));
      await finishConnection(c.id, 'linked', docs);
      return { ok: true as const };
    });
    return result.ok ? done({ c: id, s: 'ok' }) : done({ c: id, s: 'fail', m: result.reason });
  } catch (err) {
    await runAsSystem(() => finishConnection(id, 'failed', [], err instanceof Error ? err.message : 'failed')).catch(() => {});
    return done({ c: id, s: 'fail', m: 'The bank connection did not complete. You can try again, or upload statements instead.' });
  }
}
