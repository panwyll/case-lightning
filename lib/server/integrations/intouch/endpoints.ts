/**
 * THE ONE FILE THAT KNOWS INTOUCH'S URLS.
 *
 * InTouch is where a conveyancing firm's CLIENTS live: the online onboarding pack, the
 * identity checks, the property information forms the seller fills in, and the portal
 * where the client and the estate agent watch the case move. CONVEYi is where the case
 * itself is reasoned about. The two meet here.
 *
 * From InTouch's "Public Customer Matter API" reference (Swagger 2.0, apiCustomerPublic),
 * as supplied by an InTouch firm (docs/intouch-integration.md):
 *   - base https://go.intouchapp.co.uk, HTTPS only;
 *   - a static API key the firm generates in InTouch API Management > Keys, in the
 *     `x-intouch-o-token` header. No OAuth;
 *   - every response is { success, message, errors[], additionalData, data };
 *   - matters are read from a paged list (each with address, primary client, fee earner,
 *     state, template); single fields by InTouch "data marker" (e.g. matter.reference);
 *   - a matter's tasks can be listed and completed (that is how the client portal moves);
 *   - a matter's folder can be listed, downloaded from (a download URL), uploaded to, and
 *     emails, notes and phone calls filed in it;
 *   - webhooks (Matter State Change, Task State Change, Form Completion) are set up by the
 *     firm in InTouch API Management, not by API, and are not in the definition.
 *
 * What the API does NOT have, so the connector does not pretend to: identity checks,
 * form answers, parties beyond the primary client, a "changed since" filter, or a
 * milestone resource. ID reports and completed forms arrive as files in the matter's
 * folder and go through the ordinary document reading; the portal moves by completing
 * the InTouch task for the milestone.
 *
 * Still to confirm on a live account:
 *   [ ] list paging starts at page 1                     [ ] orderBy accepts "lastUpdated"
 *   [ ] matter `state` values (quote / live / complete…)  [ ] template names → purchase/sale
 *   [ ] the upload body (multipart "file" is assumed)     [ ] folder item `type` values
 *   [ ] a matter guid in each webhook's `data`
 */
export const INTOUCH_DEFAULT_BASE_URL = 'https://go.intouchapp.co.uk';

const V = '/api/v2/public';
const m = (guid: string) => `${V}/matters/${encodeURIComponent(guid)}`;

export const INTOUCH_ENDPOINTS = {
  /** GET ?page&pageSize&orderBy&orderByDirection&where&query → { matters: Matter[] } */
  matters: `${V}/matters/list`,
  /** GET ?fields=… (repeatable data markers) → { [field]: { name, typeName, value } } */
  matterFields: (guid: string) => m(guid),
  /** POST { data: { marker: value } } → { matterGuid, matterLink } (create or update). */
  saveMatter: `${V}/matters`,
  /** GET ?page → { tasks: MatterTask[] } */
  tasks: (guid: string) => `${m(guid)}/tasks`,
  /** POST → no data. */
  completeTask: (taskGuid: string) => `${V}/mattertasks/${encodeURIComponent(taskGuid)}/complete`,
  /** GET ?page&pageSize&orderBy&orderByDirection → { items: MatterFolderItemPublicModel[] } */
  folder: (guid: string) => `${m(guid)}/folder/list`,
  /** GET → { guid, downloadUrl } */
  downloadUrl: (guid: string, itemGuid: string) => `${m(guid)}/folder/${encodeURIComponent(itemGuid)}/download-url`,
  /** POST ?overwrite&feeEarnerReview&label (repeatable), the file in the body. */
  uploadFile: (guid: string) => `${m(guid)}/files`,
  /** POST MatterEmailApiRequest → { matterEmailGuid }. Files a record; does not send. */
  fileEmail: (guid: string) => `${m(guid)}/folder/emails`,
  /** POST MatterNoteApiRequest → { matterNoteGuid } */
  fileNote: (guid: string) => `${m(guid)}/folder/notes`,
} as const;

/** The firm's API key rides every request in this header (documented). */
export const INTOUCH_API_TOKEN_HEADER = 'x-intouch-o-token';

/**
 * The webhook events InTouch documents, in normalised form (see normaliseInTouchEvent).
 * The firm ticks them when it adds our URL in InTouch. Each is a POINTER only — the
 * handler re-reads the matter from InTouch rather than trusting the payload.
 */
export const INTOUCH_WEBHOOK_EVENTS = ['form_completion', 'matter_state_change', 'task_state_change'] as const;
export type InTouchWebhookEventName = (typeof INTOUCH_WEBHOOK_EVENTS)[number];

/** "Form_Completion", "Matter State Change", "task-state-change" → "form_completion" … */
export function normaliseInTouchEvent(v: unknown): string {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * The forms a client completes in InTouch, and the engine's own name for each. A completed
 * form arrives as a file in the matter's folder; its name is matched here.
 */
export const INTOUCH_FORM_CODES: Record<string, string> = {
  ta6: 'TA6',
  ta7: 'TA7',
  ta10: 'TA10',
  ta13: 'TA13',
  lpe1: 'LPE1',
  property_information: 'TA6',
  leasehold_information: 'TA7',
  fittings_and_contents: 'TA10',
  completion_information: 'TA13',
  leasehold_enquiries: 'LPE1',
};

/**
 * The milestones the client and the estate agent see. The engine's lifecycle is richer
 * than this on purpose: a client does not need "contract review" and "pre-exchange" as
 * separate facts, they need to know whether we are on track. Mapping lives in mapping.ts;
 * each is pushed by completing the InTouch task whose name matches it.
 */
export const INTOUCH_MILESTONES = [
  'instructed',
  'searches_ordered',
  'enquiries_raised',
  'report_sent',
  'ready_to_exchange',
  'exchanged',
  'completed',
] as const;
export type InTouchMilestone = (typeof INTOUCH_MILESTONES)[number];

/** Words for a milestone, for the case note when no InTouch task matches it. */
export const MILESTONE_WORDS: Record<InTouchMilestone, string> = {
  instructed: 'Instructed',
  searches_ordered: 'Searches ordered',
  enquiries_raised: 'Enquiries raised',
  report_sent: 'Report on title sent',
  ready_to_exchange: 'Ready to exchange',
  exchanged: 'Contracts exchanged',
  completed: 'Completed',
};
