// ── Reusable CTA button ───────────────────────────────────────────────────────
export type CtaProps = {
  label: string;
  href: string;
  dataCta: string;
  variant?: 'primary' | 'secondary' | 'ghost';
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
  };

  return (
    <a href={href} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} data-cta={dataCta}>
      {label}
    </a>
  );
}
