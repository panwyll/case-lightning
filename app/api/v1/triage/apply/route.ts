import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { upsertIdentifiers, domainOf, tenantSelfAddresses } from '@/lib/server/matching';
import { getMessage } from '@/lib/server/graph';
import { saveEmailAttachmentsToMatter } from '@/lib/server/files';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Confirm or override a match: links the thread to the chosen matter and learns
 * its participants as identifiers (so future emails match harder). Matches below
 * the AUTO band require riskAccepted=true — the user is accepting a subpar match.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const body = z
      .object({
        triageId: z.string().uuid().optional(),
        matterId: z.string().uuid(),
        messageId: z.string(),
        conversationId: z.string().optional(),
        band: z.enum(['AUTO', 'STRONG', 'WEAK', 'NONE']).optional(),
        riskAccepted: z.boolean().default(false),
      })
      .parse(await req.json());

    await assertMatterAccess(user, body.matterId);

    if (body.band && body.band !== 'AUTO' && !body.riskAccepted) {
      return fail(new Error('This is below the high-confidence bar — accept the subpar-match risk to confirm.'));
    }

    const message = await getMessage(user.userId, body.messageId);
    const conversationId = body.conversationId ?? message.conversationId ?? body.messageId;

    await query(
      `insert into email_thread (tenant_id, matter_id, graph_thread_id, graph_conversation_id, subject)
       values ($1,$2,$3,$4,$5)
       on conflict (tenant_id, graph_thread_id) do update set matter_id = excluded.matter_id`,
      [user.tenantId, body.matterId, conversationId, conversationId, message.subject ?? null]
    );

    // Learn identifiers from the participants so the matcher gets stronger over time.
    // Exclude the firm's OWN mailbox addresses/domains — they sit on every email and
    // would otherwise make unrelated mail (e.g. marketing addressed to the firm)
    // match this matter.
    const self = await tenantSelfAddresses(user.tenantId);
    const participants = [
      message.from?.emailAddress?.address,
      ...(message.toRecipients ?? []).map((r: any) => r.emailAddress?.address),
      ...(message.ccRecipients ?? []).map((r: any) => r.emailAddress?.address),
    ].filter(Boolean) as string[];
    const idents: Array<{ kind: 'EMAIL' | 'DOMAIN'; value: string }> = [];
    for (const p of participants) {
      const email = p.toLowerCase();
      if (self.emails.has(email)) continue; // never index our own address
      idents.push({ kind: 'EMAIL', value: email });
      const d = domainOf(p);
      if (d && !self.domains.has(d)) idents.push({ kind: 'DOMAIN', value: d });
    }
    await upsertIdentifiers(user.tenantId, body.matterId, idents);

    // Linking the email to a matter saves its attachments to the matter folder
    // (same as the auto-matched path) — best-effort, no-ops when there are none.
    if (message.hasAttachments) {
      await saveEmailAttachmentsToMatter(user, body.matterId, body.messageId, message.subject).catch(() => {});
    }

    if (body.triageId) {
      await query(
        `update email_triage set decision = $1, matched_matter_id = $2, risk_accepted = $3, decided_by = $4, decided_at = now()
         where id = $5 and tenant_id = $6`,
        [
          body.band === 'AUTO' ? 'CONFIRMED' : 'OVERRIDDEN',
          body.matterId,
          body.riskAccepted,
          user.userId,
          body.triageId,
          user.tenantId,
        ]
      );
    }

    await writeAudit({
      tenantId: user.tenantId,
      matterId: body.matterId,
      actorUserId: user.userId,
      actionType: 'MATCH_CONFIRMED',
      actionStatus: 'SUCCESS',
      payload: { messageId: body.messageId, band: body.band ?? null, riskAccepted: body.riskAccepted },
    });

    return ok({ ok: true, matterId: body.matterId });
  } catch (error) {
    return fail(error);
  }
}
