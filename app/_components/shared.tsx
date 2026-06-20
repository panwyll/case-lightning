// ── Brands ────────────────────────────────────────────────────────────────────
// Case Lightning is the parent brand; CONVEYi is its first product. Sub-brands
// (finance, legal, etc.) live as products under the Case Lightning umbrella.
export const PARENT_BRAND = 'Case Lightning';
export const BRAND = 'CONVEYi';

/** Case Lightning wordmark: a bolt of "Lightning" in violet. */
export function CaseLightningWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-sans font-extrabold tracking-tight text-ink ${className}`}>
      Case<span className="text-violet"> Lightning</span>
    </span>
  );
}

/** CONVEYi wordmark: CONVE + violet Yi, matching the brand creative. */
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
  home: '/',
  signup: '/waitlist',
  conveyi: '/conveyi',
  pricing: '/conveyi/pricing',
  howItWorks: '/conveyi/how-it-works',
  faq: '/conveyi/faq',
} as const;

// Nav links for the CONVEYi product site.
export const CONVEYI_NAV = [
  { href: ROUTES.howItWorks, label: 'How it works' },
  { href: ROUTES.pricing, label: 'Pricing' },
  { href: ROUTES.faq, label: 'FAQ' },
] as const;

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

// ── CONVEYi product footer ──────────────────────────────────────────────────
export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-paper px-6 py-12">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 md:flex-row md:items-center">
        <div>
          <Wordmark className="text-2xl" />
          <span className="ml-2 text-sm text-ink-soft">
            by <a href={ROUTES.home} className="font-medium hover:text-ink">{PARENT_BRAND}</a>
          </span>
          <p className="mt-2 max-w-sm text-sm text-ink-soft">
            AI for conveyancers. Inside Outlook. Your cases live in the Microsoft tools you already pay for — nothing new to install.
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-soft">
          <a href={ROUTES.howItWorks} className="hover:text-ink">How it works</a>
          <a href={ROUTES.pricing} className="hover:text-ink">Pricing</a>
          <a href={ROUTES.faq} className="hover:text-ink">FAQ</a>
          <a href={ROUTES.signup} className="hover:text-ink">Get started</a>
          <a href={ROUTES.home} className="hover:text-ink">{PARENT_BRAND}</a>
        </nav>
      </div>
      <p className="mx-auto mt-8 max-w-6xl text-xs text-ink-soft/70">
        © {new Date().getFullYear()} {BRAND} — a {PARENT_BRAND} product. GDPR-compliant. Your data stays in your own Microsoft 365 tenant.
      </p>
    </footer>
  );
}

// ── Case Lightning umbrella footer ──────────────────────────────────────────
export function CaseLightningFooter() {
  return (
    <footer className="border-t border-line bg-paper px-6 py-12">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 md:flex-row md:items-center">
        <div>
          <CaseLightningWordmark className="text-2xl" />
          <p className="mt-2 max-w-sm text-sm text-ink-soft">
            Case management that lives in the tools you already use — your operating system and your email. Built for finance, legal, and any document-heavy workflow.
          </p>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-soft">
          <a href={ROUTES.conveyi} className="hover:text-ink">CONVEYi</a>
          <a href="#products" className="hover:text-ink">Products</a>
          <a href="#custom" className="hover:text-ink">Custom builds</a>
          <a href={ROUTES.signup} className="hover:text-ink">Get started</a>
        </nav>
      </div>
      <p className="mx-auto mt-8 max-w-6xl text-xs text-ink-soft/70">
        © {new Date().getFullYear()} {PARENT_BRAND}. Native to your OS and inbox. Your data stays in your own tenant.
      </p>
    </footer>
  );
}
