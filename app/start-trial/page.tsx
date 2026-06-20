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

    // Forward the referral code as Stripe's client_reference_id (falls back to a
    // ref cookie set when the visitor first landed via a referral link). It surfaces
    // on checkout.session.completed, where the referral edge is bound.
    const cookieRef = document.cookie.match(/(?:^|;\s*)cl_ref=([^;]+)/)?.[1];
    const ref = searchParams.get('ref') || (cookieRef ? decodeURIComponent(cookieRef) : '');
    if (ref) dest.searchParams.set('client_reference_id', ref);

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
    <main className="flex min-h-screen items-center justify-center bg-paper text-ink">
      <p className="text-lg font-semibold text-ink-soft">Taking you to checkout…</p>
    </main>
  );
}

export default function StartTrialPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-paper text-ink">
          <p className="text-lg font-semibold text-ink-soft">Taking you to checkout…</p>
        </main>
      }
    >
      <Redirector />
    </Suspense>
  );
}
