import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertFeature, config } from '@/lib/server/config';
import { exchangeCodeForToken } from '@/lib/server/oauth';
import { transaction } from '@/lib/server/db';
import { signSession, SESSION_COOKIE, OAUTH_STATE_COOKIE, OAUTH_FLOW_COOKIE, OAUTH_NEXT_COOKIE } from '@/lib/server/session';
import { ensureSubscription } from '@/lib/server/subscriptions';
import { applyInviteOnJoin } from '@/lib/server/invites';
import { paths } from '@/lib/paths';

/** "chloe@delaney-webb.co.uk" → "Delaney Webb"; a personal mailbox gives nothing, and the firm names itself in Get started. */
function firmNameFromEmail(email: string): string | null {
  const domain = (email.split('@')[1] ?? '').toLowerCase();
  const free = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'outlook.co.uk', 'live.com', 'live.co.uk', 'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'btinternet.com', 'sky.com', 'aol.com', 'msn.com', 'protonmail.com', 'proton.me']);
  if (!domain || free.has(domain)) return null;
  const base = domain.replace(/\.(co\.uk|org\.uk|ltd\.uk|com|co|uk|org|net|law|legal|solicitors)$/g, '').split('.')[0];
  const words = base.split(/[-_]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length ? words.join(' ') : null;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type PageAction = { label: string; href?: string; copy?: string; primary?: boolean };

/**
 * A friendly, actionable sign-in page — never a raw error dump. Renders inside the Office
 * dialog and standalone. Every outcome ends in a button: reconnect, try again, or (when the
 * firm's Microsoft 365 needs an IT admin to approve CONVEYi) a link to hand to IT.
 */
function authPage(title: string, message: string, actions: PageAction[]): NextResponse {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const btn = (a: PageAction) => {
    const style = a.primary
      ? 'background:#5A27E0;color:#fff;border:1px solid #5A27E0'
      : 'background:#fff;color:#5A27E0;border:1px solid #c4b5fd';
    const base = `display:block;box-sizing:border-box;width:100%;margin-top:8px;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:10px;cursor:pointer;font-family:inherit;${style}`;
    return a.copy
      ? `<button type="button" style="${base}" data-copy="${esc(a.copy)}" onclick="navigator.clipboard.writeText(this.dataset.copy).then(()=>{this.textContent='Link Copied'})">${esc(a.label)}</button>`
      : `<a href="${esc(a.href ?? '/')}" style="${base}">${esc(a.label)}</a>`;
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — CONVEYi</title></head>
<body style="margin:0;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f6f7fb;color:#0f172a;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
<div style="max-width:380px;width:100%;text-align:center">
  <div style="width:46px;height:46px;border-radius:11px;background:#5A27E0;display:flex;align-items:center;justify-content:center;margin:0 auto 16px">
    <svg viewBox="0 0 32 32" width="30" height="30"><path d="M5 16 C9 10 13 10 16 16 C19 22 23 22 27 16" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/></svg>
  </div>
  <h1 style="font-size:19px;margin:0 0 8px">${esc(title)}</h1>
  <p style="font-size:13.5px;color:#475569;line-height:1.55;margin:0 0 18px">${esc(message)}</p>
  ${actions.map(btn).join('\n  ')}
</div></body></html>`;
  return new NextResponse(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function authErrorPage(message: string, consentIssue: boolean): NextResponse {
  return consentIssue
    ? authPage('One More Permission Needed', message, [{ label: 'Grant Access And Reconnect', href: '/api/v1/auth/login?consent=1', primary: true }])
    : authPage('Sign-In Did Not Finish', message, [{ label: 'Try Again', href: '/api/v1/auth/login', primary: true }]);
}

/** The link an IT admin opens to approve CONVEYi for the firm. */
const itAdminLink = () => `${config.appUrl}/conveyi/it-admin`;

/** The firm's Microsoft 365 lets only an admin approve apps: hand the person the link for IT. */
function needsAdminPage(): NextResponse {
  const link = itAdminLink();
  const mail = `mailto:?subject=${encodeURIComponent('Please approve CONVEYi for our Microsoft 365')}&body=${encodeURIComponent(`Our Microsoft 365 needs an admin to approve CONVEYi before we can sign in. It takes one click:\n\n${link}`)}`;
  return authPage('Your IT Admin Needs To Approve CONVEYi', 'Your firm’s Microsoft 365 only lets an admin approve new apps. Send them this link; once they approve, sign in again.', [
    { label: 'Copy Link For IT', copy: link, primary: true },
    { label: 'Email Your IT Admin', href: mail },
    { label: 'Try Again', href: '/api/v1/auth/login' },
  ]);
}

/**
 * What Microsoft sent back instead of a code. Entra codes:
 *  AADSTS90094 / 90095 — only an admin may consent (90095: a request was sent to them);
 *  AADSTS65004 — the person declined; AADSTS65001 — consent missing.
 */
function oauthErrorPage(error: string, description: string): NextResponse {
  const d = `${error} ${description}`;
  if (/AADSTS90095/i.test(d)) {
    return authPage('Approval Requested', 'Your request has gone to your firm’s Microsoft 365 admins. Once one of them approves CONVEYi, sign in again.', [
      { label: 'Copy Link For IT', copy: itAdminLink(), primary: true },
      { label: 'Try Again', href: '/api/v1/auth/login' },
    ]);
  }
  if (/AADSTS90094|admin approval|admin consent|administrator/i.test(d)) return needsAdminPage();
  if (/AADSTS65004|cancel/i.test(d)) {
    return authPage('Permission Not Granted', 'CONVEYi needs access to your mailbox to file and draft your email. Nothing was connected.', [{ label: 'Try Again', href: '/api/v1/auth/login?consent=1', primary: true }]);
  }
  if (/AADSTS65001|consent/i.test(d)) return authErrorPage('CONVEYi needs your permission to connect to your Microsoft 365 mailbox.', true);
  return authErrorPage('Something interrupted the sign-in. This is usually temporary.', false);
}

/** Microsoft's return from the admin-consent screen (state `ac.…`). */
function adminConsentResult(req: NextRequest): NextResponse {
  const sp = req.nextUrl.searchParams;
  const res = (() => {
    if (sp.get('admin_consent')?.toLowerCase() === 'true') {
      return authPage('CONVEYi Approved', 'Everyone at your firm can now sign in with their Microsoft 365 account.', [{ label: 'Sign In', href: paths.signIn, primary: true }]);
    }
    const d = `${sp.get('error') ?? ''} ${sp.get('error_description') ?? ''}`;
    const notAdmin = /AADSTS90094|AADSTS50105|admin|privilege|role/i.test(d);
    return authPage(
      'Not Approved',
      notAdmin ? 'This account cannot approve apps for your firm. Sign in with a Microsoft 365 administrator account (Global, Application or Cloud Application Administrator).' : 'The approval did not finish. Nothing was changed.',
      [{ label: 'Try Again', href: '/api/v1/auth/login?admin=1', primary: true }]
    );
  })();
  res.cookies.delete(OAUTH_STATE_COOKIE);
  return res;
}

/** Thrown when a firm has hit the team ceiling. */
class TeamFullError extends Error {
  constructor() {
    super('team-full');
    this.name = 'TeamFullError';
  }
}

function parseJwt(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  if (!payload) throw new Error('Invalid JWT payload');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

async function fetchGraphProfile(accessToken: string) {
  const res = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { mail: null, userPrincipalName: null, displayName: null };
  const d = (await res.json()) as { mail?: string; userPrincipalName?: string; displayName?: string };
  return { mail: d.mail ?? null, userPrincipalName: d.userPrincipalName ?? null, displayName: d.displayName ?? null };
}

export async function GET(req: NextRequest) {
  try {
    // Microsoft's answer without a code (admin consent, or a refusal) needs no sign-in set-up to explain.
    const sp = req.nextUrl.searchParams;
    if (sp.get('admin_consent') || sp.get('state')?.startsWith('ac.')) return adminConsentResult(req);
    const oauthError = sp.get('error');
    if (oauthError) return oauthErrorPage(oauthError, sp.get('error_description') ?? '');
    assertFeature('auth');
    const { code, state } = z
      .object({ code: z.string(), state: z.string() })
      .parse(Object.fromEntries(req.nextUrl.searchParams));

    if (req.cookies.get(OAUTH_STATE_COOKIE)?.value !== state) {
      return NextResponse.json({ error: 'Invalid OAuth state' }, { status: 400 });
    }

    const token = await exchangeCodeForToken(code);
    const claims = parseJwt(token.id_token ?? token.access_token);
    const oid = claims.oid as string | undefined;
    const tid = claims.tid as string | undefined;
    const profile = await fetchGraphProfile(token.access_token);
    const email =
      (claims.preferred_username as string | undefined) ?? profile.mail ?? profile.userPrincipalName ?? '';
    const name = (claims.name as string | undefined) ?? profile.displayName ?? null;

    if (!oid || !tid || !email) {
      return NextResponse.json({ error: 'OAuth claims incomplete' }, { status: 400 });
    }

    const tenant = await transaction(async (client) => {
      const existing = await client.query<{ id: string }>(
        'select id from tenant where external_tenant_id = $1',
        [tid]
      );
      if (existing.rowCount) return existing.rows[0]!;
      const created = await client.query<{ id: string }>(
        'insert into tenant (external_tenant_id, name) values ($1, $2) returning id',
        [tid, firmNameFromEmail(email) ?? `Tenant-${tid}`]
      );
      return created.rows[0]!;
    });

    const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
    const user = await transaction(async (client) => {
      const existing = await client.query<{ id: string }>(
        'select id from app_user where entra_object_id = $1',
        [oid]
      );
      if (existing.rowCount) {
        await client.query(
          `update app_user set email=$1, display_name=$2, graph_access_token=$3,
             graph_refresh_token=$4, token_expires_at=$5 where id=$6`,
          [email, name, token.access_token, token.refresh_token ?? null, expiresAt, existing.rows[0]!.id]
        );
        return { id: existing.rows[0]!.id, created: false };
      }
      // An account an admin created ahead of time: claim it by email, keeping the role and
      // access they set. The placeholder object id becomes the real one.
      const pending = await client.query<{ id: string }>(
        `select id from app_user where tenant_id = $1 and lower(email) = lower($2) and entra_object_id like 'pending:%' limit 1`,
        [tenant.id, email]
      );
      if (pending.rowCount) {
        await client.query(
          `update app_user set entra_object_id=$1, display_name=coalesce(display_name, $2), graph_access_token=$3,
             graph_refresh_token=$4, token_expires_at=$5 where id=$6`,
          [oid, name, token.access_token, token.refresh_token ?? null, expiresAt, pending.rows[0]!.id]
        );
        return { id: pending.rows[0]!.id, created: false };
      }
      // First user in a tenant becomes ADMIN (the firm owner); everyone after is a
      // CONVEYANCER until an admin promotes them.
      const count = await client.query<{ n: string }>('select count(*)::text as n from app_user where tenant_id = $1', [
        tenant.id,
      ]);
      const seatCount = Number(count.rows[0]?.n ?? '0');
      // Seats are free under per-case billing — any colleague may join, up to a sanity ceiling.
      if (seatCount >= config.teamMaxMembers) throw new TeamFullError();
      const role = seatCount === 0 ? 'ADMIN' : 'CONVEYANCER';
      const created = await client.query<{ id: string }>(
        `insert into app_user
          (tenant_id, entra_object_id, email, display_name, role, graph_access_token, graph_refresh_token, token_expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [tenant.id, oid, email, name, role, token.access_token, token.refresh_token ?? null, expiresAt]
      );
      return { id: created.rows[0]!.id, created: true };
    });

    // If this address was invited to the firm, apply the invited role and mark the invite
    // accepted. No-op when there's no matching invite; never blocks sign-in.
    await applyInviteOnJoin(tenant.id, user.id, email).catch(() => {});

    // Arm (or self-heal) the auto-triage inbox subscription right away. Add-in users get
    // this on taskpane open, but a web-only sign-in has no taskpane — without this they'd
    // wait for the daily cron. ensureSubscription never throws; still guard the import path.
    void ensureSubscription(user.id, tenant.id).catch(() => {});

    const session = await signSession(user.id);
    // A browser signup goes straight into the app — there's no Office dialog to hand a
    // token back to, and no reason to make a brand-new user watch an Office.js probe
    // time out. The add-in flow still lands on the completion bridge: the token rides in
    // the URL fragment (never sent to a server or logged) so the dialog can hand it to
    // the taskpane via postMessage, which desktop Outlook needs because it isolates the
    // dialog's cookies. First run of a new firm opens on Get started (?tab=getstarted).
    const webFlow = req.cookies.get(OAUTH_FLOW_COOKIE)?.value === 'web';
    // Somebody sent here by the sign-in wall goes back to the page they asked for; a
    // brand-new firm still opens on Get started.
    const wanted = req.cookies.get(OAUTH_NEXT_COOKIE)?.value;
    const next = wanted && wanted.startsWith('/') && !wanted.startsWith('//') ? wanted : null;
    const dest = webFlow
      ? `${config.appUrl}${next ?? paths.afterSignIn}`
      : `${config.appUrl}/addin/auth-complete#s=${session}`;
    const res = NextResponse.redirect(dest);
    if (webFlow) res.cookies.delete(OAUTH_FLOW_COOKIE);
    if (wanted) res.cookies.delete(OAUTH_NEXT_COOKIE);
    res.cookies.set(SESSION_COOKIE, session, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 60 * 60 * 24 * 7,
    });
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  } catch (error) {
    if (error instanceof TeamFullError) {
      return authErrorPage(`Your firm's team is at its limit of ${config.teamMaxMembers} people. Ask your admin to remove someone, then reconnect.`, false);
    }
    // A consent/permission problem (e.g. a scope was added but not yet granted, or a stale
    // grant) → offer the consent-forcing reconnect. Everything else → a plain retry.
    const msg = String((error as Error)?.message ?? error);
    if (/AADSTS9009[45]/i.test(msg)) return needsAdminPage();
    const consentIssue = /AADSTS65001|invalid_grant|consent|AADSTS650|not consented/i.test(msg);
    return authErrorPage(
      consentIssue
        ? 'CONVEYi needs your permission to connect to your Microsoft 365 mailbox.'
        : 'Something interrupted the sign-in. This is usually temporary.',
      consentIssue
    );
  }
}
