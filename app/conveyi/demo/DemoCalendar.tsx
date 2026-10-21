'use client';
import { useEffect } from 'react';
import Script from 'next/script';

/**
 * The booking calendar (Calendly's inline scheduler) on our own page: the visitor picks a time without leaving.
 * When they book, the booking is recorded with where they came from (app/api/v1/demo-request) and counted as a
 * conversion; Calendly itself emails both sides.
 */
export function DemoCalendar({ url }: { url: string }) {
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== 'https://calendly.com' || e.data?.event !== 'calendly.event_scheduled') return;
      const p = e.data.payload ?? {};
      void fetch('/api/v1/demo-request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bookingEventUri: p.event?.uri, bookingInviteeUri: p.invitee?.uri }) }).catch(() => {});
      const w = window as unknown as { gtag?: (...a: unknown[]) => void };
      w.gtag?.('event', 'demo_booked', { page_location: window.location.href });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return (
    <>
      <div className="calendly-inline-widget overflow-hidden rounded-3xl border border-line bg-white shadow-card" data-url={url} style={{ minWidth: 300, height: 700 }} />
      <Script src="https://assets.calendly.com/assets/external/widget.js" strategy="afterInteractive" />
    </>
  );
}
