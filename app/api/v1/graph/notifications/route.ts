import { NextRequest, NextResponse, after } from 'next/server';
import { queryOne } from '@/lib/server/db';
import { getMessage } from '@/lib/server/graph';
import { runTriage, runAutoRules, applyTriageTags } from '@/lib/server/triage';
import { saveEmailAttachmentsToMatter } from '@/lib/server/files';
import { assistOnMessage } from '@/lib/server/assist';
import { fileEmailInMatterFolder } from '@/lib/server/matter';
import { writeAssistCache, markAssistError } from '@/lib/server/assist-cache';
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

        const messageId = n.resourceData?.id;
        if (!messageId) continue;

        const message = await getMessage(user.userId, messageId);
        const triage = await runTriage(user, message);
        await applyTriageTags(user, message, triage);
        await runAutoRules(user, message, triage);

        // Docs received by email on a matched case always get saved to the matter
        // folder automatically (best-effort) — no manual "save to matter" step.
        if (triage.top?.band === 'AUTO' && message.hasAttachments) {
          await saveEmailAttachmentsToMatter(user, triage.top.matterId, messageId, message.subject).catch((e) =>
            console.error('[graph notification] auto-save attachments failed', (e as Error).message)
          );
        }

        // Precompute the full taskpane "situation" (thread summary + drafted
        // reply) and cache it, so opening this email is instant. runTriage above
        // already stored the classification, so assistOnMessage reuses it rather
        // than re-classifying. Best-effort — a failure here never blocks triage.
        //
        // Only spend the summary/draft tokens on mail that's actually worth it:
        // matched to a matter, or flagged as needing attention. Pure noise
        // (newsletters, FYIs with no matter) stays lazy — the taskpane computes
        // it on the rare open instead.
        const worthPrecomputing = triage.top !== null || triage.classification.needsAttention;
        if (worthPrecomputing) {
          try {
            const result = await assistOnMessage(user, { messageId, conversationId: message.conversationId });
            await writeAssistCache(user.tenantId, messageId, result, 'READY');
          } catch (assistError) {
            await markAssistError(user.tenantId, messageId, (assistError as Error).message).catch(() => {});
          }
        }

        // Auto-file a confidently-matched email into its matter's Inbox subfolder
        // to keep the inbox clear. Done last: moving reassigns the message id, so
        // tags + assist cache (keyed on the inbox id) are written first. Best-effort.
        if (triage.top?.band === 'AUTO') {
          await fileEmailInMatterFolder(user, triage.top.matterId, messageId).catch((e) =>
            console.error('[graph notification] auto-file to matter folder failed', (e as Error).message)
          );
        }
      } catch (error) {
        console.error('[graph notification] processing failed', n.subscriptionId, (error as Error).message);
      }
    }
  });

  return NextResponse.json({ ok: true }, { status: 202 });
}
