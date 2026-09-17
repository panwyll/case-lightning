/**
 * THE ONE FILE THAT KNOWS LEAP'S URLS.
 *
 * LEAP's API reference (developer.leap.build → console.leap.build) sits behind
 * developer registration and app review; it is not public and could not be read from
 * the build environment. Everything below is therefore an ASSUMED shape, written to be
 * corrected in one place once the reference is open:
 *
 *   - hosts come from env (LEAP_AUTH_BASE_URL, LEAP_API_BASE_URL) — no host is invented;
 *   - paths are relative and live only here;
 *   - LEAP's raw JSON is normalised only in mapping.ts;
 *   - the mock server (mock.ts) serves exactly this map, so the HTTP client is exercised
 *     end to end today and the same tests re-run against the real thing.
 *
 * Confirm against the reference: [ ] OAuth authorize/token paths + PKCE requirement
 * [ ] x-api-key header name [ ] pagination params [ ] document download + multipart
 * upload [ ] task and file-note resources [ ] webhook subscription + signature header.
 */
export const LEAP_API_VERSION = 'v1';

export const LEAP_ENDPOINTS = {
  // OAuth 2.0 authorization-code flow (LEAP Developer knowledge base: "Authorization Code Flow").
  authorize: '/oauth/authorize',
  token: '/oauth/token',

  firm: `/api/${LEAP_API_VERSION}/firm`,
  matterTypes: `/api/${LEAP_API_VERSION}/mattertypes`,
  matters: `/api/${LEAP_API_VERSION}/matters`,
  matter: (id: string) => `/api/${LEAP_API_VERSION}/matters/${encodeURIComponent(id)}`,
  matterParties: (id: string) => `/api/${LEAP_API_VERSION}/matters/${encodeURIComponent(id)}/cards`,
  matterDocuments: (id: string) => `/api/${LEAP_API_VERSION}/matters/${encodeURIComponent(id)}/documents`,
  matterTasks: (id: string) => `/api/${LEAP_API_VERSION}/matters/${encodeURIComponent(id)}/tasks`,
  matterNotes: (id: string) => `/api/${LEAP_API_VERSION}/matters/${encodeURIComponent(id)}/notes`,
  card: (id: string) => `/api/${LEAP_API_VERSION}/cards/${encodeURIComponent(id)}`,
  document: (id: string) => `/api/${LEAP_API_VERSION}/documents/${encodeURIComponent(id)}`,
  documentDownload: (id: string) => `/api/${LEAP_API_VERSION}/documents/${encodeURIComponent(id)}/download`,
  task: (id: string) => `/api/${LEAP_API_VERSION}/tasks/${encodeURIComponent(id)}`,
  webhooks: `/api/${LEAP_API_VERSION}/webhooks`,
} as const;

/** Header carrying the app's API key on every request (LEAP Developer: "Security & API Credentials"). */
export const LEAP_API_KEY_HEADER = 'x-api-key';
/** Header LEAP signs webhook bodies with (assumed HMAC-SHA256 hex over the raw body). */
export const LEAP_WEBHOOK_SIGNATURE_HEADER = 'x-leap-signature';
/** Header carrying LEAP's delivery id for idempotency, when present. */
export const LEAP_WEBHOOK_DELIVERY_HEADER = 'x-leap-delivery';

/** Scopes we ask for. Least privilege for phase 0/1: read matters, cards, documents; write documents, tasks, notes. */
export const LEAP_SCOPES = ['matters:read', 'cards:read', 'documents:read', 'documents:write', 'tasks:write', 'notes:write', 'offline_access'];

/** Region → human label only. Hosts are configured, never derived, until the reference confirms them. */
export const LEAP_REGION_LABEL: Record<string, string> = { uk: 'United Kingdom', au: 'Australia', us: 'United States', ca: 'Canada', nz: 'New Zealand', ie: 'Ireland' };
