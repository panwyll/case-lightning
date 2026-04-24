'use client';

import { useRef, useState } from 'react';
import { Cta } from './Cta';

type NavHeaderProps = {
  signupHref: string;
};

const NAV_LINKS = [
  { href: '/how-it-works', label: 'How It Works' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/faq', label: 'FAQ' },
] as const;

export function NavHeader({ signupHref }: NavHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);

  function closeMenu() {
    setMenuOpen(false);
    burgerRef.current?.focus();
  }

  return (
    <header className="sticky top-0 z-50 border-b border-slate-800/80 bg-slate-950/95 backdrop-blur shadow-[0_1px_20px_rgba(0,0,0,0.5)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        {/* Logo */}
        <a href="/" className="text-xl font-bold tracking-tight transition hover:opacity-80">
          Case<span className="text-brand-500">Lightning</span>
        </a>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-8 text-sm font-medium text-slate-400 md:flex">
          {NAV_LINKS.map(({ href, label }) => (
            <a key={href} href={href} className="transition-colors hover:text-white">{label}</a>
          ))}
        </nav>

        {/* Right: desktop CTA + mobile burger */}
        <div className="flex items-center gap-3">
          <div className="hidden md:block">
            <Cta label="Sign Up" href={signupHref} dataCta="nav_signup" />
          </div>
          <button
            ref={burgerRef}
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white md:hidden"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
          >
            {menuOpen ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="3" y1="7" x2="21" y2="7" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="17" x2="21" y2="17" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div
          id="mobile-menu"
          className="border-t border-slate-800 bg-slate-950/95 px-6 pb-5 pt-4 md:hidden"
        >
          <nav className="flex flex-col gap-1 text-base font-medium text-slate-300">
            {NAV_LINKS.map(({ href, label }) => (
              <a
                key={href}
                href={href}
                className="rounded-lg px-3 py-2.5 transition-colors hover:bg-slate-800 hover:text-white"
                onClick={closeMenu}
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="mt-4">
            <Cta
              label="Sign Up"
              href={signupHref}
              dataCta="nav_signup_mobile"
              className="w-full justify-center"
            />
          </div>
        </div>
      )}
    </header>
  );
}
