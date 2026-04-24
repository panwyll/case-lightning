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
