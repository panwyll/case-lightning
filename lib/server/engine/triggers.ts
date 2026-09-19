/**
 * Every way something reaches the engine, for both backends. This is the registry the
 * machine map (/engine/map) and the docs draw from, and the checklist for "what could
 * fire on this matter". A trigger never decides anything: it either files a document
 * (→ ingest → classify → route → sub-flow), issues a command (a person or a timer), or
 * syncs the mirror (LEAP). The engine's answer is the same whichever door it came in.
 */
export type TriggerBackend = 'native' | 'leap' | 'both';
export type TriggerSource = 'webhook' | 'poll' | 'email' | 'file' | 'user' | 'timer' | 'provider' | 'messaging';
export type TriggerFeeds = 'ingest' | 'command' | 'sync' | 'comms';

export interface TriggerSpec {
  id: string;
  backend: TriggerBackend;
  source: TriggerSource;
  /** What it does when it fires. */
  feeds: TriggerFeeds;
  label: string;
  description: string;
  /** Where it lands in the code (route or module). */
  entry: string;
  implemented: boolean;
  /** Which sub-flows / commands it can reach. */
  reaches: string[];
  notes?: string;
}

export const TRIGGERS: TriggerSpec[] = [
  // ── our own app (CaseLightning) ──
  { id: 'native.email_attachment', backend: 'native', source: 'email', feeds: 'ingest', label: 'Email attachment filed to the matter', description: 'An attachment on a matched thread is saved into the matter (Graph) and handed to the engine: classified, routed to a sub-flow or reported for a person to file.', entry: 'lib/server/files.ts → ingestFiledDocument', implemented: true, reaches: ['search', 'enquiry', 'mortgage', 'title', 'id_check'] },
  { id: 'native.onedrive_upload', backend: 'native', source: 'file', feeds: 'ingest', label: 'File dropped in the matter folder (OneDrive)', description: 'The matter folder is scanned (files/live, files/process); new documents go through the same ingest.', entry: 'app/api/v1/matters/[matterId]/files/process', implemented: true, reaches: ['search', 'enquiry', 'mortgage', 'title', 'id_check'] },
  { id: 'native.manual_upload', backend: 'native', source: 'user', feeds: 'ingest', label: 'Upload from the engine panel', description: 'A person uploads a PDF and (optionally) says what it is; an explicit role bypasses the classifier.', entry: 'app/api/v1/matters/[matterId]/engine/upload', implemented: true, reaches: ['search', 'enquiry', 'mortgage', 'title', 'id_check'] },
  { id: 'native.ingest_route', backend: 'native', source: 'user', feeds: 'ingest', label: 'File an existing document with an explicit role', description: 'For the reply the classifier could not match, or a search of an unusual type.', entry: 'app/api/v1/matters/[matterId]/engine/ingest', implemented: true, reaches: ['search', 'enquiry', 'mortgage', 'title', 'id_check'] },
  { id: 'both.infotrack_webhook', backend: 'both', source: 'provider', feeds: 'ingest', label: 'InfoTrack result returned', description: 'Signed webhook; the order record (ours) says which matter and sub-flow; the result is downloaded, filed and routed.', entry: 'app/api/v1/integrations/infotrack/webhook', implemented: true, reaches: ['search', 'title', 'id_check'] },
  { id: 'native.whatsapp_inbound', backend: 'native', source: 'messaging', feeds: 'comms', label: 'Client message (WhatsApp)', description: 'Guarded Q&A: an FAQ answer goes back automatically; anything else is routed to the handler. Never a command.', entry: 'app/api/v1/comms/whatsapp/webhook', implemented: true, reaches: [] },
  { id: 'both.user_command', backend: 'both', source: 'user', feeds: 'command', label: 'A person records what happened', description: 'Enrol, raise an enquiry, deposit received, exchange, completion, SDLT/AP1, bank details, abandonment, date changes, notices, requisitions, corrections — from the engine panel, the decision panel or the Outlook taskpane.', entry: 'app/api/v1/matters/[matterId]/engine (POST)', implemented: true, reaches: ['USER_COMMANDS'] },
  { id: 'both.decision_panel', backend: 'both', source: 'user', feeds: 'command', label: 'Decision resolved in the panel', description: 'Open the source, engage with it, choose an option with a reason. Resolves the sub-flow and may raise a follow-up enquiry or an escalation.', entry: 'app/api/v1/decisions/[eventId]/resolve', implemented: true, reaches: ['resolve_decision'] },
  { id: 'both.cron_engine_tick', backend: 'both', source: 'timer', feeds: 'command', label: 'Working-day timer sweep', description: 'Chases and escalations for open waits (searches, enquiries, ID, funds, registration) and deadlines we owe (offer expiry, SDLT, notice to complete, requisition reply).', entry: 'app/api/v1/cron/engine-tick', implemented: true, reaches: ['record_chase', 'raise_escalation', 'raise_deadline_escalation'] },
  { id: 'native.outlook_addin', backend: 'native', source: 'user', feeds: 'command', label: 'Outlook add-in taskpane', description: 'The decision feed inside Outlook; the same routes as the panel.', entry: 'app/addin/taskpane', implemented: true, reaches: ['resolve_decision'] },
  { id: 'native.matter_reassigned', backend: 'native', source: 'user', feeds: 'command', label: 'Matter reassigned in the app', description: 'Assignment lives on the matter row; the change is put on the engine log as handler_changed.', entry: 'lib/server/backends/native.ts', implemented: true, reaches: ['record_handler_change'] },
  // ── LEAP as the backend ──
  { id: 'leap.webhook_document', backend: 'leap', source: 'webhook', feeds: 'ingest', label: 'Document filed in LEAP', description: 'LEAP posts a pointer; we re-read the document from LEAP, mirror it (bytes stay in LEAP) and hand it to the engine — with LEAP\'s folder and file name as a routing prior. Out-of-order documents wait as PENDING.', entry: 'app/api/v1/integrations/leap/webhook', implemented: true, reaches: ['search', 'enquiry', 'mortgage', 'title', 'id_check'], notes: 'Event names and signature scheme to confirm against the LEAP reference.' },
  { id: 'leap.webhook_matter', backend: 'leap', source: 'webhook', feeds: 'sync', label: 'Matter created / updated / closed in LEAP', description: 'Mirror the matter, its parties and key dates; enrol a new freehold purchase (shadow first); a closed matter closes the mirror.', entry: 'app/api/v1/integrations/leap/webhook', implemented: true, reaches: ['enrol', 'record_handler_change', 'set_target_dates'] },
  { id: 'leap.webhook_card', backend: 'leap', source: 'webhook', feeds: 'sync', label: 'Card (party) updated in LEAP', description: 'Refresh the matter\'s parties: client contact for comms, lender presence, the other side\'s solicitor for the counterparty resolver.', entry: 'app/api/v1/integrations/leap/webhook', implemented: true, reaches: [] },
  { id: 'leap.poll_matters', backend: 'leap', source: 'poll', feeds: 'sync', label: 'Polling sync — matters', description: 'Matters changed since the watermark; the safety net under webhooks.', entry: 'app/api/v1/cron/leap-sync', implemented: true, reaches: ['enrol'] },
  { id: 'leap.poll_documents', backend: 'leap', source: 'poll', feeds: 'ingest', label: 'Polling sync — documents on every enrolled matter', description: 'Every enrolled matter\'s documents from its own watermark (a new document does not necessarily change the matter\'s modified date), plus retries of PENDING ones.', entry: 'app/api/v1/cron/leap-sync', implemented: true, reaches: ['search', 'enquiry', 'mortgage', 'title', 'id_check'] },
  { id: 'leap.task_completed', backend: 'leap', source: 'webhook', feeds: 'command', label: 'CONVEYi task ticked off in LEAP', description: 'Phase 2 candidate: a handler completing our task in LEAP could open the decision panel link, never resolve the decision (the source-and-engagement gate lives in the panel).', entry: '—', implemented: false, reaches: [], notes: 'Deliberately not a resolution path.' },
  { id: 'leap.calendar_key_date', backend: 'leap', source: 'webhook', feeds: 'command', label: 'Key date changed in LEAP (exchange / completion)', description: 'Phase 2: LEAP calendar / matter key dates → set_target_dates or change_completion_date on the log.', entry: '—', implemented: false, reaches: ['set_target_dates', 'change_completion_date'], notes: 'Today the sync updates the mirror\'s dates; the engine command is not yet issued automatically.' },
  { id: 'leap.correspondence_filed', backend: 'leap', source: 'webhook', feeds: 'ingest', label: 'Email / letter filed to the LEAP matter', description: 'Phase 2: LEAP correspondence records (inbound emails filed to the matter) as an ingest source for enquiry replies and bank-details changes.', entry: '—', implemented: false, reaches: ['enquiry', 'record_bank_details'], notes: 'Needs LEAP\'s correspondence resource from the reference.' },
];

export const TRIGGERS_BY_BACKEND = (backend: 'native' | 'leap'): TriggerSpec[] => TRIGGERS.filter((t) => t.backend === backend || t.backend === 'both');
