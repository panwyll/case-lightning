/**
 * Passwordless sign-in by emailed one-time link (docs/sign-in.md).
 *
 * The product no longer assumes the firm lives in Microsoft 365 — a LEAP firm, a locum,
 * anyone without a work Microsoft account still has to be able to get in. So: type your
 * address, get a link, click it, you are signed in.
 *
 * The rules that make that safe:
 *   • only the token's SHA-256 is stored — the link in the email is the only secret, and
 *     a leaked row cannot be replayed into a session;
 *   • single use and short-lived (15 minutes), enforced when the link is redeemed;
 *   • it signs in an EXISTING user only. A stranger's address gets the same answer as a
 *     real one and no email, so this cannot be used to find out who banks with whom;
 *   • rate-limited per address and per IP, by counting recent rows rather than by
 *     keeping any state in memory (there is more than one serverless instance).
 *
 * New firms still arrive through Microsoft sign-in, which provisions the tenant; a
 * colleague joins by invite (invites.ts). This is the way back IN, not a way to sign up.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { Resend } from 'resend';
import { query, queryOne, runAsSystem } from './db';
import { config } from './config';
import { paths } from '../paths';

/** How long a link lives. Long enough to walk to another device, short enough to matter. */
const TTL_MINUTES = 15;
/** Per address, and per IP, in the window below. */
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 20;
const WINDOW_MINUTES = 15;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface LinkRequestResult {
  /** Always true to the caller: we never say whether the address is one we know. */
  accepted: true;
  /** Set only in development, so the flow can be walked without a mail provider. */
  devLink?: string;
}

/**
 * Issue a link for an address, if we know it. Returns the same shape either way — the
 * caller must not branch on whether a user was found, and must not say so to the browser.
 */
export async function requestSignInLink(emailRaw: string, opts: { next?: string | null; ip?: string | null } = {}): Promise<LinkRequestResult> {
  const email = (emailRaw ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });

  return runAsSystem(async () => {
    // Rate limit first, so an attacker cannot use the "is there a user" timing either.
    const recent = await queryOne<{ by_email: string; by_ip: string }>(
      `select
         count(*) filter (where lower(email) = $1) as by_email,
         count(*) filter (where $2::text is not null and requested_ip = $2) as by_ip
       from sign_in_link where created_at > now() - ($3 || ' minutes')::interval`,
      [email, opts.ip ?? null, String(WINDOW_MINUTES)]
    );
    if (Number(recent?.by_email ?? 0) >= MAX_PER_EMAIL || Number(recent?.by_ip ?? 0) >= MAX_PER_IP) {
      throw Object.assign(new Error('Too many sign-in links requested. Try again in a few minutes.'), { status: 429 });
    }

    const user = await queryOne<{ id: string; email: string; display_name: string | null }>(
      `select id, email, display_name from app_user where lower(email) = $1 limit 1`,
      [email]
    ).catch(() => null);
    // No user: stop here, silently. The caller cannot tell this branch from the other.
    if (!user) return { accepted: true as const };

    const token = randomBytes(32).toString('base64url');
    const next = opts.next && opts.next.startsWith('/') && !opts.next.startsWith('//') ? opts.next : null;
    await query(
      `insert into sign_in_link (user_id, email, token_hash, expires_at, next_path, requested_ip)
       values ($1,$2,$3, now() + ($4 || ' minutes')::interval, $5, $6)`,
      [user.id, email, hash(token), String(TTL_MINUTES), next, opts.ip ?? null]
    );

    const link = `${config.appUrl}/api/v1/auth/sign-in-link/verify?token=${token}`;
    await sendLinkEmail(user.email, user.display_name, link).catch(() => {
      /* The row stands; the person can ask for another. Never fail loudly here — the
         error would tell the browser that this address exists. */
    });
    return { accepted: true as const, ...(process.env.NODE_ENV === 'development' ? { devLink: link } : {}) };
  });
}

/**
 * Redeem a token. Returns the user id to sign in, plus where they were headed.
 * Throws with a message fit to show a person — they are staring at a dead link.
 */
export async function redeemSignInLink(token: string): Promise<{ userId: string; tenantId: string | null; next: string }> {
  if (!token || token.length < 20) throw Object.assign(new Error('That sign-in link is not valid.'), { status: 400 });
  return runAsSystem(async () => {
    const row = await queryOne<{ id: string; user_id: string; tenant_id: string | null; token_hash: string; next_path: string | null; used_at: string | null; expired: boolean }>(
      `select l.id, l.user_id, u.tenant_id, l.token_hash, l.next_path, l.used_at, (l.expires_at <= now()) as expired
         from sign_in_link l left join app_user u on u.id = l.user_id where l.token_hash = $1`,
      [hash(token)]
    );
    if (!row) throw Object.assign(new Error('That sign-in link is not valid. Ask for a new one.'), { status: 400 });
    // Constant-time even though the lookup was by hash: the row came back, so compare.
    const a = Buffer.from(row.token_hash);
    const b = Buffer.from(hash(token));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw Object.assign(new Error('That sign-in link is not valid.'), { status: 400 });
    if (row.used_at) throw Object.assign(new Error('That sign-in link has already been used. Ask for a new one.'), { status: 400 });
    if (row.expired) throw Object.assign(new Error(`That sign-in link has expired — they last ${TTL_MINUTES} minutes. Ask for a new one.`), { status: 400 });

    // Single use: claim it, and only accept the claim we won.
    const claimed = await queryOne<{ id: string }>(`update sign_in_link set used_at = now() where id = $1 and used_at is null returning id`, [row.id]);
    if (!claimed) throw Object.assign(new Error('That sign-in link has already been used. Ask for a new one.'), { status: 400 });

    const next = row.next_path && row.next_path.startsWith('/') && !row.next_path.startsWith('//') ? row.next_path : paths.afterSignIn;
    return { userId: row.user_id, tenantId: row.tenant_id, next };
  });
}

/** Housekeeping: drop spent and expired rows. Called by the nightly cron. */
export async function purgeSignInLinks(): Promise<number> {
  const rows = await runAsSystem(() =>
    query<{ id: string }>(`delete from sign_in_link where expires_at < now() - interval '7 days' returning id`)
  ).catch(() => []);
  return rows.length;
}

async function sendLinkEmail(to: string, name: string | null, link: string): Promise<void> {
  if (!config.resendApiKey || !config.resendFromEmail) {
    if (process.env.NODE_ENV === 'development') return; // the dev link is returned to the caller instead
    throw new Error('No email provider is configured.');
  }
  const hello = name ? `Hello ${name.split(' ')[0]},` : 'Hello,';
  const resend = new Resend(config.resendApiKey);
  await resend.emails.send({
    from: config.resendFromEmail,
    to,
    subject: 'Your CONVEYi sign-in link',
    text: `${hello}\n\nHere is your sign-in link. It works once and lasts ${TTL_MINUTES} minutes:\n\n${link}\n\nIf you did not ask for this, you can ignore it — nobody can sign in as you without this email.\n`,
    html: `
      <p>${escapeHtml(hello)}</p>
      <p>Here is your sign-in link. It works once and lasts ${TTL_MINUTES} minutes.</p>
      <p><a href="${link}" style="display:inline-block;padding:11px 20px;background:#5A27E0;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Sign in to CONVEYi</a></p>
      <p style="color:#64748b;font-size:13px">If the button doesn’t work, paste this into your browser:<br>${link}</p>
      <p style="color:#64748b;font-size:13px">If you did not ask for this, you can ignore it — nobody can sign in as you without this email.</p>`,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
