import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], display: 'swap' });

export const metadata: Metadata = {
  title: 'CaseLightning — Handle More Cases. Reply Faster.',
  description:
    'CaseLightning turns messy case email threads into a clear summary and fast next actions inside Outlook. Built for small law firms and conveyancers.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.className}>
      <body>{children}</body>
    </html>
  );
}
