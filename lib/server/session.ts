/**
 * JWT cookie session, signed with `jose` (replaces the Fastify @fastify/jwt plugin).
 * The cookie holds only { userId }; the full SessionUser is loaded from the DB.
 */
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { queryOne } from './db';
import { config } from './config';
import type { SessionUser } from './types';

export const SESSION_COOKIE = 'cl_session';
export const OAUTH_STATE_COOKIE = 'cl_oauth_state';

function secret(): Uint8Array {
  if (!config.sessionJwtSecret) throw new Error('SESSION_JWT_SECRET is not set');
  return new TextEncoder().encode(config.sessionJwtSecret);
}

export async function signSession(userId: string): Promise<string> {
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret());
}

export async function verifySession(token: string): Promise<{ userId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return typeof payload.userId === 'string' ? { userId: payload.userId } : null;
  } catch {
    return null;
  }
}

/** Reads the session cookie and loads the current user, or null if unauthenticated. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const verified = await verifySession(token);
  if (!verified) return null;

  return queryOne<SessionUser>(
    `select id as "userId", tenant_id as "tenantId", role, email, display_name as "displayName"
     from app_user where id = $1`,
    [verified.userId]
  );
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
