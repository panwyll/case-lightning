'use client';

import { useRef, useState } from 'react';
import { Cta } from './Cta';
import { CONVEYI_NAV, ROUTES } from './shared';

type NavLink = { href: string; label: string };

type NavHeaderProps = {
  signupHref: string;
  /** Where the logo links to. Defaults to the CONVEYi product home. */
  homeHref?: string;
  /** Primary nav links. Defaults to the CONVEYi product nav. */
  links?: readonly NavLink[];
  /** Logo style: 'conveyi' (default) or 'caselightning'. */
  brand?: 'conveyi' | 'caselightning';
  signupLabel?: string;
};

export function NavHeader({
  signupHref,
  homeHref = ROUTES.conveyi,
  links = CONVEYI_NAV,
  brand = 'conveyi',
  signupLabel = 'Get started',
}: NavHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);

  function closeMenu() {
    setMenuOpen(false);
    burgerRef.current?.focus();
  }

  return (
    <header className="sticky top-0 z-50 border-b border-line/80 bg-paper/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <a href={homeHref} className="flex items-baseline gap-2 transition hover:opacity-80">
          {brand === 'caselightning' ? (
            <span className="text-xl font-extrabold tracking-tight text-ink">
              Case<span className="text-violet"> Lightning</span>
            </span>
          ) : (
            <>
              <span className="text-xl font-extrabold tracking-tight text-ink">
                CONVE<span className="text-violet">Yi</span>
              </span>
              <span className="hidden text-xs font-medium text-ink-soft sm:inline">by Case Lightning</span>
            </>
          )}
        </a>

        <nav className="hidden items-center gap-8 text-sm font-medium text-ink-soft md:flex">
          {links.map(({ href, label }) => (
            <a key={href} href={href} className="transition-colors hover:text-ink">{label}</a>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <div className="hidden md:block">
            <Cta label={signupLabel} href={signupHref} dataCta="nav_signup" />
          </div>
          <button
            ref={burgerRef}
            className="rounded-lg p-2 text-ink-soft transition-colors hover:bg-ink/5 hover:text-ink md:hidden"
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

      {menuOpen && (
        <div id="mobile-menu" className="border-t border-line bg-paper px-6 pb-5 pt-4 md:hidden">
          <nav className="flex flex-col gap-1 text-base font-medium text-ink">
            {links.map(({ href, label }) => (
              <a key={href} href={href} className="rounded-lg px-3 py-2.5 transition-colors hover:bg-ink/5" onClick={closeMenu}>
                {label}
              </a>
            ))}
          </nav>
          <div className="mt-4">
            <Cta label={signupLabel} href={signupHref} dataCta="nav_signup_mobile" className="w-full" />
          </div>
        </div>
      )}
    </header>
  );
}
