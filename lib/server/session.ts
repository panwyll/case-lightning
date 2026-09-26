/**
 * JWT cookie session, signed with `jose` (replaces the Fastify @fastify/jwt plugin).
 * The cookie holds only { userId }; the full SessionUser is loaded from the DB.
 */
import { SignJWT, jwtVerify } from 'jose';
import { cookies, headers } from 'next/headers';
import { queryOne, bindDbUser, registerRequestUserResolver } from './db';
import { config } from './config';
import type { SessionUser } from './types';

export const SESSION_COOKIE = 'cl_session';

// Small cache so the per-query user resolution (db.ts) does not re-verify the JWT each time.
const tokenUserCache = new Map<string, string | null>();
async function userIdFromRequest(): Promise<string | null> {
  let token: string | undefined;
  try {
    token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) {
      const auth = (await headers()).get('authorization');
      if (auth?.startsWith('Bearer ')) token = auth.slice(7);
    }
  } catch {
    return null; // not inside a request (cron, scripts, build)
  }
  if (!token) return null;
  const hit = tokenUserCache.get(token);
  if (hit !== undefined) return hit;
  const verified = await verifySession(token);
  const userId = verified?.userId ?? null;
  if (tokenUserCache.size > 500) tokenUserCache.clear();
  tokenUserCache.set(token, userId);
  return userId;
}
// Every query made while handling a request now carries the signed-in user for the
// database's ethical-wall check (migration 068) — no route has to remember to do it.
registerRequestUserResolver(userIdFromRequest);
export const OAUTH_STATE_COOKIE = 'cl_oauth_state';
// Which surface started the OAuth round trip. The add-in signs in inside an Office
// dialog and needs the /addin/auth-complete bridge to hand the token back to the task
// pane; a web signup has no dialog and should land straight in the app.
export const OAUTH_FLOW_COOKIE = 'cl_oauth_flow';
// Where the person was headed when the sign-in wall stopped them, so the round trip
// through Microsoft lands them there rather than on a generic screen.
export const OAUTH_NEXT_COOKIE = 'cl_oauth_next';

function secret(): Uint8Array {
  if (!config.sessionJwtSecret) throw new Error('SESSION_JWT_SECRET is not set');
  return new TextEncoder().encode(config.sessionJwtSecret);
}

/** `actorId`: an admin viewing the app as `userId`. The session acts as the target; the actor is remembered so they can return. */
export async function signSession(userId: string, actorId?: string | null): Promise<string> {
  return new SignJWT(actorId ? { userId, actorId } : { userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret());
}

export async function verifySession(token: string): Promise<{ userId: string; actorId: string | null } | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return typeof payload.userId === 'string' ? { userId: payload.userId, actorId: typeof payload.actorId === 'string' ? payload.actorId : null } : null;
  } catch {
    return null;
  }
}

/** Reads the session cookie and loads the current user, or null if unauthenticated. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  // Cookie works in Outlook on the web; on desktop the dialog and taskpane have
  // separate cookie jars, so we also accept the session as a bearer token.
  let token = store.get(SESSION_COOKIE)?.value;
  if (!token) {
    const auth = (await headers()).get('authorization');
    if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  }
  if (!token) return null;

  const verified = await verifySession(token);
  if (!verified) return null;

  const user = await queryOne<SessionUser>(
    `select id as "userId", tenant_id as "tenantId", role, email, display_name as "displayName"
     from app_user where id = $1`,
    [verified.userId]
  );
  if (!user) return null;
  // View-as: the session is the target's, but only while the actor is still an admin of
  // the same firm. A demoted or removed admin's view-as session dies with their role.
  if (verified.actorId) {
    const actor = await queryOne<{ id: string; email: string; display_name: string | null }>(
      `select id, email, display_name from app_user where id = $1 and tenant_id = $2 and role = 'ADMIN'`,
      [verified.actorId, user.tenantId]
    );
    if (!actor) return null;
    user.actor = { userId: actor.id, email: actor.email, displayName: actor.display_name };
  }
  // Every query from here on carries this user for the database's ethical-wall check.
  bindDbUser(user.userId);
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthenticated');
    this.name = 'UnauthorizedError';
  }
}

/** Loads the session user or throws UnauthorizedError (→ 401 in the route handler). */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class ForbiddenError extends Error {
  constructor() {
    super('Forbidden');
    this.name = 'ForbiddenError';
  }
}

/** Loads the session user and asserts one of the given roles (→ 403 otherwise). */
export async function requireRole(roles: SessionUser['role'][]): Promise<SessionUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) throw new ForbiddenError();
  return user;
}
