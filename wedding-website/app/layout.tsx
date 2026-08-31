import type { Metadata } from 'next';
import { wedding } from '@/content/wedding';
import './globals.css';

export const metadata: Metadata = {
  title: `${wedding.partnerOne} & ${wedding.partnerTwo}`,
  description: 'A private wedding website.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Loaded via link rather than next/font so a build never depends on
            reaching Google. The CSS fallbacks in globals.css cover failure. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
