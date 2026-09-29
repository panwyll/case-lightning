/**
 * The people who run CONVEYi itself (not a firm's admins): they can comp a firm, with or
 * without an end date. Named by email in PLATFORM_ADMIN_EMAILS (comma-separated).
 */
import type { SessionUser } from './types';

const admins = (): string[] => (process.env.PLATFORM_ADMIN_EMAILS ?? 'peteranwyll@hotmail.com').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

export function isPlatformAdmin(user: Pick<SessionUser, 'email'> | null | undefined): boolean {
  return !!user?.email && admins().includes(user.email.toLowerCase());
}

export function assertPlatformAdmin(user: Pick<SessionUser, 'email'>): void {
  if (!isPlatformAdmin(user)) throw Object.assign(new Error('Not found.'), { status: 404 });
}
