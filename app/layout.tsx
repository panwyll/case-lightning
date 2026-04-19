import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';

const GA_ID = process.env.NEXT_PUBLIC_GA_ID;

export const metadata: Metadata = {
  title: 'CaseLightning — Handle More Cases. Reply Faster.',
  description:
    'CaseLightning turns messy case email threads into a clear summary and fast next actions inside Outlook. Built for small law firms and conveyancers.',
  icons: {
    icon: '/favicon.svg',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}

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
