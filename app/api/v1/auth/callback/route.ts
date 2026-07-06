import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertFeature, config } from '@/lib/server/config';
import { exchangeCodeForToken } from '@/lib/server/oauth';
import { transaction } from '@/lib/server/db';
import { signSession, SESSION_COOKIE, OAUTH_STATE_COOKIE } from '@/lib/server/session';
import { hasTeamAccess } from '@/lib/server/plan';
import { syncFirmSeats } from '@/lib/server/billing';
import { ensureSubscription } from '@/lib/server/subscriptions';
import { fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Thrown when a second+ colleague signs in to a firm on a single-seat plan. */
class SeatLimitError extends Error {
  constructor() {
    super('single-seat-plan');
    this.name = 'SeatLimitError';
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
        [tid, `Tenant-${tid}`]
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
      // First user in a tenant becomes ADMIN (the firm owner); everyone after is a
      // CONVEYANCER until an admin promotes them.
      const count = await client.query<{ n: string }>('select count(*)::text as n from app_user where tenant_id = $1', [
        tenant.id,
      ]);
      const seatCount = Number(count.rows[0]?.n ?? '0');
      // Solo/Pro are single-seat; only Firm (team) admits additional colleagues.
      // Fail OPEN on a plan-check error so a billing hiccup never locks a firm out.
      if (seatCount > 0) {
        let teamOk = true;
        try {
          teamOk = await hasTeamAccess(tenant.id);
        } catch {
          teamOk = true;
        }
        if (!teamOk) throw new SeatLimitError();
      }
      const role = seatCount === 0 ? 'ADMIN' : 'CONVEYANCER';
      const created = await client.query<{ id: string }>(
        `insert into app_user
          (tenant_id, entra_object_id, email, display_name, role, graph_access_token, graph_refresh_token, token_expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [tenant.id, oid, email, name, role, token.access_token, token.refresh_token ?? null, expiresAt]
      );
      return { id: created.rows[0]!.id, created: true };
    });

    // A new colleague just took a seat → reconcile the Firm per-seat overage. Fire-and-
    // forget: a Stripe hiccup must never block sign-in (no-op off Firm / under the cap).
    if (user.created) void syncFirmSeats(tenant.id).catch(() => {});

    // Arm (or self-heal) the auto-triage inbox subscription right away. Add-in users get
    // this on taskpane open, but a web-only sign-in has no taskpane — without this they'd
    // wait for the daily cron. ensureSubscription never throws; still guard the import path.
    void ensureSubscription(user.id, tenant.id).catch(() => {});

    const session = await signSession(user.id);
    // Land on a tiny completion page. The token rides in the URL fragment (never
    // sent to a server or logged) so the dialog can hand it to the taskpane via
    // postMessage — needed because desktop Outlook isolates the dialog's cookies.
    const res = NextResponse.redirect(`${config.appUrl}/addin/auth-complete#s=${session}`);
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
    if (error instanceof SeatLimitError) {
      return NextResponse.json(
        {
          error:
            'Your firm’s plan is single-seat. Ask your admin to upgrade to the Firm (team) plan to add colleagues.',
        },
        { status: 403 }
      );
    }
    return fail(error);
  }
}
