'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/app/shared/engine/api';
import { AnalyticsView } from '@/app/shared/engine/Analytics';
import { EfficiencyView } from '@/app/shared/epa/EfficiencyView';
import Link from 'next/link';
import { paths } from '@/lib/paths';
import type { AnalyticsReport } from '@/lib/server/analytics/kpis';

interface Res { report: AnalyticsReport; people: Array<{ id: string; name: string }>; me: string; admin: boolean }

/**
 * Analytics: Efficiency first (docs/epa.md: the share of time on conveyancer-only work), then Cases (the firm, or one
 * person, for all cases or one kind: ?view=cases&person=&side=).
 */
export default function AnalyticsPage() {
  return <Suspense fallback={<div style={{ padding: 20, color: '#64748b' }}>Loading…</div>}><Analytics /></Suspense>;
}

const TABS_CSS = `.an-tabs{display:inline-flex;background:#f1f5f9;border-radius:9px;padding:3px;margin-left:6px}.an-tabs a{font-size:13px;font-weight:700;color:#64748b;padding:5px 12px;border-radius:7px;text-decoration:none}.an-tabs a.on{background:#fff;color:#0f172a;box-shadow:0 1px 2px rgba(15,23,42,.08)}`;

function Tabs({ view }: { view: 'efficiency' | 'cases' }) {
  return (
    <span className="an-tabs" role="tablist">
      <style>{TABS_CSS}</style>
      <Link role="tab" aria-selected={view === 'efficiency'} className={view === 'efficiency' ? 'on' : ''} href={paths.analytics}>Efficiency</Link>
      <Link role="tab" aria-selected={view === 'cases'} className={view === 'cases' ? 'on' : ''} href={`${paths.analytics}?view=cases`}>Cases</Link>
    </span>
  );
}

function Analytics() {
  const params = useSearchParams();
  return params.get('view') === 'cases' ? <Cases /> : <div style={{ padding: '18px 22px' }}><EfficiencyView tabs={<Tabs view="efficiency" />} /></div>;
}

function Cases() {
  const params = useSearchParams();
  const router = useRouter();
  const person = params.get('person') ?? '';
  const side = params.get('side') ?? '';
  const [res, setRes] = useState<Res | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ ...(person ? { person } : {}), ...(side ? { side } : {}) });
      setRes(await api<Res>(`/analytics${q.size ? `?${q}` : ''}`));
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load the figures.');
    }
  }, [person, side]);
  useEffect(() => { void load(); }, [load]);
  if (err) return <div className="eg-err" style={{ margin: 20 }}>{err}</div>;
  if (!res) return <div style={{ padding: 20, color: '#64748b' }}>Loading…</div>;
  return (
    <div style={{ padding: '18px 22px' }}>
      <AnalyticsView
        report={res.report}
        people={res.people}
        person={person}
        side={side}
        admin={res.admin}
        tabs={<Tabs view="cases" />}
        onScope={(p, s) => { const q = new URLSearchParams({ view: 'cases', ...(p ? { person: p } : {}), ...(s ? { side: s } : {}) }); setRes(null); router.push(`${paths.analytics}?${q}`); }}
        caseHref={(id) => paths.matter(id)}
        feesHref={res.admin ? `${paths.admin}?tab=firm` : null}
      />
    </div>
  );
}
