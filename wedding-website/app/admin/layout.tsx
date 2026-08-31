import Link from 'next/link';
import { store } from '@/lib/store';

export const metadata = { title: 'Admin' };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-paper-deep/40">
      <header className="border-b border-line bg-card">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="flex items-center gap-6">
            <Link href="/admin" className="font-display text-lg">
              Back of house
            </Link>
            <Link href="/" className="text-sm text-ink-soft hover:text-ink">
              View the site
            </Link>
            <Link href="/admin/export" className="text-sm text-ink-soft hover:text-ink">
              Export CSV
            </Link>
          </div>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="text-sm text-ink-soft hover:text-ink">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-5 py-10">{children}</div>

      <footer className="mx-auto w-full max-w-6xl px-5 pb-10 text-xs text-ink-soft">
        Store: {store().name}
      </footer>
    </div>
  );
}
