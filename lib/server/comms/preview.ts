/**
 * What a proposal would actually do, in the words a person decides on: the exact email or
 * WhatsApp message and who it goes to, the form the client would receive, or the order that
 * would be placed. Built with the same templates, contact details and channel choice the send
 * would use — on a sandbox case, the sandbox's stand-in addresses — and nothing is sent.
 */
import { commsDeps } from './adapters';
import { ProductionChaser, ProductionClientComms, type MessagePreview } from './client-comms';
import { CLIENT_UPDATES, SEARCH_NAMES } from './templates';
import { isSandboxMatter, sandboxCommsDeps } from '../engine/sandbox';

export type ProposalPreview =
  | ({ kind: 'message' } & MessagePreview)
  | { kind: 'form'; to: string; address: string | null; channel: MessagePreview['channel']; subject: string; body: string; note: string | null }
  | { kind: 'action'; title: string; lines: string[] };

export async function previewProposal(tenantId: string, matterId: string, action: string, detail: Record<string, unknown>, extra: { overview?: string } = {}): Promise<ProposalPreview | null> {
  const deps = (await isSandboxMatter(tenantId, matterId)) ? sandboxCommsDeps() : commsDeps();
  const comms = new ProductionClientComms(deps);
  const chaser = new ProductionChaser(deps);
  const str = (k: string): string | null => (typeof detail[k] === 'string' ? (detail[k] as string) : null);
  if (action === 'client_update' && detail.kind === 'id_check_request') {
    return { kind: 'action', title: `Ask ${str('provider') ?? 'the ID provider'} to run the ID / AML check${str('label') ? ` for ${str('label')}` : ''}`, lines: ['The provider sends the client their link; the result comes back to the case.', 'The check costs the firm a fee.'] };
  }
  if (action === 'client_update' && detail.kind === 'signing_pack') {
    const docs = Array.isArray(detail.documents) ? (detail.documents as string[]) : [];
    const label: Record<string, string> = { transfer: 'the transfer (TR1)', mortgage_deed: 'the mortgage deed', deed_of_trust: 'the declaration of trust' };
    return { kind: 'action', title: 'Send the client their signing pack', lines: [`To sign: ${docs.map((d) => label[d] ?? d).join(', ')}.`, 'Wet-ink deeds go attached to an email from your mailbox, with instructions on witnessing and the firm\'s address to post the originals to. Electronic ones go to the firm\'s signing provider.'] };
  }
  if (action === 'client_update' && detail.kind === 'proof_of_funds_request') {
    const again = !!detail.followUpOf;
    const note = str('noteToClient');
    const m = await comms.previewStatusUpdate({ tenantId, matterId, template: again ? 'proof_of_funds_request_again' : 'proof_of_funds_request', context: { formUrl: '[the form link, created when this is sent]', noteToClient: note ?? '' } });
    return { kind: 'form', ...m, note };
  }
  if (action === 'client_update' && str('template')) {
    const m = await comms.previewStatusUpdate({ tenantId, matterId, template: str('template')!, context: { ...((detail.context as Record<string, unknown>) ?? {}), overview: extra.overview ?? '' } });
    return { kind: 'message', ...m };
  }
  // A first request (the contract pack, the redemption statement…): the email as it would go.
  if (action === 'chase' && detail.kind === 'request' && str('template') && str('recipientRole')) {
    const m = await chaser.previewRequest({ tenantId, matterId, recipientRole: str('recipientRole') as 'seller_solicitor' | 'lender' | 'estate_agent', template: str('template')!, context: (detail.context as Record<string, unknown>) ?? {} });
    return { kind: 'message', ...m };
  }
  if (action === 'chase' && str('template') && str('recipientRole')) {
    const m = await chaser.previewChase({ tenantId, matterId, recipientRole: str('recipientRole')!, template: str('template')!, context: (detail.context as Record<string, unknown>) ?? {} });
    return { kind: 'message', ...m };
  }
  if (action === 'acknowledgement' && str('recipientRole')) {
    const m = await chaser.previewAcknowledgement({ tenantId, matterId, recipientRole: str('recipientRole')!, what: str('what') ?? 'what you sent' });
    return { kind: 'message', ...m };
  }
  if (action === 'search_order') {
    const t = str('searchType') ?? '';
    const name = SEARCH_NAMES[t] ?? t;
    return { kind: 'action', title: `Order the ${name}${/search/i.test(name) ? '' : ' search'} from ${str('provider') ?? 'the search provider'}`, lines: ['The result comes back to the case and is read when it lands.', 'Ordering costs the firm a fee.'] };
  }
  if (action === 'counterparty_update') {
    // The update as it will go (edited on the task if need be).
    return { kind: 'message', to: str('to') === 'estate_agent' ? 'The estate agent' : "The other side's solicitor", address: null, channel: 'email', subject: str('subject') ?? '', body: str('body') ?? '' };
  }
  if (action === 'enquiry_draft') {
    return { kind: 'action', title: "Raise this enquiry with the seller's solicitor", lines: [str('subject') ?? ''].filter(Boolean) };
  }
  void CLIENT_UPDATES;
  return null;
}
