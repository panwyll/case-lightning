import type { Metadata } from 'next';
import Script from 'next/script';

export const metadata: Metadata = {
  title: 'CaseLightning — Outlook',
  robots: { index: false, follow: false },
};

/**
 * Layout for the Office add-in surfaces (taskpane + commands). Loads Office.js
 * from the Microsoft CDN and renders a clean light UI suited to embedding inside
 * Outlook, independent of the dark marketing theme on <body>.
 */
export default function AddinLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#ffffff',
        color: '#0f172a',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <Script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js" strategy="afterInteractive" />
      {children}
    </div>
  );
}
