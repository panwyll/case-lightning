/**
 * THE ONE FILE THAT KNOWS INTOUCH'S URLS.
 *
 * InTouch is where a conveyancing firm's CLIENTS live: the online onboarding pack, the
 * identity checks, the property information forms the seller fills in, and the portal
 * where the client and the estate agent watch the case move. CONVEYi is where the case
 * itself is reasoned about. The two meet here.
 *
 * As with LEAP (docs/leap-integration.md), InTouch's API reference is behind developer
 * registration and could not be read from the build environment. Everything below is an
 * ASSUMED shape, written so it can be corrected in ONE place:
 *
 *   - hosts come from env (INTOUCH_API_BASE_URL, INTOUCH_AUTH_BASE_URL) — nothing invented;
 *   - paths are relative and live only here;
 *   - InTouch's raw JSON is normalised only in mapping.ts, which reads defensively from
 *     several candidate field names;
 *   - mock.ts serves exactly this map, so the client is exercised end to end today and
 *     the same tests re-run against the real thing.
 *
 * Confirm against the reference:
 *   [ ] OAuth client-credentials vs authorization-code   [ ] token path and audience
 *   [ ] API key header name                              [ ] case/instruction resource path
 *   [ ] identity-check result shape and outcome values   [ ] form types and their codes
 *   [ ] document download (redirect vs bytes)            [ ] milestone vocabulary
 *   [ ] webhook event names + signature header/scheme    [ ] pagination parameters
 */
export const INTOUCH_API_VERSION = 'v1';

const V = `/api/${INTOUCH_API_VERSION}`;

export const INTOUCH_ENDPOINTS = {
  // OAuth 2.0. InTouch is a server-to-server integration for the firm, so the default is
  // the client-credentials grant with the firm's own client id/secret; the
  // authorization-code path is kept for the case where InTouch requires a user to consent.
  token: '/oauth/token',
  authorize: '/oauth/authorize',

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

  webhooks: `${V}/webhooks`,
} as const;

/** Sent on every request alongside the bearer token, when the firm has been issued one. */
export const INTOUCH_API_KEY_HEADER = 'x-api-key';
/** Assumed HMAC-SHA256 hex over the raw body. */
export const INTOUCH_WEBHOOK_SIGNATURE_HEADER = 'x-intouch-signature';
/** Delivery id, for idempotency, when present. */
export const INTOUCH_WEBHOOK_DELIVERY_HEADER = 'x-intouch-delivery';

/** Least privilege: read what the client produced, write milestones and requests back. */
export const INTOUCH_SCOPES = ['cases:read', 'parties:read', 'documents:read', 'identity:read', 'forms:read', 'milestones:write', 'requests:write'];

/**
 * The webhook events we subscribe to. Each is a POINTER only — the handler re-reads the
 * resource from InTouch rather than trusting the payload, exactly as the LEAP webhook does.
 */
export const INTOUCH_WEBHOOK_EVENTS = [
  'case.created',
  'case.updated',
  'identity_check.completed',
  'form.completed',
  'document.uploaded',
] as const;
export type InTouchWebhookEventName = (typeof INTOUCH_WEBHOOK_EVENTS)[number];

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
