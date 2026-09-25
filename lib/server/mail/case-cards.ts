/**
 * A case as a person recognises it, not by its reference. Nobody looks at "9 Arthur Road
 * contract pack" and thinks "SOO-10202"; they think "the Arthur Road purchase, Priya
 * Shah's, Alice has it, we're waiting on searches". So wherever someone has to pick the
 * case an email belongs to, this is what they are shown — and, in plain words, what in
 * the email points to it.
 */
import { query } from '../db';
import type { MatchSignal } from '../matching';

export interface CaseCard {
  matterId: string;
  matterRef: string;
  propertyAddress: string | null;
  /** "Purchase", "Leasehold sale", "Remortgage"… */
  type: string;
  /** Our client(s) on this case. */
  clients: string[];
  /** Where it has got to, in the words the case view uses. */
  stage: string | null;
  handler: string | null;
  otherSide: string | null;
  closed: boolean;
}

const TYPE: Record<string, string> = {
  freehold_purchase: 'Purchase', leasehold_purchase: 'Leasehold purchase', freehold_sale: 'Sale', leasehold_sale: 'Leasehold sale',
  remortgage: 'Remortgage', transfer_of_equity: 'Transfer of equity',
};
const TRACK: Record<string, string> = { PURCHASE: 'Purchase', SALE: 'Sale', REMORTGAGE: 'Remortgage' };
const STAGE_BUY: Record<string, string> = {
  instruction: 'Instruction', pre_contract: 'Searches & enquiries', contract_review: 'Contract & exchange', pre_exchange: 'Contract & exchange',
  exchanged: 'Exchanged', pre_completion: 'Pre-completion', completed: 'Completed', post_completion: 'Completed',
};
const STAGE_SELL: Record<string, string> = { ...STAGE_BUY, pre_contract: 'Contract pack', contract_review: 'Enquiries & exchange', pre_exchange: 'Enquiries & exchange' };

export async function caseCards(tenantId: string, matterIds: string[]): Promise<Map<string, CaseCard>> {
  const ids = [...new Set(matterIds)];
  if (!ids.length) return new Map();
  const rows = await query<{
    id: string; matter_ref: string; property_address: string | null; buyer_names: string[] | null; seller_names: string[] | null;
    track: string | null; status: string | null; counterparty_solicitor: string | null; handler: string | null; stage: string | null; transaction_type: string | null;
  }>(
    `select m.id, m.matter_ref, m.property_address, m.buyer_names, m.seller_names, m.track, m.status, m.counterparty_solicitor,
            coalesce(u.display_name, u.email) as handler, s.stage, s.state->>'transactionType' as transaction_type
       from matter m
       left join app_user u on u.id = m.assigned_to
       left join matter_engine_state s on s.matter_id = m.id
      where m.tenant_id = $1 and m.id = any($2::uuid[])`,
    [tenantId, ids]
  );
  const out = new Map<string, CaseCard>();
  for (const r of rows) {
    const selling = r.transaction_type ? r.transaction_type.endsWith('_sale') : r.track === 'SALE';
    const clients = ((selling ? r.seller_names : r.buyer_names) ?? []).filter(Boolean);
    out.set(r.id, {
      matterId: r.id,
      matterRef: r.matter_ref,
      propertyAddress: r.property_address,
      type: (r.transaction_type && TYPE[r.transaction_type]) || TRACK[r.track ?? ''] || 'Case',
      clients: clients.length ? clients : ((selling ? r.buyer_names : r.seller_names) ?? []).filter(Boolean),
      stage: r.stage ? (selling ? STAGE_SELL : STAGE_BUY)[r.stage] ?? null : null,
      handler: r.handler,
      // "Mason Clarke Solicitors (Aoife Patel) [Ref: CL-2026-1049]" → "Mason Clarke Solicitors (Aoife Patel)"
      otherSide: r.counterparty_solicitor?.replace(/\s*\[[^\]]*\]\s*/g, ' ').trim() || null,
      closed: r.status === 'CLOSED',
    });
  }
  return out;
}

const ROLE: Record<string, string> = {
  CLIENT: 'our client', OTHER_SIDE: "the other side's solicitor", OTHER_SOLICITOR: "the other side's solicitor", AGENT: 'the estate agent',
  LENDER: 'the lender', OTHER_PARTY: 'the other party', BROKER: 'the broker',
};

/**
 * What in the email points to this case, one plain sentence per reason:
 * "Mentions 9 Arthur Road", "From Sarah Bartlett, the other side's solicitor on this case".
 */
export function explainMatch(
  signals: MatchSignal[],
  ctx: { fromName: string | null; fromAddress: string | null; senderRole: string | null }
): string[] {
  const out: string[] = [];
  const from = ctx.fromName || ctx.fromAddress || 'The sender';
  for (const s of signals) {
    switch (s.kind) {
      case 'LINKED_THREAD': out.push('Earlier emails in this conversation are already on this case'); break;
      case 'KNOWN_CONTACT': out.push(`From ${from}, ${ROLE[s.value ?? ''] ?? 'a contact'} on this case`); break;
      case 'ONLY_CASE': out.push('Their only open case with us'); break;
      case 'CONTACT_FIRM': out.push(`Sent from ${s.value && ROLE[s.value] ? `the same firm as ${ROLE[s.value]}` : 'the firm of a contact on this case'}`); break;
      case 'CASE_REF_TOKEN': out.push(`Carries this case's tag [#${s.value ?? ''}]`); break;
      case 'FIRM_REF': out.push(`Quotes this case's reference, ${s.value ?? ''}`); break;
      case 'STREET': out.push(`Mentions ${s.value ?? 'the property'}`); break;
      case 'ADDRESS': out.push(`Mentions the property's postcode, ${s.value ?? ''}`); break;
      case 'NAME': out.push(`Mentions ${s.value ?? 'the client'}`); break;
      case 'PARTICIPANT_EMAIL':
        out.push(
          s.value && ctx.fromAddress && s.value === ctx.fromAddress.toLowerCase()
            ? ctx.senderRole && ROLE[ctx.senderRole] ? `From ${from}, ${ROLE[ctx.senderRole]} on this case` : `${from} has emailed about this case before`
            : `Copied to ${s.value}, who is on this case`
        );
        break;
      case 'SENDER_DOMAIN': out.push(`Sent from ${s.value}, seen on this case's email before`); break;
    }
  }
  return out;
}

/**
 * Who sent it, relative to this case — the part a stranger cannot fake by quoting public
 * details. 'contact': a confirmed contact on the case. 'firm': someone at a contact's firm.
 * 'seen': an address seen on this case's email before, never confirmed. 'none': only what
 * the email says matches.
 */
export function senderOnCase(signals: MatchSignal[], fromAddress: string | null): 'contact' | 'firm' | 'seen' | 'none' {
  const kinds = new Set(signals.map((s) => s.kind));
  if (kinds.has('KNOWN_CONTACT')) return 'contact';
  if (kinds.has('CONTACT_FIRM')) return 'firm';
  if (signals.some((s) => s.kind === 'PARTICIPANT_EMAIL' && s.value && s.value === fromAddress?.toLowerCase())) return 'seen';
  return 'none';
}
