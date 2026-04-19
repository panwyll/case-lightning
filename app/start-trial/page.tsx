'use client';

import { useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

const STRIPE_URL = process.env.NEXT_PUBLIC_STRIPE_PAYMENT_LINK ?? '';

const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

function Redirector() {
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!STRIPE_URL) return;

    // Build the Stripe URL, forwarding all UTM params so attribution is preserved
    const dest = new URL(STRIPE_URL);
    for (const key of UTM_KEYS) {
      const val = searchParams.get(key);
      if (val) dest.searchParams.set(key, val);
    }

    // Fire a GA4 event before leaving so we can track funnel entry.
    // transport_type 'beacon' uses sendBeacon, which survives page unload reliably.
    if (typeof (window as any).gtag === 'function') {
      (window as any).gtag('event', 'begin_trial', {
        utm_source: searchParams.get('utm_source') ?? undefined,
        utm_medium: searchParams.get('utm_medium') ?? undefined,
        utm_campaign: searchParams.get('utm_campaign') ?? undefined,
        utm_content: searchParams.get('utm_content') ?? undefined,
        page_location: window.location.href,
        transport_type: 'beacon',
      });
    }

    window.location.replace(dest.toString());
  }, [searchParams]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 text-white">
      <p className="text-lg font-semibold text-slate-400">Taking you to checkout…</p>
    </main>
  );
}

export default function StartTrialPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-slate-950 text-white">
          <p className="text-lg font-semibold text-slate-400">Taking you to checkout…</p>
        </main>
      }
    >
      <Redirector />
    </Suspense>
  );
}
