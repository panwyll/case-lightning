'use client';

import { useEffect } from 'react';

/**
 * Records that a page was opened, so the admin dashboard can answer
 * "has Dave even looked at it yet?". One ping per mount; no third party,
 * no cookies beyond the session one already set.
 */
export function VisitBeacon({ slug, path }: { slug?: string | null; path: string }) {
  useEffect(() => {
    const body = JSON.stringify({ slug: slug ?? null, path, referrer: document.referrer || undefined });
    // keepalive so the ping survives an immediate navigation away.
    fetch('/api/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      // Monitoring is best-effort; never let it surface to a guest.
    });
  }, [slug, path]);

  return null;
}
