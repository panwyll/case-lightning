'use client';
import { useRef, useState } from 'react';

/** The video on the landing page: a still with a play button until pressed, so nothing loads before then. */
export function Vsl({ sources, poster, label }: { sources: Array<{ src: string; type: string }>; poster: string; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const play = () => {
    setPlaying(true);
    requestAnimationFrame(() => void ref.current?.play());
    const w = window as unknown as { gtag?: (...a: unknown[]) => void };
    w.gtag?.('event', 'vsl_play', { page_location: window.location.href });
  };
  return (
    <figure>
      <div className="relative aspect-video overflow-hidden rounded-2xl border border-line bg-paper-soft shadow-card">
        <video ref={ref} poster={poster} controls={playing} playsInline preload="none" className="absolute inset-0 h-full w-full" aria-label={label}>
          {sources.map((s) => <source key={s.src} src={s.src} type={s.type} />)}
        </video>
        {!playing && (
          <button type="button" onClick={play} className="group absolute inset-0 flex items-center justify-center" aria-label={`Play: ${label}`} data-cta="vsl_play">
            <span className="flex h-20 w-20 items-center justify-center rounded-full bg-violet text-white shadow-violet transition group-hover:scale-105 md:h-24 md:w-24">
              <svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" /></svg>
            </span>
            <span className="absolute bottom-4 right-4 rounded-full bg-ink/80 px-3 py-1 text-sm font-semibold text-paper">0:43</span>
          </button>
        )}
      </div>
      <figcaption className="mt-2 text-xs text-ink-soft">Demo firm. Names, addresses and figures are made up.</figcaption>
    </figure>
  );
}
