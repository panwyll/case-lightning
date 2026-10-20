import type { Metadata } from 'next';

/** The tab says "Your Case" until the page knows the property and the firm (page.tsx sets both). */
export const metadata: Metadata = { title: 'Your Case', robots: { index: false, follow: false } };

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return children;
}
