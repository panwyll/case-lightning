import { SignJWT, jwtVerify } from 'jose';

/**
 * Three ways in, all cookie-based and all signed with the same secret:
 *
 *   site   — the shared password from the landing page. Unlocks the public site.
 *   guest  — arriving on /g/<slug>?k=<code> with a valid code. Unlocks the
 *            public site too, so guests never see a password prompt.
 *   admin  — the admin password. Unlocks /admin and preview of draft pages.
 *
 * Guest codes are derived from GUEST_LINK_SECRET rather than stored, so no
 * personal link is ever committed to the repository.
 *
 * Everything here runs in both the Edge (middleware) and Node runtimes, so it
 * uses `jose` and Web Crypto only — no `node:crypto`.
 */

export const COOKIE = {
  site: 'wd_site',
  admin: 'wd_admin',
  guest: 'wd_guest',
} as const;

export const SESSION_MAX_AGE = 60 * 60 * 24 * 60; // 60 days

export type Session =
  | { kind: 'site' }
  | { kind: 'admin' }
  | { kind: 'guest'; slug: string };

const DEV_FALLBACKS: Record<string, string> = {
  SESSION_SECRET: 'dev-only-session-secret-change-me-please-0000000000',
  GUEST_LINK_SECRET: 'dev-only-guest-link-secret-change-me-please-000000',
  SITE_PASSWORD: 'letmein',
  ADMIN_PASSWORD: 'admin',
};

const warned = new Set<string>();

function env(name: keyof typeof DEV_FALLBACKS): string {
  const value = process.env[name];
  if (value && value.length > 0) return value;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `${name} is not set. Set it in your hosting environment before deploying — ` +
        `see .env.example.`,
    );
  }
  if (!warned.has(name)) {
    warned.add(name);
    // eslint-disable-next-line no-console
    console.warn(`[auth] ${name} not set; using an insecure development default.`);
  }
  return DEV_FALLBACKS[name];
}

const encoder = new TextEncoder();

function sessionKey(): Uint8Array {
  return encoder.encode(env('SESSION_SECRET'));
}

export async function createToken(session: Session): Promise<string> {
  return new SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(sessionKey());
}

export async function readToken(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionKey());
    if (payload.kind === 'site' || payload.kind === 'admin') return { kind: payload.kind };
    if (payload.kind === 'guest' && typeof payload.slug === 'string') {
      return { kind: 'guest', slug: payload.slug };
    }
    return null;
  } catch {
    return null;
  }
}

/** Crockford-ish base32 without vowels, so codes cannot spell anything unfortunate. */
const ALPHABET = '0123456789BCDFGHJKLMNPQRSTVWXZ';

/**
 * The personal access code for a guest. Deterministic: the same slug and
 * secret always produce the same code, so links stay valid forever. Rotate
 * GUEST_LINK_SECRET to invalidate every link at once.
 */
export async function guestCode(slug: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env('GUEST_LINK_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(slug)));
  let code = '';
  for (let i = 0; i < 8; i++) code += ALPHABET[sig[i] % ALPHABET.length];
  return code;
}

/** Compares without leaking length or position through timing. */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function verifyGuestCode(
  slug: string,
  candidate: string | null | undefined,
  override?: string,
): Promise<boolean> {
  if (!candidate) return false;
  const expected = override ?? (await guestCode(slug));
  return safeEqual(candidate.trim().toUpperCase(), expected.toUpperCase());
}

export function checkSitePassword(input: string): boolean {
  return safeEqual(input, env('SITE_PASSWORD'));
}

export function checkAdminPassword(input: string): boolean {
  return safeEqual(input, env('ADMIN_PASSWORD'));
}

export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_MAX_AGE,
  secure: process.env.NODE_ENV === 'production',
} as const;

/** Absolute origin, used when printing personal links from scripts. */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  return 'http://localhost:3000';
}

export function personalLink(slug: string, code: string): string {
  return `${siteUrl()}/g/${slug}?k=${code}`;
}
