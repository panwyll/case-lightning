import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertFeature, config } from '@/lib/server/config';
import { exchangeCodeForToken } from '@/lib/server/oauth';
import { transaction } from '@/lib/server/db';
import { signSession, SESSION_COOKIE, OAUTH_STATE_COOKIE } from '@/lib/server/session';
import { fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
        return existing.rows[0]!;
      }
      // First user in a tenant becomes ADMIN (the firm owner); everyone after is a
      // CONVEYANCER until an admin promotes them.
      const count = await client.query<{ n: string }>('select count(*)::text as n from app_user where tenant_id = $1', [
        tenant.id,
      ]);
      const role = Number(count.rows[0]?.n ?? '0') === 0 ? 'ADMIN' : 'CONVEYANCER';
      const created = await client.query<{ id: string }>(
        `insert into app_user
          (tenant_id, entra_object_id, email, display_name, role, graph_access_token, graph_refresh_token, token_expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [tenant.id, oid, email, name, role, token.access_token, token.refresh_token ?? null, expiresAt]
      );
      return created.rows[0]!;
    });

    const session = await signSession(user.id);
    // Land on a tiny completion page: inside an Office dialog it messages the
    // taskpane and closes; in a plain browser it forwards to the taskpane.
    const res = NextResponse.redirect(`${config.appUrl}/addin/auth-complete`);
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
    return fail(error);
  }
}
