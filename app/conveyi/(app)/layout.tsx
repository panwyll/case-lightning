import { getSessionUser } from '@/lib/server/session';
import { AppShell } from '@/app/shared/AppNav';

/**
 * Every page behind the sign-in wall sits in the same shell. The session is read here,
 * on the server, so the nav is drawn on the first paint — no fetch, no flicker — and
 * page changes swap only the content.
 */
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  const me = user ? { role: user.role, displayName: user.displayName ?? null, email: user.email, actor: user.actor ? { displayName: user.actor.displayName, email: user.actor.email } : null } : null;
  return <AppShell me={me}>{children}</AppShell>;
}
