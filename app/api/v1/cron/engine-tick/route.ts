import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { runAsAutomation } from '@/lib/server/db';
import { readSubmission, unreadSubmissions } from '@/lib/server/engine/pof-store';
import { moveBlobsToStorage } from '@/lib/server/blob-store';
import { recheckLockedDocuments } from '@/lib/server/document-unlock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * The engine's timer sweep (spec 2.6): for every active matter, send the chases that
 * are due and raise the escalations that are due, in working days. Intended for a
 * Vercel Cron (vercel.json); protected by CRON_SECRET like the other cron routes.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('db');
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
      return fail(Object.assign(new Error('Unauthorized'), { status: 401 }));
    }
    const result = await runAsAutomation(() => engine().tickAll(null));
    // Mail held while a firm was suspended, for any firm that has since paid (the payment webhook does it first; this catches a missed one).
    const released = await import('@/lib/server/billing-suspension').then((m) => m.releaseAllHeldMail()).catch(() => 0);
    // Proof-of-funds submissions whose after-response read did not finish.
    let reread = 0;
    for (const id of await unreadSubmissions()) { const r = await readSubmission(id).catch(() => ({ read: false })); if (r.read) reread += 1; }
    // Files still held in the database move to Supabase Storage, a batch a day.
    await moveBlobsToStorage(200).catch((e) => console.warn('[cron] storage move failed', (e as Error).message));
    // Files wrongly flagged as password-protected are cleared and read.
    await recheckLockedDocuments(null, 50).catch((e) => console.warn('[cron] locked-file re-check failed', (e as Error).message));
    return ok({ ...result, proofOfFundsReread: reread, heldMailReleased: released });
  } catch (error) {
    return fail(error);
  }
}
