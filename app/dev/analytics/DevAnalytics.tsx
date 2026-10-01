'use client';
import { useMemo, useState } from 'react';
import { AnalyticsView } from '@/app/shared/engine/Analytics';
import { computeAnalytics, type CaseSide } from '@/lib/server/analytics/kpis';
import { demoAnalyticsInput, DEMO_PEOPLE } from '@/lib/server/analytics/demo';

export function DevAnalytics() {
  const input = useMemo(() => demoAnalyticsInput(new Date()), []);
  const [scope, setScope] = useState({ person: '', side: '' });
  const report = useMemo(() => computeAnalytics(input, { personId: scope.person || null, side: (scope.side || null) as CaseSide | null }), [input, scope]);
  return (
    <div style={{ background: '#f6f7fb', minHeight: '100vh', padding: '18px 22px', fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif' }}>
      <AnalyticsView report={report} people={DEMO_PEOPLE} person={scope.person} side={scope.side} admin onScope={(person, side) => setScope({ person, side })} caseHref={() => null} />
    </div>
  );
}
