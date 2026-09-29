/**
 * One new email into the firm's system: triage, tags, the filing queue, auto-filing, the
 * precomputed reply and the case notification. Called for each Graph notification, and
 * for mail held while a firm was suspended when they resume.
 */
import { after } from 'next/server';
import { getMessage, senderOfMessageId } from '../graph';
import { runTriage, applyTriageTags } from '../triage';
import { runAutoAutomations } from '../automations';
import { hasTrustedLink, hasDefinitiveSignal, linkedFilingHeld } from '../matching';
import { indexEmailBodyToMatter, saveEmailAttachmentsToMatter } from '../files';
import { markMatterDraftsStale } from '../worklist';
import { learnFirmRef } from '../contacts';
import { assistOnMessage } from '../assist';
import { notifyMatter } from '../events';
import { writeAssistCache, markAssistError } from '../assist-cache';
import { enqueueMessage } from './queue';
import { autoFileToCase } from './auto-file';
import type { SessionUser } from '../types';

export async function processIncomingMessage(user: SessionUser, messageId: string): Promise<void> {
  const message = await getMessage(user.userId, messageId);

  // A notification off the Sent Items folder is the fee earner's OWN mail. It
  // must reach the shared case record — that's the whole point of watching sent
  // items — but it is not an actionable inbound: we don't tag it in Outlook,
  // don't run auto-rules against it, don't draft a reply to it, and don't
  // announce "new email from <the lawyer themselves>". Detect by sender rather
  // than trusting the folder, so a cc'd copy in the inbox can't be misread.
  const selfAddr = (user.email || '').toLowerCase();
  const fromAddr = (message.from?.emailAddress?.address || '').toLowerCase();
  const outbound = !!selfAddr && fromAddr === selfAddr;

  const triage = await runTriage(user, message);

  if (outbound) {
    // Mirror the inbound learning: file attachments, index the body, learn our
    // own reference (direction known for certain), flag drafts the send overtook.
    //
    // Gate is DEFINITIVE, not trusted-link. Inbound requires a trusted link
    // because its content is attacker-controllable — a stranger quoting a case
    // ref could inject into a victim's file. A SENT email is authored by the
    // firm from its own account, so that threat is absent: a definitive
    // reference the firm itself wrote (our token / the firm's own "Our ref:")
    // is trustworthy. This is what stops the fee earner's own outbound reply —
    // often quoting the ref on a thread nobody manually linked — vanishing.
    // Still definitive-only: a fuzzy address match is not adopted for a write.
    if (triage.top && hasDefinitiveSignal(triage.top)) {
      const mId = triage.top.matterId;
      if (message.hasAttachments) {
        await saveEmailAttachmentsToMatter(user, mId, messageId, message.subject).catch(() => {});
      }
      await indexEmailBodyToMatter(user, mId, message).catch(() => {});
      await learnFirmRef(user, mId, message, { outbound: true }).catch(() => {});
      await markMatterDraftsStale(
        user.tenantId,
        mId,
        `You sent an email${message.subject ? ` — “${String(message.subject).slice(0, 60)}”` : ''}`,
        `thread:${message.conversationId ?? ''}`
      ).catch(() => 0);
    }
    return; // done with this (outbound) message
  }

  await applyTriageTags(user, message, triage);
  await runAutoAutomations(user, message, triage);

  // Not on a case yet → onto the filing queue, with the matching and the sender
  // check the triage just did. A trusted link means it IS on a case. Best-effort.
  // On a filed conversation, but naming a different case: a person decides, not the link.
  const strayed = triage.top && hasTrustedLink(triage.top) ? await linkedFilingHeld(user.tenantId, triage.top, triage.candidates ?? [], message, (id) => senderOfMessageId(user.userId, id)) : null;
  if (strayed) console.info(`[graph notification] on a conversation filed to ${triage.top!.matterRef}, but ${strayed}: queued for a person`);
  if (!(triage.top && hasTrustedLink(triage.top)) || strayed) {
    const cls = triage.classification as { caseMail?: 'yes' | 'no' | null; caseMailWhat?: string | null; sender?: typeof triage.classification.sender };
    await enqueueMessage(user, message, {
      candidates: triage.candidates,
      sender: cls.sender,
      caseMail: cls.caseMail ?? null,
      caseMailWhat: cls.caseMailWhat ?? null,
    }).catch((e) => console.error('[graph notification] enqueue failed', (e as Error).message));
  }

  // Auto-file attachments into a case's knowledge base ONLY on a trusted link
  // the firm created — never a case-ref token (attacker-injectable) or fuzzy
  // corroboration, or this email's documents could be filed into the wrong
  // client's case. Token/fuzzy matches wait for the user to confirm. Best-effort.
  if (triage.top && hasTrustedLink(triage.top) && !strayed) {
    // Outside a request (a held email released on resume) there is no after(): run it now.
    await autoFileToCase(user, message, triage.top.matterId, { later: (fn) => { try { after(fn); } catch { void fn(); } } });
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

  // Proactive loop: a confirmed-match email that actually needs the fee-earner earns a
  // briefing line. Routine matched mail (no action needed) stays silent — it's on the
  // worklist already. Dedup per matter so a flurry on one case = one "there's activity".
  if (triage.top && hasTrustedLink(triage.top) && triage.classification.needsAttention) {
    const fromName = message.from?.emailAddress?.name || message.from?.emailAddress?.address || 'someone';
    await notifyMatter(user.tenantId, triage.top.matterId, {
      kind: 'EMAIL_TRIAGED',
      headline: `New email from ${fromName}${message.subject ? ` — “${String(message.subject).slice(0, 80)}”` : ''}`,
      did: worthPrecomputing ? 'Read it and drafted a suggested reply for you to review' : 'Triaged it and matched it to this case',
      action: 'Open the case to review and reply',
      dedupKey: `email:${triage.top.matterId}`,
    }).catch(() => {});
  }

}
