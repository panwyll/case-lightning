import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';
import { requireWriter } from '@/lib/server/engine/http';
import { counterpartyRefOf, resolveCounterparty, setCounterparty } from '@/lib/server/engine/counterparty';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The matter's counterparty as the rest of the system sees it: resolved contact details + type. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const [ref, resolved] = await Promise.all([counterpartyRefOf(user.tenantId, matterId), resolveCounterparty(user.tenantId, matterId)]);
    return ok({ ref, counterparty: resolved });
  } catch (error) {
    return fail(error);
  }
}

/**
 * Set the counterparty: an external party, or another matter in this firm (an internal
 * link). Linking is refused — 409 — when the same handler is on both matters; that
 * situation needs the documented-consent process outside this system. The database
 * trigger re-checks, and from then on the ethical wall (RLS) keeps each handler out of
 * the other's matter.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    requireWriter(user);
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const body = z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('external'), name: z.string().max(200).nullish(), email: z.string().email().nullish(), firm: z.string().max(200).nullish() }),
        z.object({ kind: z.literal('internal'), matterId: z.string().uuid(), chainRef: z.string().max(100).nullish() }),
      ])
      .parse(await req.json());
    const ref = body.kind === 'external' ? { kind: 'external' as const, name: body.name ?? null, email: body.email ?? null, firm: body.firm ?? null } : { kind: 'internal' as const, matterId: body.matterId };
    await setCounterparty(user.tenantId, matterId, ref, user.userId, body.kind === 'internal' ? body.chainRef ?? null : null);
    await writeAudit({ tenantId: user.tenantId, matterId, actorUserId: user.userId, actionType: 'COUNTERPARTY_SET', actionStatus: 'SUCCESS', payload: { kind: ref.kind, linkedMatterId: ref.kind === 'internal' ? ref.matterId : null } }).catch(() => {});
    return ok({ ref, counterparty: await resolveCounterparty(user.tenantId, matterId) });
  } catch (error) {
    return fail(error);
  }
}
