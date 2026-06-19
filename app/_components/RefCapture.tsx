'use client';

import { useEffect } from 'react';

/**
 * Persists a `?ref=<code>` from any landing URL into a `cl_ref` cookie (90 days)
 * so the referral code survives navigation to /start-trial, where it's forwarded
 * to Stripe as client_reference_id. First-touch wins (doesn't overwrite an
 * existing ref).
 */
export default function RefCapture() {
  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get('ref');
    if (!ref) return;
    if (document.cookie.includes('cl_ref=')) return;
    const clean = ref.replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
    if (!clean) return;
    document.cookie = `cl_ref=${encodeURIComponent(clean)}; path=/; max-age=${60 * 60 * 24 * 90}; samesite=lax`;
  }, []);
  return null;
}
