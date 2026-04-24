// ── UTM / CTA helpers ─────────────────────────────────────────────────────────
export const UTM = {
  medium: 'cta',
  campaign: 'caselightning_launch',
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

// ── Subtle SVG background iconography ────────────────────────────────────────
export function ScaleIcon() {
  return (
    <svg viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="50" y1="12" x2="50" y2="82" />
      <line x1="18" y1="18" x2="82" y2="18" />
      <path d="M18,18 L8,44 L28,44 Z" />
      <path d="M82,18 L72,44 L92,44 Z" />
      <line x1="36" y1="82" x2="64" y2="82" />
    </svg>
  );
}

export function LightningIcon() {
  return (
    <svg viewBox="0 0 100 100" fill="currentColor">
      <path d="M58,5 L20,55 L43,55 L40,95 L80,45 L57,45 Z" />
    </svg>
  );
}

export function DocIcon() {
  return (
    <svg viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22,5 H60 L78,24 V95 H22 Z" />
      <path d="M60,5 V24 H78" />
      <line x1="33" y1="42" x2="67" y2="42" />
      <line x1="33" y1="57" x2="67" y2="57" />
      <line x1="33" y1="72" x2="54" y2="72" />
    </svg>
  );
}

export function GavelIcon() {
  return (
    <svg viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="30" y1="70" x2="14" y2="86" strokeWidth="5" />
      <line x1="36" y1="64" x2="68" y2="32" />
      <rect x="52" y="8" width="38" height="22" rx="5" transform="rotate(45 71 19)" />
    </svg>
  );
}

type BgPos = [number, number, number, number, number]; // x%, y%, size(px), rot(deg), iconIdx

const ICON_COMPONENTS = [ScaleIcon, LightningIcon, DocIcon, GavelIcon];

export const HERO_BG: BgPos[] = [
  [4, 8, 56, -12, 0], [16, 74, 44, 15, 1], [28, 4, 50, -5, 2],
  [72, 7, 48, 20, 3], [86, 14, 54, -18, 0], [93, 66, 42, 10, 1],
  [8, 46, 38, -8, 2], [50, 84, 46, 12, 3], [38, 18, 40, 8, 1],
  [62, 70, 50, -10, 0],
];

export const SECTION_BG: BgPos[] = [
  [2, 7, 50, -12, 0], [20, 2, 40, 15, 1], [36, 84, 46, -5, 2],
  [54, 4, 44, 20, 3], [70, 80, 52, -18, 0], [88, 10, 42, 10, 1],
  [95, 54, 44, -8, 2], [12, 60, 38, 12, 3], [46, 44, 36, 8, 1],
  [78, 38, 48, -10, 0],
];

export function SectionBackground({ positions = SECTION_BG }: { positions?: BgPos[] }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden select-none">
      {positions.map(([x, y, size, rot, iconIdx], i) => {
        const Icon = ICON_COMPONENTS[iconIdx];
        return (
          <div
            key={i}
            className="absolute text-white opacity-[0.04]"
            style={{ left: `${x}%`, top: `${y}%`, width: size, height: size, transform: `rotate(${rot}deg)` }}
          >
            <Icon />
          </div>
        );
      })}
    </div>
  );
}

// ── Reusable CTA button ───────────────────────────────────────────────────────
type CtaProps = {
  label: string;
  href: string;
  dataCta: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'md' | 'lg';
  className?: string;
};

export function Cta({ label, href, dataCta, variant = 'primary', size = 'md', className = '' }: CtaProps) {
  const base =
    'inline-flex items-center justify-center rounded-xl font-semibold transition-all duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-pink';

  const sizes = {
    md: 'px-6 py-3 text-base',
    lg: 'px-8 py-4 text-lg',
  };

  const variants = {
    primary:
      'bg-brand-pink text-white hover:bg-brand-pink-dim shadow-glow-pink hover:shadow-[0_0_35px_rgba(255,45,120,0.65)] active:scale-95',
    secondary:
      'border-2 border-slate-600 bg-transparent text-white hover:border-brand-blue hover:text-brand-blue active:scale-95',
    ghost: 'text-slate-400 hover:text-brand-blue underline underline-offset-4',
  };

  return (
    <a href={href} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} data-cta={dataCta}>
      {label}
    </a>
  );
}

// ── Shared nav header ─────────────────────────────────────────────────────────
type NavHeaderProps = {
  signupHref: string;
};

export function NavHeader({ signupHref }: NavHeaderProps) {
  return (
    <header className="sticky top-0 z-50 border-b border-slate-800/80 bg-slate-950/95 backdrop-blur shadow-[0_1px_20px_rgba(0,0,0,0.5)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <a href="/" className="text-xl font-bold tracking-tight transition hover:opacity-80">
          Case<span className="text-brand-500">Lightning</span>
        </a>
        <nav className="hidden items-center gap-8 text-sm font-medium text-slate-400 md:flex">
          <a href="/how-it-works" className="transition-colors hover:text-white">How It Works</a>
          <a href="/pricing" className="transition-colors hover:text-white">Pricing</a>
          <a href="/faq" className="transition-colors hover:text-white">FAQ</a>
        </nav>
        <div className="flex items-center gap-3">
          <Cta
            label="Sign Up"
            href={signupHref}
            dataCta="nav_signup"
          />
        </div>
      </div>
    </header>
  );
}

// ── Shared footer ─────────────────────────────────────────────────────────────
export function SiteFooter() {
  return (
    <footer className="border-t border-slate-800 px-6 py-8 text-center text-sm text-slate-600">
      © {new Date().getFullYear()} CaseLightning. All rights reserved.
    </footer>
  );
}
