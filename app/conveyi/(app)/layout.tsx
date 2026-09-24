import { AppShell } from '@/app/shared/AppNav';

/**
 * Every page behind the sign-in wall sits in the admin centre's shell: the brand bar and
 * the grouped sidebar. The marketing pages under /conveyi are outside this route group.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
