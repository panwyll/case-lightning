import type { Metadata } from 'next';
import { ctaHref, NavHeader, ROUTES, SiteFooter } from '../../../_components/shared';
import { leadScanView } from '@/lib/server/lead-scan';
import { ScanResult } from './ScanResult';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Your Inbox Scan | CONVEYi', robots: { index: false, follow: false } };

/** A free scan's page (lib/server/lead-scan.ts): runs it while it is open, then shows the result. Reached by its secret link. */
export default async function ScanResultPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const initial = await leadScanView(token).catch(() => null);
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.demo, 'scan_result', 'nav_demo')} signupLabel="Book A Demo" />
      <ScanResult token={token} initial={initial} demoHref={ctaHref(ROUTES.demo, 'scan_result', 'result_demo')} />
      <SiteFooter />
    </main>
  );
}
