'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type Panel = { src: string; alt: string };

/**
 * Horizontal carousel for the product panels.
 *
 * Scrolling is CSS scroll-snap, not JS animation — so a swipe on a phone, a trackpad
 * flick and the arrow buttons all use the same mechanism and it still works if the JS
 * hasn't hydrated. The script only adds the affordances a pure-CSS version can't have:
 * arrows, dots, and knowing which panel you're on.
 *
 * The panels carry their own headline and body copy inside the artwork, so there is no
 * caption here by design — it would say the same thing twice.
 */
export function PanelCarousel({ panels }: { panels: Panel[] }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  // Derive the active panel from real scroll position rather than tracking it ourselves,
  // so a swipe, a keypress and an arrow click can't disagree about where we are.
  const onScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    setIndex(Math.max(0, Math.min(panels.length - 1, i)));
  }, [panels.length]);

  // Deliberately an instant jump: no scrollTo({behavior:'smooth'}) and no CSS
  // scroll-smooth on the track. Smooth scrolling silently does NOTHING in some engines
  // (verified — the arrows and dots moved the state but never the panel, via both
  // routes), and a carousel whose buttons might not move anything is worse than one
  // that doesn't animate. Swiping still feels right because snap points do that work.
  const goTo = useCallback((i: number) => {
    const el = trackRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(panels.length - 1, i));
    el.scrollLeft = clamped * el.clientWidth;
    setIndex(clamped);
  }, [panels.length]);

  // Left/right arrows when the carousel has focus — expected of anything that behaves
  // like a slideshow, and free to support.
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

  const atStart = index === 0;
  const atEnd = index === panels.length - 1;

  return (
    <div className="relative">
      <div
        ref={trackRef}
        onScroll={onScroll}
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
              // Only the first panel is worth fetching eagerly; the rest are off-screen
              // and would just compete for bandwidth on load.
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
