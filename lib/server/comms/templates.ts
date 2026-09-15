/**
 * Component #5 — message templates. Two families, deliberately separate:
 *
 *   CLIENT_UPDATES — status updates to the buyer. Pure admin, zero legal content:
 *                    "your search is back", "we're waiting on X". Safe to send
 *                    automatically. They never contain transaction-specific advice.
 *   CHASES         — template chase messages to third parties (seller's solicitor,
 *                    search provider, lender, HMLR, the client for ID documents),
 *                    fired by the engine's timers. Template-based, not AI-written.
 *
 * Rendering is deterministic: `{{var}}` placeholders, missing values render as
 * empty and are reported so a caller can refuse to send a half-filled message.
 */
export interface Template {
  key: string;
  channel: 'client' | 'chase';
  subject: string;
  body: string;
  /** Variables the body needs; render() reports which are missing. */
  requires: string[];
}

const T = (key: string, channel: Template['channel'], subject: string, body: string, requires: string[] = []): Template => ({ key, channel, subject, body, requires });

export const CLIENT_UPDATES: Record<string, Template> = {
  searches_ordered: T('searches_ordered', 'client', 'Your purchase of {{property}} — searches ordered', 'Hello {{firstName}},\n\nA quick update on {{property}}: we have ordered the property searches ({{searchList}}). These usually take two to three weeks to come back from the local authority and other providers. We will let you know as each one arrives.\n\nNothing is needed from you right now.\n\n{{firmName}}'),
  search_back_all_clear: T('search_back_all_clear', 'client', 'Your purchase of {{property}} — search received', 'Hello {{firstName}},\n\nThe {{searchName}} for {{property}} has come back and nothing in it needs any action. We will include a summary in your report on title.\n\n{{firmName}}'),
  search_back_under_review: T('search_back_under_review', 'client', 'Your purchase of {{property}} — search received', 'Hello {{firstName}},\n\nThe {{searchName}} for {{property}} has come back and your conveyancer is reviewing one or two entries in it. That is normal — most searches have something to check. We will be in touch if anything needs your input.\n\n{{firmName}}'),
  enquiries_raised: T('enquiries_raised', 'client', 'Your purchase of {{property}} — enquiries sent', 'Hello {{firstName}},\n\nWe have sent our pre-contract enquiries to the seller\'s solicitor for {{property}}. We are now waiting on their replies and will chase them if they are slow.\n\n{{firmName}}'),
  mortgage_offer_checked: T('mortgage_offer_checked', 'client', 'Your purchase of {{property}} — mortgage offer checked', 'Hello {{firstName}},\n\nWe have received and checked your mortgage offer for {{property}}. Its conditions are in order for us to proceed.\n\n{{firmName}}'),
  report_on_title_sent: T('report_on_title_sent', 'client', 'Your purchase of {{property}} — report on title', 'Hello {{firstName}},\n\nYour report on title for {{property}} has been sent to you separately. Please read it carefully and come back to us with any questions before we exchange contracts.\n\n{{firmName}}'),
  exchanged: T('exchanged', 'client', 'Your purchase of {{property}} — contracts exchanged', 'Hello {{firstName}},\n\nGood news: contracts have been exchanged on {{property}}. The purchase is now legally binding and completion is set for {{completionDate}}.\n\n{{firmName}}'),
  completed: T('completed', 'client', 'Your purchase of {{property}} — completed', 'Hello {{firstName}},\n\nCongratulations — your purchase of {{property}} has completed today. Keys are released through the estate agent. We will now deal with the stamp duty return and the Land Registry registration.\n\n{{firmName}}'),
  registration_complete: T('registration_complete', 'client', 'Your purchase of {{property}} — registered', 'Hello {{firstName}},\n\nHM Land Registry has now registered you as the owner of {{property}}. We will send you the updated title information for your records. This concludes the legal work on your purchase.\n\n{{firmName}}'),
  qa_routed_to_human: T('qa_routed_to_human', 'client', 'Your question', 'Thanks for your message. Because it relates to the specifics of your purchase, {{feeEarner}} will come back to you personally rather than this automated service. If it is urgent, please call the office.', ['feeEarner']),
};

export const CHASES: Record<string, Template> = {
  chase_search_provider: T('chase_search_provider', 'chase', '{{matterRef}} — {{searchName}} search outstanding ({{address}})', 'Dear Sirs,\n\nOur reference {{matterRef}}. We ordered a {{searchName}} for {{address}} on {{orderedDate}} ({{ageWorkingDays}} working days ago) and have not yet received the result. Please confirm the current position and expected return date.\n\nKind regards,\n{{feeEarner}}\n{{firmName}}', ['matterRef', 'address']),
  chase_enquiry_reply: T('chase_enquiry_reply', 'chase', '{{address}} — replies to enquiries outstanding (our ref {{matterRef}})', 'Dear Sirs,\n\nWe refer to our enquiries raised on {{orderedDate}} in respect of {{address}}. Replies remain outstanding after {{ageWorkingDays}} working days{{priorChaseNote}}. Our client is anxious to proceed; please let us have your client\'s replies by return.\n\nKind regards,\n{{feeEarner}}\n{{firmName}}', ['matterRef', 'address']),
  chase_id_documents: T('chase_id_documents', 'client', 'Your purchase of {{property}} — identity documents needed', 'Hello {{firstName}},\n\nWe are still waiting for your identity and source-of-funds documents so we can complete the required checks for {{property}}. We cannot progress the purchase until these are done. Please send them as soon as you can, or reply here if you need help with what is required.\n\n{{firmName}}'),
  chase_completion_funds: T('chase_completion_funds', 'chase', '{{matterRef}} — completion funds ({{address}})', 'Dear Sirs,\n\nOur reference {{matterRef}}. Completion of {{address}} is scheduled for {{completionDate}}. We requested the advance/completion monies on {{orderedDate}} and have not yet received confirmation of release. Please confirm the funds will arrive in time.\n\nKind regards,\n{{feeEarner}}\n{{firmName}}', ['matterRef', 'address']),
  chase_hmlr_registration: T('chase_hmlr_registration', 'chase', '{{matterRef}} — AP1 registration outstanding ({{address}})', 'Dear Sirs,\n\nOur reference {{matterRef}}. Our AP1 application for {{address}} was lodged on {{orderedDate}} and remains outstanding after {{ageWorkingDays}} working days. Please confirm the current position.\n\nKind regards,\n{{feeEarner}}\n{{firmName}}', ['matterRef', 'address']),
};

export const SEARCH_NAMES: Record<string, string> = {
  LLC1: 'local land charges search (LLC1)',
  CON29: 'local authority search (CON29)',
  DRAINAGE_WATER: 'drainage and water search',
  ENVIRONMENTAL: 'environmental search',
  CHANCEL: 'chancel repair search',
};

export interface Rendered {
  subject: string;
  body: string;
  missing: string[];
}

export function render(t: Template, vars: Record<string, string | number | null | undefined>): Rendered {
  const missing: string[] = [];
  const sub = (s: string) =>
    s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
      const v = vars[k];
      if (v === null || v === undefined || v === '') {
        if (t.requires.includes(k) && !missing.includes(k)) missing.push(k);
        return '';
      }
      return String(v);
    });
  return { subject: sub(t.subject).replace(/\s{2,}/g, ' ').trim(), body: sub(t.body).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), missing };
}

export function templateFor(key: string): Template | null {
  return CLIENT_UPDATES[key] ?? CHASES[key] ?? null;
}
