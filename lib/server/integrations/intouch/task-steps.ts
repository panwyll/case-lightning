/**
 * CONVEYi → InTouch: a step done in CONVEYi completes the firm's matching InTouch task, so nobody ticks it off twice
 * (docs/intouch-integration.md "Writing back"). InTouch's API can list a matter's tasks and complete one, nothing more.
 *
 * Each step is a CONVEYi event (or Mark Complete on that step). Its InTouch task is the one the firm mapped it to
 * (Tools → InTouch → Task Mapping, `intouch_connection.task_map`: exact task name, or 'none'), else the first open task
 * whose name reads as that step (`words`). Never a task already complete; never guessed when nothing matches.
 */
import type { InTouchTask } from './types';

export interface TaskStep {
  key: string;
  label: string;
  /** The events that mean this step is done. */
  events: string[];
  /** Mark Complete steps that mean the same. */
  manual?: string[];
  /** A task name that reads as this step, in a firm's own words. */
  words: RegExp;
  /** Words that mean a different step ("search results" is not "order searches"). */
  not?: RegExp;
}

export const TASK_STEPS: TaskStep[] = [
  { key: 'id_check', label: 'ID And AML Check Done', events: ['id_check_cleared', 'id_check_reviewed'], manual: ['id_check'], words: /\b(id|identity|aml|kyc|anti[- ]money)\b/i, not: /\bsource of (funds|wealth)\b/i },
  { key: 'source_of_funds', label: 'Source Of Funds Signed Off', events: ['proof_of_funds_reviewed'], manual: ['proof_of_funds'], words: /\b(source of (funds|wealth)|proof of funds|sof)\b/i },
  { key: 'searches_ordered', label: 'Searches Ordered', events: ['search_ordered'], words: /\bsearch(es)?\b.*\b(order|appl|submit|request)|\b(order|appl)\w*\b.*\bsearch/i },
  { key: 'searches_back', label: 'Search Results Received', events: ['search_cleared', 'search_reviewed'], manual: ['search'], words: /\bsearch(es)?\b.*\b(result|received|back|review)|\b(review|receiv)\w*\b.*\bsearch/i },
  { key: 'title', label: 'Title Checked', events: ['title_cleared', 'title_reviewed'], manual: ['title'], words: /\b(title|official cop(y|ies)|register)\b.*\b(check|review|investigat)|\b(review|investigat|check)\w*\b.*\btitle\b/i },
  { key: 'property_forms', label: 'Property Forms Received', events: ['property_forms_received'], manual: ['property_forms'], words: /\b(ta ?6|ta ?7|ta ?10|property information|fittings and contents|protocol forms)\b/i },
  { key: 'contract_pack', label: 'Contract Pack Sent', events: ['contract_pack_sent'], manual: ['contract_pack'], words: /\bcontract pack\b|\bdraft contract\b.*\bsent\b/i },
  { key: 'enquiries_raised', label: 'Enquiries Raised', events: ['enquiry_raised'], words: /\benquir(y|ies)\b.*\b(raise|sent|issue)|\b(raise|sent)\w*\b.*\benquir/i },
  { key: 'enquiries_answered', label: 'Enquiries Answered', events: ['enquiry_reply_cleared', 'enquiry_reply_reviewed'], manual: ['enquiries'], words: /\benquir(y|ies)\b.*\b(repl|answer|satisf|resolv)|\breplies to enquiries\b/i },
  { key: 'mortgage_offer', label: 'Mortgage Offer Received', events: ['mortgage_offer_cleared'], manual: ['mortgage'], words: /\bmortgage offer\b|\boffer of (loan|advance)\b/i },
  { key: 'report_on_title', label: 'Report On Title Sent', events: ['report_on_title_sent'], manual: ['report_on_title'], words: /\breport on title\b|\btitle report\b|\breport\b.*\bclient\b/i },
  { key: 'contract_signed', label: 'Contract Signed And Held', events: ['signed_contract_held'], words: /\bcontract\b.*\bsign|\bsigned contract\b/i },
  { key: 'deposit', label: 'Deposit Received', events: ['deposit_received'], manual: ['deposit'], words: /\bdeposit\b/i },
  { key: 'exchanged', label: 'Contracts Exchanged', events: ['contracts_exchanged'], words: /\bexchang(e|ed)\b/i, not: /\bready\b/i },
  { key: 'completion_statement', label: 'Completion Statement Sent', events: ['completion_statement_generated'], words: /\bcompletion statement\b|\bstatement of account\b/i },
  { key: 'completed', label: 'Completed', events: ['completion_confirmed'], words: /\bcomplet(ed|ion)\b/i, not: /\b(information|statement|date|ta ?13)\b/i },
  { key: 'sdlt', label: 'SDLT Return Filed', events: ['sdlt_submitted'], words: /\b(sdlt|stamp duty|ltt)\b/i },
  { key: 'registration_submitted', label: 'Land Registry Application Submitted', events: ['ap1_submitted'], words: /\b(ap1|land registry|registration)\b/i, not: /\b(complete|completed|confirm)\b/i },
  { key: 'registration_done', label: 'Registration Completed', events: ['ap1_confirmed'], words: /\b(registration|land registry)\b.*\b(complete|confirm)|\btitle updated\b/i },
];

/** The step an event (or a step marked complete by hand) finishes, if any. */
export function stepOf(type: string, payload: Record<string, unknown> = {}): TaskStep | null {
  if (type === 'step_completed_manually') {
    const step = String(payload.step ?? '').split(':')[0];
    return TASK_STEPS.find((t) => t.manual?.includes(step)) ?? null;
  }
  return TASK_STEPS.find((t) => t.events.includes(type)) ?? null;
}

/** Every event type that can finish a step. */
export const TASK_EVENT_TYPES = [...new Set([...TASK_STEPS.flatMap((t) => t.events), 'step_completed_manually'])];

/**
 * The open InTouch task this step completes: the firm's mapping (an exact task name, or 'none' for never), else the
 * first open task whose name reads as the step. Null when nothing fits: nothing is completed on a guess.
 */
export function taskForStep(step: TaskStep, tasks: InTouchTask[], map: Record<string, string> = {}): InTouchTask | null {
  const open = tasks.filter((t) => !t.completed && t.name);
  const chosen = map[step.key];
  if (chosen === 'none') return null;
  if (chosen) return open.find((t) => t.name.trim().toLowerCase() === chosen.trim().toLowerCase()) ?? null;
  return open.find((t) => step.words.test(t.name) && !(step.not && step.not.test(t.name))) ?? null;
}
