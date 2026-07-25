// Shared constants for the assist UI — the conveyancing stage model, the task
// heuristics and the reply-flow busy labels, used by both the taskpane and the web inbox.
export const REPLY_BUSY_CREATE = 'Writing the reply into Outlook';
export const REPLY_BUSY_REGEN = 'Updating the reply in Outlook';
export const REPLY_BUSY_SEND = 'Sending the reply';

export const STAGES: Array<[string, string]> = [
  ['INSTRUCTION', '1 · Instruction'],
  ['CONTRACT_PACK', '2 · Contract pack'],
  ['SEARCHES_ENQUIRIES', '3 · Searches & enquiries'],
  ['REVIEW_SIGNING', '4 · Review & signing'],
  ['EXCHANGE', '5 · Exchange'],
  ['COMPLETION', '6 · Completion'],
  ['POST_COMPLETION', '7 · Post-completion'],
];
// Human stage label without the ordinal prefix (e.g. "Searches & enquiries").
export const stageLabel = (s: string): string => (STAGES.find(([v]) => v === s)?.[1] ?? s).replace(/^\d+\s·\s/, '');

// Backstop for pre-existing / mis-classified data: an item where we're waiting on another
// party ("Client to provide…", "Awaiting mortgage offer") is a status we chase, not our task.
// Keeps only the firm's own actions.
export const isWaitingOnOthers = (s: string): boolean => {
  const t = (s ?? '').trim().toLowerCase();
  if (/^(firm|we |us |our |conveyancer|fee earner)/.test(t)) return false; // explicitly ours
  if (/^(await|awaiting|pending)\b/.test(t)) return true;
  return /^(the )?(client|buyer|seller|purchaser|vendor|applicant|borrower|lender|bank|building society|estate agent|agent|other side|counterpart|third part)[a-z' ]*\bto\b/.test(t);
};

// Which side of the transaction we act for — frames the stage model and the
// drafting AI (so it doesn't assume we're always the buyer).
export const TRACKS: Array<[string, string]> = [
  ['PURCHASE', 'Purchase (acting for buyer)'],
  ['SALE', 'Sale (acting for seller)'],
  ['REMORTGAGE', 'Remortgage (acting for borrower)'],
];
export const STATUS_FLAGS: Array<[string, string]> = [
  ['ON_TRACK', 'On track'],
  ['NEEDS_ATTENTION', 'Needs attention'],
  ['BLOCKED', 'Blocked'],
];

// Local HH:MM for a scheduled-send timestamp (e.g. "14:35").
export function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
