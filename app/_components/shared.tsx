// ── Brand ─────────────────────────────────────────────────────────────────────
// Single source of truth for the brand name. Flip here to rebrand the whole site.
export const BRAND = 'CONVEYi';

/** Wordmark: CONVE + violet Yi, matching the brand creative. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-sans font-extrabold tracking-tight text-ink ${className}`}>
      CONVE<span className="text-violet">Yi</span>
    </span>
  );
}

// ── UTM / CTA helpers ─────────────────────────────────────────────────────────
export const UTM = {
  medium: 'cta',
  campaign: 'conveyi_launch',
} as const;

export const ROUTES = {
  signup: '/waitlist',
  pricing: '/pricing',
  howItWorks: '/how-it-works',
  faq: '/faq',
} as const;

export function ctaHref(path: string, source: string, content: string) {
  const p = new URLSearchParams({
    utm_source: source,
    utm_medium: UTM.medium,
    utm_campaign: UTM.campaign,
    utm_content: content,
  });
  return `${path}?${p.toString()}`;
}

// ── The 99% / 1% motif (the core marketing angle) ──────────────────────────────
export function NinetyNinePie({ size = 220 }: { size?: number }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} role="img" aria-label="99% admin, 1% conveyancing" className="-rotate-90">
      <circle cx="20" cy="20" r={r} fill="none" stroke="#5A27E0" strokeWidth="8" />
      <circle cx="20" cy="20" r={r} fill="none" stroke="#C7B8F5" strokeWidth="8" strokeDasharray={`${c * 0.01} ${c * 0.99}`} />
    </svg>
  );
}

// ── Shared exports ─────────────────────────────────────────────────────────────
export { NavHeader } from './NavHeader';
export type { CtaProps } from './Cta';
export { Cta } from './Cta';

// ── Shared footer ─────────────────────────────────────────────────────────────
export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-paper px-6 py-12">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 md:flex-row md:items-center">
        <div>
          <Wordmark className="text-2xl" />
          <p className="mt-2 max-w-sm text-sm text-ink-soft">
            AI for conveyancers. Inside Outlook. Your cases live in the Microsoft tools you already pay for — nothing new to install.
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-soft">
          <a href="/how-it-works" className="hover:text-ink">How it works</a>
          <a href="/pricing" className="hover:text-ink">Pricing</a>
          <a href="/faq" className="hover:text-ink">FAQ</a>
          <a href="/waitlist" className="hover:text-ink">Get started</a>
        </nav>
      </div>
      <p className="mx-auto mt-8 max-w-6xl text-xs text-ink-soft/70">
        © {new Date().getFullYear()} {BRAND}. GDPR-compliant. Your data stays in your own Microsoft 365 tenant.
      </p>
    </footer>
  );
}
