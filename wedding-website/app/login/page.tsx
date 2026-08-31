import { PasswordForm } from '@/components/PasswordForm';
import { wedding } from '@/content/wedding';
import { safeNext } from '@/lib/redirect';

export const metadata = { title: 'Enter' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-brass">You are invited</p>
          <h1 className="mt-3 font-display text-4xl">
            {wedding.partnerOne} <span className="text-brass">&</span> {wedding.partnerTwo}
          </h1>
          <p className="mt-3 text-sm text-ink-soft">{wedding.dateLabel}</p>
        </div>

        <div className="panel p-6">
          <PasswordForm
            endpoint="/api/auth/site"
            next={next}
            label="Password from your invitation"
            cta="Come in"
          />
          <p className="mt-5 text-center text-xs leading-relaxed text-ink-soft">
            If we sent you a personal link, use that instead — it will let you
            straight in and it has your own page behind it.
          </p>
        </div>
      </div>
    </main>
  );
}
