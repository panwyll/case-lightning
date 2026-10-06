/**
 * The workload baseline's categories, and the rules that read a message before any model does
 * (docs/workload-baseline.md §1–2). Pure: no I/O.
 */

/** What a conveyancer's sent email was for. Exactly one per message. */
export const OUT_CATEGORIES = ['chaser', 'status_update', 'update_reply', 'first_request', 'file_send', 'acknowledgement', 'scheduling', 'client_question', 'legal_work', 'internal', 'non_case'] as const;
export type OutCategory = (typeof OUT_CATEGORIES)[number];

/** What a received email asked of us. */
export const IN_CATEGORIES = ['update_request', 'chaser_received', 'document_delivery', 'question', 'instruction', 'enquiry', 'other'] as const;
export type InCategory = (typeof IN_CATEGORIES)[number];

/** What CONVEYi does with that kind of email: sends it, drafts it, or leaves it to the conveyancer. */
export type Tier = 'automated' | 'drafted' | 'conveyancer' | 'excluded';

export const OUT_SPEC: Record<OutCategory, { label: string; what: string; tier: Tier }> = {
  chaser: { label: 'Chasers', what: 'Asking again for something already asked for or overdue', tier: 'automated' },
  status_update: { label: 'Status Updates', what: 'Telling someone where the case stands, unprompted', tier: 'automated' },
  update_reply: { label: 'Answers To "Any News?"', what: 'Replying to someone asking for an update', tier: 'automated' },
  first_request: { label: 'First Requests', what: 'Asking for something for the first time: ID, forms, funds, documents, figures', tier: 'automated' },
  file_send: { label: 'Files Sent', what: 'Sending a document or a copy someone needs', tier: 'automated' },
  acknowledgement: { label: 'Acknowledgements', what: 'Confirming something arrived', tier: 'automated' },
  scheduling: { label: 'Scheduling', what: 'Arranging calls, appointments, dates, completion logistics', tier: 'drafted' },
  client_question: { label: 'Client Questions', what: "Answering a client's question about the process or their case (not \"any news?\")", tier: 'drafted' },
  legal_work: { label: 'Legal Work', what: 'Enquiries and replies, advice, reports, contract points, negotiation, undertakings', tier: 'conveyancer' },
  internal: { label: 'Internal', what: 'To colleagues at the firm', tier: 'excluded' },
  non_case: { label: 'Not Case Work', what: 'Anything else', tier: 'excluded' },
};

export const IN_SPEC: Record<InCategory, { label: string; what: string }> = {
  update_request: { label: 'Update Requests', what: 'Someone asking where things stand' },
  chaser_received: { label: 'Chasers Received', what: 'Someone chasing us for something' },
  document_delivery: { label: 'Documents Delivered', what: 'Someone sending us a document' },
  question: { label: 'Questions', what: 'A question about the process or the case' },
  instruction: { label: 'Instructions', what: 'A client deciding or instructing' },
  enquiry: { label: 'Enquiries', what: "The other side's enquiries or replies" },
  other: { label: 'Other', what: 'Anything else' },
};

export const TIER_LABEL: Record<Tier, string> = { automated: 'Sent By CONVEYi', drafted: 'Drafted By CONVEYi', conveyancer: "The Conveyancer's", excluded: 'Not Counted' };

/** Who a message went to, as the classifier reads it. */
export const ROLES = ['client', 'other_solicitor', 'estate_agent', 'lender', 'broker', 'colleague', 'third_party'] as const;
export type Role = (typeof ROLES)[number];

/** Why a message was set aside by rule before classification. */
export type Filtered = 'automated' | 'bulk' | 'calendar' | 'auto_reply' | 'empty';
export const FILTERED_LABEL: Record<Filtered, string> = { automated: 'Automated senders', bulk: 'Newsletters and bulk mail', calendar: 'Calendar responses', auto_reply: 'Out-of-office and bounces', empty: 'Nothing written' };

const AUTOMATED_SENDER = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|postmaster|bounces?|alerts?|news(letter)?|marketing)([._+-]|@)/i;
const CALENDAR = /^(accepted|declined|tentative|tentatively accepted|updated invitation|invitation|canceled|cancelled)( event)?:/i;
const AUTO_REPLY = /^(automatic reply|auto(-|matic )?reply|out of (the )?office|undeliverable|delivery (status notification|has failed)|mail delivery (failed|subsystem))/i;

/** The rule that sets a message aside before any model reads it, or null. */
export function filterByRule(m: { direction: 'out' | 'in'; from: string; subject: string; text: string; hasAttachments: boolean; bulk?: boolean }): Filtered | null {
  if (CALENDAR.test(m.subject.trim())) return 'calendar';
  if (AUTO_REPLY.test(m.subject.trim())) return 'auto_reply';
  if (m.direction === 'in' && AUTOMATED_SENDER.test(m.from)) return 'automated';
  if (m.direction === 'in' && (m.bulk || /\bunsubscribe\b/i.test(m.text))) return 'bulk';
  if (wordCount(m.text) === 0 && !m.hasAttachments) return 'empty';
  return null;
}

/** RE: / FW: at the start of a subject, however many times. */
export const isReplySubject = (s: string) => /^\s*(re|aw|sv)\s*:/i.test(s);
export const isForwardSubject = (s: string) => /^\s*(fw|fwd)\s*:/i.test(s);

// Where a written message ends and the signature or disclaimer begins.
const SIGN_OFF = /^\s*(kind(est)? regards|warm(est)? regards|best regards|regards|best wishes|many thanks|thanks( again)?|thank you|yours (sincerely|faithfully)|cheers|all the best)[,.!]?\s*$/i;
const CUT = /^\s*(--\s*$|_{5,}|-{5,}|sent from my |get outlook for |this (e-?mail|message)( and any attachments?)? (is|are|may be) (confidential|private|intended)|confidentiality notice|disclaimer:|registered (in england|office)|authorised and regulated by)/i;

/**
 * The words the person wrote: the message's own added part, without the signature or disclaimer.
 * `uniqueBody` already leaves out the quoted thread; a quoted block that slipped through ("On … wrote:",
 * "From: … Sent: …") is cut too. The sign-off line itself is kept as written (two words); what follows it is not.
 */
export function writtenText(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (CUT.test(l)) break;
    if (/^\s*(on .{3,80} wrote:|from:\s.+|-{2,}\s*original message\s*-{2,})\s*$/i.test(l)) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
    if (SIGN_OFF.test(l)) break;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Words, as a typist would count them. */
export function wordCount(text: string): number {
  // A figure is one word however it is written (£250,000.00).
  return (text.match(/[£$€]?\d[\d,.]*\d|[A-Za-z0-9£$€'’-]+/g) ?? []).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

/** The domain of an address, lower case. */
export const domainOf = (address: string) => (address.split('@')[1] ?? '').trim().toLowerCase();

/** Free mail providers: a firm user on one of these does not make every client on it a colleague. */
export const PUBLIC_MAIL = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|mac|aol|btinternet|btopenworld|sky|talktalk|virginmedia|ntlworld|protonmail|proton)\.[a-z.]+$/i;

/** The firm's own mail domains, without free providers. */
export const firmDomainsOf = (domains: Iterable<string>) => [...domains].map((d) => d.toLowerCase()).filter((d) => d && !PUBLIC_MAIL.test(d));

/** Every recipient is at the firm: internal, by rule. */
export function allInternal(recipients: string[], firmDomains: string[]): boolean {
  const own = new Set(firmDomains.map((d) => d.toLowerCase()));
  return recipients.length > 0 && recipients.every((r) => own.has(domainOf(r)));
}
