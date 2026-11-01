'use client';
import { useEffect, useRef } from 'react';

/** The screen inside eases out from a slight zoom as the device settles. */
export const SCREEN_ZOOM: React.CSSProperties = { transformOrigin: '50% 0%', transform: 'scale(calc(1 + (1 - var(--p)) * 0.06))' };

/**
 * A screenshot as a device in space: tipped back while it is low on the screen, settling to a slight resting tilt as it
 * scrolls up to the middle. Sets --p (0 entering, 1 settled) for the device and the screen inside it to read. No
 * JavaScript, or reduced motion: --p stays 1, the settled pose.
 */
export function Tilt({ children, className = '' }: { children: React.ReactNode; className?: string }) {
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
  return (
    <div ref={ref} className={className} style={{ ['--p' as string]: 1, perspective: '1800px' }}>
      <div
        className="will-change-transform"
        style={{ transformOrigin: '50% 100%', transform: 'rotateX(calc(4deg + (1 - var(--p)) * 16deg)) rotateY(calc(-5deg + (1 - var(--p)) * 3deg)) translateY(calc((1 - var(--p)) * 24px))' }}
      >
        {children}
      </div>
    </div>
  );
}
