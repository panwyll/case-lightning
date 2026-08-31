import { PasswordForm } from '@/components/PasswordForm';
import { safeNext } from '@/lib/redirect';

export const metadata = { title: 'Admin' };

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next, '/admin');

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-16">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center font-display text-3xl">Back of house</h1>
        <div className="panel p-6">
          <PasswordForm endpoint="/api/auth/admin" next={next} label="Admin password" cta="Sign in" />
        </div>
      </div>
    </main>
  );
}
