'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/app/shared/engine/api';
import { AnalyticsView } from '@/app/shared/engine/Analytics';
import { TimeView, WeekByWeek } from '@/app/shared/epa/TimeView';
import { paths } from '@/lib/paths';
import type { AnalyticsReport } from '@/lib/server/analytics/kpis';

interface Res { report: AnalyticsReport; people: Array<{ id: string; name: string }>; me: string; admin: boolean }

/**
 * Analytics: Time first (docs/epa.md: this week's red / amber / green, the Pareto and what to do about it), then Cases,
 * with week by week at its foot (the firm, or one
 * person, for all cases or one kind: ?view=cases&person=&side=).
 */
export default function AnalyticsPage() {
  return <Suspense fallback={<div style={{ padding: 20, color: '#64748b' }}>Loading…</div>}><Analytics /></Suspense>;
}

const TABS_CSS = `.an-tabs{display:inline-flex;background:#f1f5f9;border-radius:9px;padding:3px;margin-left:6px}.an-tabs a{font-size:13px;font-weight:700;color:#64748b;padding:5px 12px;border-radius:7px;text-decoration:none}.an-tabs a.on{background:#fff;color:#0f172a;box-shadow:0 1px 2px rgba(15,23,42,.08)}`;

type View = 'time' | 'cases';
const TAB: ReadonlyArray<[View, string, string]> = [['time', 'Time', paths.analytics], ['cases', 'Cases', `${paths.analytics}?view=cases`]];

/** The tabs switch in place: both are loaded when Analytics opens, so switching never waits. The address follows. */
function Tabs({ view, pick }: { view: View; pick: (v: View) => void }) {
  return (
    <span className="an-tabs" role="tablist">
      <style>{TABS_CSS}</style>
      {TAB.map(([v, label, href]) => (
        <a key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} href={href}
          onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); pick(v); }}>{label}</a>
      ))}
    </span>
  );
}

function Analytics() {
  const params = useSearchParams();
  const [view, setView] = useState<View>(params.get('view') === 'cases' ? 'cases' : 'time');
  const pick = (v: View) => {
    setView(v);
    const q = new URLSearchParams(window.location.search);
    if (v === 'cases') q.set('view', 'cases'); else q.delete('view');
    window.history.replaceState(null, '', `${paths.analytics}${q.size ? `?${q}` : ''}`);
  };
  const tabs = <Tabs view={view} pick={pick} />;
  return (
    <>
      <div style={{ padding: '18px 22px', display: view === 'time' ? undefined : 'none' }}><TimeView tabs={tabs} /></div>
      <div style={{ display: view === 'cases' ? undefined : 'none' }}><Cases tabs={tabs} /></div>
    </>
  );
}

function Cases({ tabs }: { tabs: React.ReactNode }) {
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
  // Until the figures arrive, the title and the tabs stay so the other tab is one click away.
  const head = <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}><h1 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Analytics</h1>{tabs}</div>;
  if (err) return <div style={{ padding: '18px 22px' }}>{head}<div className="eg-err">{err}</div></div>;
  if (!res) return <div style={{ padding: '18px 22px' }}>{head}<div style={{ color: '#64748b', fontSize: 13.5 }}>Loading…</div></div>;
  return (
    <div style={{ padding: '18px 22px' }}>
      <AnalyticsView
        report={res.report}
        people={res.people}
        person={person}
        side={side}
        admin={res.admin}
        tabs={tabs}
        onScope={(p, s) => { const q = new URLSearchParams({ view: 'cases', ...(p ? { person: p } : {}), ...(s ? { side: s } : {}) }); setRes(null); router.push(`${paths.analytics}?${q}`); }}
        caseHref={(id) => paths.matter(id)}
        feesHref={res.admin ? `${paths.admin}?tab=firm` : null}
      />
      <WeekByWeek />
    </div>
  );
}
