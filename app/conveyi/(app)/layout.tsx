import { AppHeader } from '@/app/shared/AppNav';

/**
 * Every page behind the sign-in wall gets the same header and the same nav. The marketing
 * pages under /conveyi are outside this route group and are untouched.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AppHeader />
      {children}
    </>
  );
}
