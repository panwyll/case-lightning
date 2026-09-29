import { NextRequest, NextResponse, after } from 'next/server';
import { queryOne } from '@/lib/server/db';
import { isEntitled, emailQuotaStatus } from '@/lib/server/plan';
import { processIncomingMessage } from '@/lib/server/mail/incoming';
import { holdMail } from '@/lib/server/billing-suspension';
import type { SessionUser } from '@/lib/server/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Microsoft Graph change-notification receiver. Public by necessity (Graph calls
 * it); security comes from the per-subscription clientState. Two jobs:
 *  1. Validation handshake — echo ?validationToken on subscription creation.
 *  2. Notifications — for each, verify clientState, then triage + tag + auto-rule
 *     the new message AFTER responding (Graph requires a fast 2xx).
 */
export async function POST(req: NextRequest) {
  const validationToken = req.nextUrl.searchParams.get('validationToken');
  if (validationToken) {
    return new Response(validationToken, { status: 200, headers: { 'content-type': 'text/plain' } });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }
  const notifications: any[] = Array.isArray(body?.value) ? body.value : [];

  // Acknowledge immediately; process out of band.
  after(async () => {
    for (const n of notifications) {
      try {
        const sub = await queryOne<{ user_id: string; tenant_id: string; client_state: string }>(
          `select user_id, tenant_id, client_state from graph_subscription where id = $1`,
          [n.subscriptionId]
        );
        if (!sub || sub.client_state !== n.clientState) continue; // unknown/forged → ignore

        const user = await queryOne<SessionUser>(
          `select id as "userId", tenant_id as "tenantId", role, email, display_name as "displayName"
           from app_user where id = $1`,
          [sub.user_id]
        );
        if (!user) continue;
        // A suspended firm (unpaid past its grace period): the mail is held, not read and not
        // dropped, and processed the moment they pay (billing-suspension.ts).
        if (!(await isEntitled(user.tenantId))) {
          const id = n.resourceData?.id;
          if (id) await holdMail(user.tenantId, user.userId, id);
          continue;
        }
        // Over the monthly email cap → stop processing new mail until next month/upgrade.
        if (!(await emailQuotaStatus(user.tenantId)).allowed) continue;

        const messageId = n.resourceData?.id;
        if (!messageId) continue;
        await processIncomingMessage(user, messageId);
        // NB: we deliberately do NOT move the email here. The inbox stays an in-tray;
        // a matched email is only filed into its matter's folder once the user has
        // actually actioned it (replied / updated / delegated / marked handled).
      } catch (error) {
        console.error('[graph notification] processing failed', n.subscriptionId, (error as Error).message);
      }
    }
  });

  return NextResponse.json({ ok: true }, { status: 202 });
}
