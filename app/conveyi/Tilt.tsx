'use client';
import { useEffect, useRef } from 'react';

/** The screen inside eases out from a slight zoom as the device settles. */
export const SCREEN_ZOOM: React.CSSProperties = { transformOrigin: '50% 0%', transform: 'scale(calc(1 + (1 - var(--p)) * 0.06))' };

/** Layers behind the face that, turned in 3D, read as the device's edge. */
const DEPTH = 10;

/**
 * A screenshot as a slab in space: a thin-edged device with real thickness, turned towards the text beside it. It
 * enters turned further and tipped back, and settles as it scrolls to the middle of the screen. Sets --p (0 entering,
 * 1 settled) for the screen inside to read. No JavaScript, or reduced motion: --p stays 1, the settled pose.
 */
export function Tilt({ children, face = 'left', radius = '1.1rem', className = '' }: { children: React.ReactNode; face?: 'left' | 'right'; radius?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // 0 while its middle is at the foot of the screen, 1 once its middle is 45% of the way up.
      const p = Math.min(1, Math.max(0, (vh - (r.top + r.height / 2)) / (vh * 0.55)));
      el.style.setProperty('--p', p.toFixed(3));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { update(); window.addEventListener('scroll', onScroll, { passive: true }); window.addEventListener('resize', onScroll); }
      else { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); }
    }, { rootMargin: '20% 0px' });
    io.observe(el);
    update();
    return () => { io.disconnect(); window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, []);
  // Facing left: the right edge turns away, so the screen looks back towards text on its left.
  const y = face === 'left' ? 1 : -1;
  return (
    <div ref={ref} className={className} style={{ ['--p' as string]: 1, perspective: '1600px' }}>
      <div
        className="relative will-change-transform"
        style={{
          transformStyle: 'preserve-3d',
          transformOrigin: '50% 60%',
          transform: `rotateX(calc(9deg + (1 - var(--p)) * 14deg)) rotateY(calc(${y} * (13deg + (1 - var(--p)) * 9deg))) translateY(calc((1 - var(--p)) * 28px))`,
        }}
      >
        {Array.from({ length: DEPTH }, (_, i) => (
          <div
            key={i}
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              borderRadius: radius,
              transform: `translateZ(${-(i + 1) * 1.6}px)`,
              background: i === DEPTH - 1 ? '#0B0812' : i % 2 ? '#2B2537' : '#332C41',
              boxShadow: i === DEPTH - 1 ? '0 60px 80px -30px rgba(21,16,31,0.55)' : undefined,
            }}
          />
        ))}
        <div className="relative" style={{ borderRadius: radius, transform: 'translateZ(0)' }}>
          {children}
          {/* Light across the glass. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ borderRadius: radius, background: 'linear-gradient(115deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.04) 32%, rgba(255,255,255,0) 55%)' }} />
        </div>
      </div>
    </div>
  );
}
