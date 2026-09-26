/**
 * Every in-app URL, in one place.
 *
 * The conveyancer's app lives under /conveyi, alongside the product's own marketing
 * pages — CONVEYi is the product, so its screens carry its name. These used to sit at
 * the root (/cases, /decisions/…); next.config.ts permanently redirects the old paths,
 * and nothing should hardcode either shape again. Import from here instead — it is a
 * plain module with no server dependencies, so middleware, server code and client
 * components can all use it.
 */
export const APP_BASE = '/conveyi';

export const paths = {
  // ── the conveyancer's app (behind sign-in) ──
  cases: `${APP_BASE}/cases`,
  /** The one work list: tasks, drafts, chases, decisions. */
  tasks: `${APP_BASE}/admin?tab=mywork`,
  integrations: `${APP_BASE}/integrations`,
  email: `${APP_BASE}/email`,
  decision: (eventId: string) => `${APP_BASE}/decisions/${eventId}`,
  /** Every open case as a list, to pick one from. */
  matters: `${APP_BASE}/matters`,
  /** The matter, as a person reads it: stages, steps, then the case data. */
  matter: (matterId: string) => `${APP_BASE}/matters/${matterId}`,
  /** The engine's own view of the matter: workstreams, decisions, timeline, diagnostics. */
  engineMatter: (matterId: string) => `${APP_BASE}/engine/${matterId}`,
  matterShadow: (matterId: string) => `${APP_BASE}/engine/${matterId}/shadow`,
  machineMap: `${APP_BASE}/engine/map`,
  /** Trust levels per engine action (admins). */
  shadowQueue: `${APP_BASE}/engine/shadow`,
  account: `${APP_BASE}/account`,
  admin: `${APP_BASE}/admin`,
  leap: `${APP_BASE}/integrations/leap`,

  // ── getting in ──
  signIn: `${APP_BASE}/sign-in`,
  /** Where an unauthenticated visitor is sent, remembering where they were headed. */
  signInTo: (next?: string | null) => (next && next.startsWith('/') ? `${APP_BASE}/sign-in?next=${encodeURIComponent(next)}` : `${APP_BASE}/sign-in`),
  /**
   * Where a person lands once signed in: their caseload — every open matter the firm has,
   * whether or not the engine is following it yet. Not Today, which only knows tracked ones.
   */
  afterSignIn: `${APP_BASE}/cases`,

  // ── public: marketing, signup, and the client-facing form ──
  home: '/',
  product: APP_BASE,
  getStarted: '/get-started',
  support: `${APP_BASE}/support`,
  proofOfFunds: (token: string) => `/pof/${token}`,
} as const;

/**
 * The paths middleware guards. Everything under /conveyi is public marketing EXCEPT
 * these — so the list is explicit rather than a prefix match, and a new marketing page
 * can never accidentally end up behind the sign-in wall.
 */
export const PROTECTED_SEGMENTS = ['cases', 'email', 'matters', 'decisions', 'engine', 'account', 'admin', 'integrations'] as const;

export function isProtectedPath(pathname: string): boolean {
  if (!pathname.startsWith(`${APP_BASE}/`)) return false;
  const seg = pathname.slice(APP_BASE.length + 1).split('/')[0];
  return (PROTECTED_SEGMENTS as readonly string[]).includes(seg);
}
