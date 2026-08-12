'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type Panel = { src: string; alt: string };

/** How long each panel is held before advancing. */
const AUTOPLAY_MS = 5500;
/** Slide duration. Long enough to read as movement, short enough not to feel slow. */
const GLIDE_MS = 550;

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Auto-advancing carousel for the product panels.
 *
 * Scrolling is CSS scroll-snap, so a swipe and a trackpad flick behave natively. The
 * script adds what CSS can't: arrows, dots, knowing which panel you're on, and autoplay.
 *
 * The animation is a hand-rolled requestAnimationFrame tween on scrollLeft rather than
 * scrollTo({behavior:'smooth'}) or CSS scroll-smooth. BOTH of those silently do nothing
 * in some engines — the state updated and the panel never moved, which is the kind of
 * failure that ships unnoticed. A tween we drive ourselves works everywhere and lets us
 * pick the duration.
 *
 * The panels carry their own headline and copy inside the artwork, so there is no caption
 * here by design — it would say the same thing twice.
 */
export function PanelCarousel({ panels }: { panels: Panel[] }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  // Autoplay stops for good once someone takes control — an arrow, a dot, a keypress or
  // a swipe. Fighting a user who has chosen a panel is worse than not auto-advancing.
  const [userTook, setUserTook] = useState(false);
  const [paused, setPaused] = useState(false);
  const rafRef = useRef<number | null>(null);
  const landRef = useRef<number | null>(null);

  // Two writers, deliberately. glideTo sets the index for moves WE command, and this
  // reconciles it from real scroll position for moves the user makes (swipe, trackpad,
  // native scroll). Neither alone is enough: scroll events don't fire in every context
  // (verified — a background tab dispatches none at all, which froze the dots), and an
  // optimistic value alone can't see a swipe. Both write, scroll wins whenever it fires,
  // and Math.round means a partial scroll still resolves to the nearest panel.
  const onScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    setIndex(Math.max(0, Math.min(panels.length - 1, i)));
  }, [panels.length]);

  const glideTo = useCallback((i: number, animate: boolean) => {
    const el = trackRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(panels.length - 1, i));
    const to = clamped * el.clientWidth;
    setIndex(clamped);

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    // Reduced motion, or an explicit jump: land immediately.
    const reduce =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduce) {
      el.scrollLeft = to;
      return;
    }

    const from = el.scrollLeft;
    if (Math.abs(to - from) < 1) return;
    const start = performance.now();

    const settle = () => {
      rafRef.current = null;
      if (landRef.current !== null) { clearTimeout(landRef.current); landRef.current = null; }
    };

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / GLIDE_MS);
      el.scrollLeft = from + (to - from) * easeOutCubic(t);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        settle();
      }
    };
    rafRef.current = requestAnimationFrame(step);

    // Guaranteed landing. requestAnimationFrame is paused entirely in a background tab
    // (verified: zero callbacks), and this is the third animation route this session that
    // silently moved nothing — scrollTo({behavior:'smooth'}) and CSS scroll-smooth were
    // the first two. If the tween hasn't arrived by the time it should have, put the
    // panel where it belongs. Getting there always matters more than the glide.
    if (landRef.current !== null) clearTimeout(landRef.current);
    landRef.current = window.setTimeout(() => {
      if (Math.abs(el.scrollLeft - to) > 1) el.scrollLeft = to;
      settle();
    }, GLIDE_MS + 80);
  }, [panels.length]);

  /** Navigation the user asked for — cancels autoplay. */
  const goTo = useCallback((i: number) => {
    setUserTook(true);
    glideTo(i, true);
  }, [glideTo]);

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (landRef.current !== null) clearTimeout(landRef.current);
  }, []);

  // Left/right arrows when the carousel has focus.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); goTo(index + 1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(index - 1); }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [goTo, index]);

  // Autoplay. Held while the pointer is over it or focus is inside (so it can't slide out
  // from under someone reading or tabbing), while the tab is hidden, and under
  // prefers-reduced-motion it never starts at all.
  useEffect(() => {
    if (userTook || paused) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const tick = () => {
      if (document.hidden) return;
      const el = trackRef.current;
      if (!el) return;
      const at = Math.round(el.scrollLeft / el.clientWidth);
      glideTo(at >= panels.length - 1 ? 0 : at + 1, true);
    };
    const id = window.setInterval(tick, AUTOPLAY_MS);
    return () => window.clearInterval(id);
  }, [userTook, paused, glideTo, panels.length]);

  const atStart = index === 0;
  const atEnd = index === panels.length - 1;

  return (
    <div
      className="relative"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div
        ref={trackRef}
        onScroll={onScroll}
        onPointerDown={() => setUserTook(true)}
        tabIndex={0}
        role="group"
        aria-roledescription="carousel"
        aria-label="What CONVEYi looks like"
        className="flex snap-x snap-mandatory overflow-x-auto rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-violet [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {panels.map((p, i) => (
          <div
            key={p.src}
            className="w-full shrink-0 snap-start"
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${panels.length}`}
          >
            <img
              src={p.src}
              alt={p.alt}
              width={1366}
              height={768}
              // Only the first is worth fetching eagerly; autoplay reaches the rest soon
              // enough, and eager-loading all five just competes for bandwidth on load.
              loading={i === 0 ? undefined : 'lazy'}
              className="w-full rounded-2xl border border-line"
            />
          </div>
        ))}
      </div>

      <Arrow side="left" disabled={atStart} onClick={() => goTo(index - 1)} />
      <Arrow side="right" disabled={atEnd} onClick={() => goTo(index + 1)} />

      <div className="mt-5 flex items-center justify-center gap-2.5">
        {panels.map((p, i) => (
          <button
            key={p.src}
            type="button"
            onClick={() => goTo(i)}
            aria-label={`Go to panel ${i + 1}`}
            aria-current={i === index}
            className={`h-2 rounded-full transition-all ${
              i === index ? 'w-6 bg-violet' : 'w-2 bg-ink/20 hover:bg-ink/40'
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function Arrow({ side, disabled, onClick }: { side: 'left' | 'right'; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={side === 'left' ? 'Previous panel' : 'Next panel'}
      className={`absolute top-1/2 hidden -translate-y-1/2 items-center justify-center rounded-full border border-line bg-paper/90 p-2.5 shadow-sm backdrop-blur transition hover:bg-paper disabled:pointer-events-none disabled:opacity-0 md:flex ${
        side === 'left' ? 'left-3' : 'right-3'
      }`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
        <path d={side === 'left' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
      </svg>
    </button>
  );
}
