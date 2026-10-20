'use client';
import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { Analytics } from '@vercel/analytics/next';

/**
 * A client's own link carries its secret in the address (/portal/<token>, /f/<token>, /pof/<token>). Those pages are
 * the firm's, not ours: no tag manager, no Google Analytics, no Vercel Analytics and no first-party pageview, so the
 * link never reaches a third party and the client sees nothing of us.
 */
export const CLIENT_LINK = /^\/(portal|f|pof)(\/|$)/;

/** The site's analytics, everywhere but a client's own link. GA4 needs NEXT_PUBLIC_GA_ID. */
export default function SiteAnalytics({ gaId }: { gaId?: string }) {
  const pathname = usePathname();
  if (!pathname || CLIENT_LINK.test(pathname)) return null;
  return (
    <>
      <Script id="gtm-head" strategy="afterInteractive">
        {`
          (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
          new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
          j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
          'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
          })(window,document,'script','dataLayer','GTM-KBQM39CV');
        `}
      </Script>
      <noscript>
        <iframe
          src="https://www.googletagmanager.com/ns.html?id=GTM-KBQM39CV"
          height="0"
          width="0"
          style={{ display: 'none', visibility: 'hidden' }}
        />
      </noscript>
      <Analytics />
      {gaId && (
        <>
          <Script src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`} strategy="afterInteractive" />
          <Script id="ga4-init" strategy="afterInteractive">{`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${gaId}', {
              send_page_view: true,
              allow_google_signals: true,
              allow_ad_personalization_signals: false
            });
            /* Track CTA clicks as GA4 events using data-cta attributes */
            document.addEventListener('click', function(e) {
              var el = e.target && e.target.closest('[data-cta]');
              if (el) {
                gtag('event', 'cta_click', {
                  cta_id: el.getAttribute('data-cta'),
                  page_location: window.location.href
                });
              }
            });
          `}</Script>
        </>
      )}
    </>
  );
}
