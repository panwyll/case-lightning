/**
 * A firm's own address for its clients' pages (portal.theirfirm.co.uk, migration 137). It serves only the pages a
 * client opens from a link (the portal, secure files, the proof-of-funds form) and the calls those pages make; the
 * rest of the site is not there. Plain module: middleware, server code and pages all use it.
 */

/** Paths a client's link opens, and the calls those pages make. */
export const CLIENT_PATHS = /^\/(portal|f|pof)\/|^\/api\/v1\/(portal|f|pof)\//;
/** Files every page needs (the build's scripts and styles, fonts). */
export const ASSET_PATHS = /^\/(_next|__nextjs)|^\/favicon|\.(svg|png|ico|webp|woff2?)$/;

/** Ours, not a firm's: the app's own address, our domains, Vercel's preview addresses and local development. */
export function isOwnHost(host: string, appUrl: string | undefined): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  let app = '';
  try { app = appUrl ? new URL(appUrl).hostname.toLowerCase() : ''; } catch { app = ''; }
  return h === app || h === 'localhost' || h === '127.0.0.1' || h.endsWith('.vercel.app') || h === 'caselightning.co.uk' || h.endsWith('.caselightning.co.uk');
}

/** A hostname as typed ("https://Portal.Firm.co.uk/") made plain ("portal.firm.co.uk"), or null when it is not one. */
export function plainHost(input: string): string | null {
  const h = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  return /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) ? h : null;
}
