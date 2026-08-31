'use client';

import { useEffect, useState } from 'react';

/**
 * Rendered client-side only after mount, so the server and client never
 * disagree about "now" and React never warns about a hydration mismatch.
 */
export function Countdown({ iso }: { iso: string }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000 * 30);
    return () => clearInterval(timer);
  }, []);

  if (now === null) return <div className="h-16" aria-hidden />;

  const target = new Date(iso).getTime();
  const remaining = target - now;

  if (remaining <= 0) {
    return <p className="font-display text-2xl text-brass">Today is the day.</p>;
  }

  const days = Math.floor(remaining / 86_400_000);
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000);

  return (
    <div className="flex items-baseline gap-6" aria-label={`${days} days to go`}>
      <Unit value={days} label={days === 1 ? 'day' : 'days'} />
      <Unit value={hours} label={hours === 1 ? 'hour' : 'hours'} />
    </div>
  );
}

function Unit({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="font-display text-4xl leading-none text-ink">{value}</div>
      <div className="mt-1 text-xs uppercase tracking-[0.16em] text-ink-soft">{label}</div>
    </div>
  );
}
