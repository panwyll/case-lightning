import Link from 'next/link';
import { wedding } from '@/content/wedding';

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/schedule', label: 'The day' },
  { href: '/travel', label: 'Travel & stay' },
  { href: '/registry', label: 'Gifts' },
  { href: '/faq', label: 'Questions' },
];

export function SiteHeader({ guestName }: { guestName?: string }) {
  return (
    <header className="border-b border-line/70 bg-paper-deep/50">
      <div className="wrap flex flex-wrap items-center justify-between gap-4 py-5">
        <Link href="/" className="font-display text-xl tracking-tight">
          {wedding.partnerOne} <span className="text-brass">&</span> {wedding.partnerTwo}
        </Link>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="text-ink-soft hover:text-ink">
              {link.label}
            </Link>
          ))}
          {guestName ? (
            <span className="rounded-full border border-line bg-card px-3 py-1 text-xs text-ink-soft">
              {guestName}
            </span>
          ) : null}
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-line/70 py-10">
      <div className="wrap flex flex-wrap items-baseline justify-between gap-3 text-sm text-ink-soft">
        <p>
          {wedding.dateLabel} · {wedding.venue.name}
        </p>
        <p>
          {wedding.contact.note}{' '}
          <a className="text-brass hover:text-brass-dark" href={`mailto:${wedding.contact.email}`}>
            {wedding.contact.email}
          </a>
        </p>
      </div>
    </footer>
  );
}
