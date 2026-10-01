import { notFound } from 'next/navigation';
import { DevAnalytics } from './DevAnalytics';

/** Local development only: the analytics page over a made-up firm's two years of cases (lib/server/analytics/demo.ts). */
export default function DevAnalyticsPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <DevAnalytics />;
}
