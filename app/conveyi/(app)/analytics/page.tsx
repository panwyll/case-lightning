'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/app/shared/engine/api';
import { AnalyticsView } from '@/app/shared/engine/Analytics';
import { paths } from '@/lib/paths';
import type { AnalyticsReport } from '@/lib/server/analytics/kpis';

interface Res { report: AnalyticsReport; people: Array<{ id: string; name: string }>; me: string; admin: boolean }

/** The firm's analytics: the firm, or one person, for all cases or one kind (?person=&side=). */
export default function AnalyticsPage() {
  return <Suspense fallback={<div style={{ padding: 20, color: '#64748b' }}>Loading…</div>}><Analytics /></Suspense>;
}

function Analytics() {
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
        onScope={(p, s) => { const q = new URLSearchParams({ ...(p ? { person: p } : {}), ...(s ? { side: s } : {}) }); setRes(null); router.push(`${paths.analytics}${q.size ? `?${q}` : ''}`); }}
        caseHref={(id) => paths.matter(id)}
      />
    </div>
  );
}
