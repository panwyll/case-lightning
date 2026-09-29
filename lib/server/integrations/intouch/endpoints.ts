/**
 * THE ONE FILE THAT KNOWS INTOUCH'S URLS.
 *
 * InTouch is where a conveyancing firm's CLIENTS live: the online onboarding pack, the
 * identity checks, the property information forms the seller fills in, and the portal
 * where the client and the estate agent watch the case move. CONVEYi is where the case
 * itself is reasoned about. The two meet here.
 *
 * What InTouch's public help centre (help.intouch.cloud) documents, and so is KNOWN:
 *   - auth is a static API key the firm generates in InTouch (Settings > API > Keys), sent
 *     in the `x-intouch-o-token` header over HTTPS. There is no OAuth;
 *   - webhooks are set up by the firm IN THE INTOUCH UI (Settings > API > Webhooks, "Add
 *     Webhook" with a URL). There is no API to subscribe;
 *   - the webhook events are Form Completion, Matter State Change and Task State Change,
 *     in a flat envelope: { "event": "Form_Completion", "triggered.by.name", "triggered.by.email",
 *     "timestamp", "data": {…} } (keys with literal dots). Deliveries are not signed;
 *     they are retried at +10m, +60m, +180m and +24h until a 2xx. Dates are UTC ISO 8601;
 *   - clients should parse permissively (ignore unknown attributes); there is no uptime
 *     guarantee, so the client retries;
 *   - the API and webhooks are on the Premium/Enterprise plans only.
 *
 * The full endpoint reference lives inside the customer's InTouch account and is not
 * public. So the base URL and every resource PATH below are still ASSUMED, written so
 * they can be corrected in ONE place:
 *
 *   - the host comes from the firm's settings (or INTOUCH_API_BASE_URL) — nothing invented;
 *   - paths are relative and live only here;
 *   - InTouch's raw JSON is normalised only in mapping.ts, which reads defensively from
 *     several candidate field names;
 *   - mock.ts serves exactly this map, so the client is exercised end to end today and
 *     the same tests re-run against the real thing.
 *
 * Checklist:
 *   [x] auth: API key in `x-intouch-o-token`             [x] no OAuth
 *   [x] webhook events (three)                           [x] webhook payload envelope
 *   [x] webhooks configured in the InTouch UI            [x] webhooks are not signed
 *   [ ] base URL                                          [ ] case/matter resource path
 *   [ ] party, form, ID-check, document paths            [ ] pagination parameters
 *   [ ] identity-check result shape and outcome values   [ ] form types and their codes
 *   [ ] document download (redirect vs bytes)            [ ] milestone write-back
 *   [ ] a case id in each webhook's `data`
 */
export const INTOUCH_API_VERSION = 'v1';

const V = `/api/${INTOUCH_API_VERSION}`;

export const INTOUCH_ENDPOINTS = {
  /** Who we are connected as — used to show the firm's name after connecting. */
  account: `${V}/account`,

  /** Cases (InTouch calls an engaged quote an "instruction"; the resource is assumed "cases"). */
  cases: `${V}/cases`,
  case: (id: string) => `${V}/cases/${encodeURIComponent(id)}`,
  caseParties: (id: string) => `${V}/cases/${encodeURIComponent(id)}/parties`,
  caseDocuments: (id: string) => `${V}/cases/${encodeURIComponent(id)}/documents`,
  caseForms: (id: string) => `${V}/cases/${encodeURIComponent(id)}/forms`,
  caseIdentityChecks: (id: string) => `${V}/cases/${encodeURIComponent(id)}/identity-checks`,
  /** Push the true state of the case to the client/agent portal. */
  caseMilestones: (id: string) => `${V}/cases/${encodeURIComponent(id)}/milestones`,
  /** Ask InTouch to start an identity check for a party (when the firm drives it from here). */
  requestIdentityCheck: (id: string) => `${V}/cases/${encodeURIComponent(id)}/identity-checks`,
  /** Ask InTouch to send the client a form to complete. */
  requestForm: (id: string) => `${V}/cases/${encodeURIComponent(id)}/forms`,

  document: (id: string) => `${V}/documents/${encodeURIComponent(id)}`,
  documentDownload: (id: string) => `${V}/documents/${encodeURIComponent(id)}/download`,
  identityCheck: (id: string) => `${V}/identity-checks/${encodeURIComponent(id)}`,
  form: (id: string) => `${V}/forms/${encodeURIComponent(id)}`,
} as const;

/** The firm's API key rides every request in this header (documented). */
export const INTOUCH_API_TOKEN_HEADER = 'x-intouch-o-token';

/**
 * The webhook events InTouch documents, in normalised form (see normaliseInTouchEvent).
 * The firm ticks them when it adds our URL in InTouch. Each is a POINTER only — the
 * handler re-reads the case from InTouch rather than trusting the payload.
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
 * The forms a client completes in InTouch, and the engine's own name for each.
 * The engine speaks in form codes (TA6, TA7, TA10, TA13, LPE1); InTouch may name them
 * differently, so the translation lives here and nowhere else.
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
 * separate facts, they need to know whether we are on track. Mapping lives in mapping.ts.
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
