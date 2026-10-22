// ── Reusable CTA button ───────────────────────────────────────────────────────
export type CtaProps = {
  label: string;
  href: string;
  dataCta: string;
  /** `onColour` and `outlineOnColour` sit on an ink or violet band. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'onColour' | 'outlineOnColour';
  size?: 'md' | 'lg';
  className?: string;
};

export function Cta({ label, href, dataCta, variant = 'primary', size = 'md', className = '' }: CtaProps) {
  const base =
    'inline-flex items-center justify-center rounded-full font-semibold transition-all duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet';

  const sizes = {
    md: 'px-5 py-2.5 text-sm',
    lg: 'px-7 py-3.5 text-base',
  };

  const variants = {
    primary: 'bg-violet text-white hover:bg-violet-dark shadow-violet active:scale-[0.98]',
    secondary: 'border border-ink/20 bg-transparent text-ink hover:border-ink hover:bg-ink hover:text-paper active:scale-[0.98]',
    ghost: 'text-violet hover:text-violet-dark underline underline-offset-4 decoration-violet/40',
    onColour: 'bg-paper text-ink hover:bg-white shadow-card active:scale-[0.98]',
    outlineOnColour: 'border border-white/40 bg-transparent text-white hover:border-white hover:bg-white/10 active:scale-[0.98]',
  };

  return (
    <a href={href} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} data-cta={dataCta}>
      {label}
    </a>
  );
}
