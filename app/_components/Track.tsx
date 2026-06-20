'use client';

import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

// Don't track the product add-in, the internal dashboard, admin, or API routes —
// the funnel is about the marketing site / acquisition only.
const SKIP = /^\/(addin|admin|internal|api)(\/|$)/;

/**
 * Fires a first-party pageview beacon (/api/v1/track) on first load and on every
 * client-side route change. Best-effort and fire-and-forget; the visitor id is a
 * cookie the beacon endpoint manages.
 */
export default function Track() {
  const pathname = usePathname();
  const search = useSearchParams();

  useEffect(() => {
    if (!pathname || SKIP.test(pathname)) return;
    const payload = {
      path: pathname,
      referrer: typeof document !== 'undefined' && document.referrer ? document.referrer : undefined,
      utm_source: search.get('utm_source') ?? undefined,
      utm_medium: search.get('utm_medium') ?? undefined,
      utm_campaign: search.get('utm_campaign') ?? undefined,
    };
    fetch('/api/v1/track', {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }, [pathname, search]);

  return null;
}
