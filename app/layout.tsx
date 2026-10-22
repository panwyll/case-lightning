import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Hanken_Grotesk, Manrope } from 'next/font/google';
import RefCapture from './_components/RefCapture';
import Track from './_components/Track';
import SiteAnalytics from './_components/SiteAnalytics';
import './globals.css';

const GA_ID = process.env.NEXT_PUBLIC_GA_ID;

// A plain grotesk for headings (with a true italic) + a clean sans for text — deliberately not Inter/Roboto.
const display = Hanken_Grotesk({ subsets: ['latin'], style: ['normal', 'italic'], variable: '--font-display', display: 'swap' });
const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });

export const metadata: Metadata = {
  title: {
    default: 'Case Lightning — Case management native to your OS and inbox',
    template: '%s',
  },
  description:
    'Case Lightning builds case management for finance, legal and document-heavy practices — native to the operating system and email you already use. CONVEYi for conveyancing, plus custom builds.',
  // The SVG where it is supported; PNG and ICO for Safari, search results and older browsers; the Apple icon for home screens.
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/icon-48.png', sizes: '48x48', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    shortcut: '/favicon.ico',
    apple: { url: '/apple-touch-icon.png', sizes: '180x180' },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${manrope.variable}`}>
      <body>
        <Suspense fallback={null}>
          <RefCapture />
          <Track />
        </Suspense>
        {children}
        <SiteAnalytics gaId={GA_ID} />
      </body>
    </html>
  );
}
