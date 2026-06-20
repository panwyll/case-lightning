import type { Metadata } from 'next';
import Script from 'next/script';
import { Suspense } from 'react';
import { Fraunces, Manrope } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import RefCapture from './_components/RefCapture';
import Track from './_components/Track';
import './globals.css';

const GA_ID = process.env.NEXT_PUBLIC_GA_ID;

// Editorial display serif + clean grotesk-ish sans — deliberately not Inter/Roboto.
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', display: 'swap' });
const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });

export const metadata: Metadata = {
  title: {
    default: 'Case Lightning — Case management native to your OS and inbox',
    template: '%s',
  },
  description:
    'Case Lightning builds case management for finance, legal and document-heavy practices — native to the operating system and email you already use. CONVEYi for conveyancing, plus custom builds.',
  icons: {
    icon: '/favicon.svg',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${manrope.variable}`}>
      <head>
        <Script id="gtm-head" strategy="afterInteractive">
          {`
            (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
            new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
            j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
            'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
            })(window,document,'script','dataLayer','GTM-KBQM39CV');
          `}
        </Script>
      </head>
      <body>
          <noscript>
            <iframe
              src="https://www.googletagmanager.com/ns.html?id=GTM-KBQM39CV"
              height="0"
              width="0"
              style={{ display: 'none', visibility: 'hidden' }}
            />
          </noscript>
        <Suspense fallback={null}>
          <RefCapture />
          <Track />
        </Suspense>
        {children}
        <Analytics />

        {/* Google Analytics 4 — set NEXT_PUBLIC_GA_ID in your environment */}
        {GA_ID && (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
              strategy="afterInteractive"
            />
            <Script id="ga4-init" strategy="afterInteractive">{`
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', '${GA_ID}', {
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
      </body>
    </html>
  );
}
