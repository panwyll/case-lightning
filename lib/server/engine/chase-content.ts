/**
 * What a chase puts back in front of the person: the thing we asked for, again, so nobody has
 * to dig out our first email. A client gets the same link or form, or the list of what is
 * needed and how to send it; a firm gets exactly what is still outstanding. Pure: built from
 * the case as it stands when the chase goes, never from when it was proposed.
 */
import { SEARCH_NAMES } from '../comms/templates';
import { SIGNED_DOCUMENT_LABEL, deedSigned, deedsToSign, isLeasehold, type MatterState, type SignedDocument } from './types';

export const FORM_NAMES: Record<string, string> = {
  TA6: 'the property information form (TA6)',
  TA10: 'the fittings and contents form (TA10)',
  TA7: 'the leasehold information form (TA7)',
  TA13: 'the completion information form (TA13)',
};

const bullets = (xs: string[]) => xs.map((x) => `• ${x}`).join('\n');
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');
const clip = (s: string, n = 280) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

const ID_DOCUMENTS = [
  'photo ID: a current passport or photocard driving licence',
  'proof of address dated in the last three months: a bank statement, utility bill or council tax bill',
];

export interface ChaseContentOptions {
  /** The ID provider emails the person their own link (so, when we hold no link, the chase says where to look). */
  idProviderSendsLink?: boolean;
  idProviderLabel?: string | null;
}

/** The deeds the client still has to sign, each with how. */
export function unsignedDeeds(s: MatterState): Array<{ document: SignedDocument; label: string; method: 'wet' | 'electronic' }> {
  return deedsToSign(s)
    .filter((d) => !deedSigned(s, d))
    .map((d) => ({ document: d, label: SIGNED_DOCUMENT_LABEL[d], method: s.signing.envelopes[d] || s.signing.methods[d] === 'electronic' ? 'electronic' as const : 'wet' as const }));
}

/**
 * The block a chase carries, as template variables: `resend` (the thing again) and, for a chase
 * that covers several items, `outstandingCount`. Empty strings where there is nothing to add.
 */
export function chaseContent(s: MatterState, waitKey: string, subject: string | null, opts: ChaseContentOptions = {}): Record<string, string> {
  const sub = subject ?? '';
  switch (waitKey) {
    case 'id_check': {
      const target = sub ? s.partyChecks[sub] : s.idCheck;
      const who = sub && s.partyChecks[sub] ? s.partyChecks[sub].label : '';
      const link = target?.link ?? null;
      const lead = who ? `This is the identity check for ${who}.\n\n` : '';
      if (link) return { resend: `${lead}Here is the link to the check again, so you do not have to look for our earlier email:\n${link}\n\nIt takes about ten minutes on a phone: a photo of a passport or driving licence, a short selfie video, and a check of the address.`, idWho: who };
      if (opts.idProviderSendsLink) return { resend: `${lead}The check comes by email from ${opts.idProviderLabel ?? 'our ID provider'}, with its own link. If you cannot find it (it is worth looking in junk), reply to this email and we will have it sent again.\n\nWhat the check asks for:\n${bullets(ID_DOCUMENTS)}`, idWho: who };
      return { resend: `${lead}What we need:\n${bullets(ID_DOCUMENTS)}\n\nPlease reply to this email with clear photos or scans of them. Every page must be readable and nothing cropped.`, idWho: who };
    }
    case 'proof_of_funds': {
      const url = s.proofOfFunds.formUrl;
      if (url) return { resend: `Here is the form again, so you do not have to look for our earlier email:\n${url}\n\nIt asks where each part of the money comes from (savings, a sale, a gift, a mortgage) and lets you attach bank statements and other documents. It takes about ten minutes.` };
      return { resend: 'If you cannot find our earlier email with the form, reply to this one and we will send it again.' };
    }
    case 'property_forms': {
      const forms = (s.propertyForms.forms.length ? s.propertyForms.forms : isLeasehold(s) ? ['TA6', 'TA10', 'TA7'] : ['TA6', 'TA10']).map((f) => FORM_NAMES[f] ?? f);
      return { resend: `The forms we need back:\n${bullets(forms)}\n\nPlease reply to this email with them attached; clear photos or scans are fine. If a question has you stuck, answer what you can and tell us which one; "not known" is a proper answer when it is true.` };
    }
    case 'signed_documents': {
      const deeds = unsignedDeeds(s);
      if (!deeds.length) return { resend: '' };
      const line = (d: (typeof deeds)[number]) => `${d.label}: ${d.method === 'electronic' ? 'to sign electronically, from the email our signing provider sent you' : 'to print, sign in ink in front of an independent adult witness, and post the original back to us'}`;
      return { resend: `Still to sign:\n${bullets(deeds.map(line))}\n\nPlease do not date anything; we date the documents on completion.`, lenderLine: deeds.some((d) => d.document === 'mortgage_deed') ? ', and your lender will not release the mortgage money until we hold the signed mortgage deed' : '' };
    }
    case 'enquiry': {
      const open = Object.values(s.enquiries).filter((q) => q.status === 'raised').sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
      if (!open.length) return { resend: '', outstandingCount: '' };
      const list = open.map((q, i) => `${i + 1}. ${clip(q.subject)} (raised ${day(q.raisedAt)})`).join('\n');
      return { resend: `Outstanding:\n${list}`, outstandingCount: String(open.length) };
    }
    case 'contract_pack': {
      const items = ['the draft contract', 'official copies of the register and title plan', 'the property information form (TA6) and fittings and contents form (TA10)'];
      if (isLeasehold(s)) items.push('the leasehold information form (TA7), a copy of the lease and the management pack or details of the managing agent');
      items.push('any planning permissions, building regulations certificates and guarantees referred to in the forms');
      return { resend: `What we need:\n${bullets(items)}` };
    }
    case 'survey':
      return { resend: '', valuationLine: s.hasLender ? 'A mortgage valuation is for the lender, not for you, and does not look at the condition of the property. ' : '' };
    case 'management_pack':
      return { resend: `What we need:\n${bullets(['the LPE1 (or the managing agent\'s own form)', 'service charge accounts for the last three years and the current budget', 'the buildings insurance schedule', 'details of any planned major works and any section 20 notices'])}` };
    case 'search': {
      const name = SEARCH_NAMES[sub] ?? sub;
      return { resend: name ? `Outstanding: the ${name}.` : '' };
    }
    case 'redemption': {
      const date = s.targetCompletionDate ? `to ${s.targetCompletionDate}` : 'to the anticipated completion date';
      return { resend: `What we need: a redemption statement calculated ${date}, with the daily rate of interest and the account details for payment.` };
    }
    default:
      return { resend: '' };
  }
}

/**
 * One line a client update carries for something waiting on the client, so it can be done from
 * this message: the link, the form, or what to send. Null when there is nothing to hand them.
 */
export function clientToHand(s: MatterState, waitKey: string, subject: string | null, opts: ChaseContentOptions = {}): string | null {
  const sub = subject ?? '';
  switch (waitKey) {
    case 'id_check': {
      const target = sub ? s.partyChecks[sub] : s.idCheck;
      const who = sub && s.partyChecks[sub] ? ` for ${s.partyChecks[sub].label}` : '';
      if (target?.link) return `Identity check${who}: ${target.link}`;
      if (opts.idProviderSendsLink) return `Identity check${who}: the link is in the email from ${opts.idProviderLabel ?? 'our ID provider'}; reply if you cannot find it`;
      return `Identity check${who}: reply with clear photos of a passport or driving licence and a recent bank statement or utility bill`;
    }
    case 'proof_of_funds':
      return s.proofOfFunds.formUrl ? `Proof-of-funds form: ${s.proofOfFunds.formUrl}` : null;
    case 'property_forms': {
      const forms = (s.propertyForms.forms.length ? s.propertyForms.forms : isLeasehold(s) ? ['TA6', 'TA10', 'TA7'] : ['TA6', 'TA10']).map((f) => FORM_NAMES[f] ?? f);
      return `Property forms: ${forms.join(', ')}; reply with them attached`;
    }
    case 'signed_documents': {
      const deeds = unsignedDeeds(s);
      return deeds.length ? `To sign: ${deeds.map((d) => d.label.toLowerCase()).join(', ')}; reply if you need the documents sent again` : null;
    }
    default:
      return null;
  }
}
