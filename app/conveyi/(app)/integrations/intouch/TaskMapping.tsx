'use client';
/**
 * Which InTouch task each step done in CONVEYi ticks off (lib/server/integrations/intouch/task-steps.ts): by its name
 * unless the firm picks one, or never. The firm's own task names are read from its InTouch cases.
 */
import { useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';

type Res = { connected: boolean; names: string[]; map: Record<string, string>; steps: Array<{ key: string; label: string; byName: string | null }> };

export function TaskMapping({ canManage }: { canManage: boolean }) {
  const [r, setR] = useState<Res | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => { api<Res>('/integrations/intouch/tasks').then(setR).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not read your InTouch tasks.')); }, []);
  const set = async (key: string, value: string) => {
    if (!r) return;
    const map = { ...r.map };
    if (value) map[key] = value; else delete map[key];
    setSaving(key);
    try { await api('/integrations/intouch/writeback', { method: 'POST', body: JSON.stringify({ taskMap: map }) }); setR({ ...r, map }); setErr(null); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not save.'); }
    setSaving(null);
  };
  if (err && !r) return <div className="eg-err">{err}</div>;
  if (!r) return <div className="eg-sub">Reading your InTouch tasks…</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.4fr)', gap: '6px 14px', alignItems: 'center', marginTop: 10 }}>
      <span className="eg-sub" style={{ fontWeight: 800 }}>Done In CONVEYi</span>
      <span className="eg-sub" style={{ fontWeight: 800 }}>Ticks Off In InTouch</span>
      {r.steps.map((s) => (
        <div key={s.key} style={{ display: 'contents' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{s.label}</span>
          <select className="eg-sel" disabled={!canManage || saving === s.key} value={r.map[s.key] ?? ''} onChange={(e) => void set(s.key, e.target.value)} aria-label={`InTouch task for ${s.label}`}>
            <option value="">{s.byName ? `By Name: ${s.byName}` : 'By Name: No Matching Task'}</option>
            {r.names.map((n) => <option key={n} value={n}>{n}</option>)}
            <option value="none">Don&rsquo;t Tick Anything Off</option>
          </select>
        </div>
      ))}
      {err && <div className="eg-err" style={{ gridColumn: '1 / -1' }}>{err}</div>}
    </div>
  );
}
