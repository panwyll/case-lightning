'use client';
import { Spin } from '@/app/shared/engine/BusyButton';
import { BackLink } from '@/app/shared/BackLink';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { fmtWhen } from '@/app/shared/engine/types';
import { paths } from '@/lib/paths';

/**
 * The scenario library: one scripted case per transaction type, run through the real engine
 * onto a sandbox case so a person can walk every path of the flowchart on the real screens.
 */
interface Step { id: string; label: string }
interface Scenario { id: string; label: string; transactionType: string; summary: string; steps: { clean: Step[]; flagged: Step[] } }
interface Sandbox { id: string; matterRef: string; propertyAddress: string; scenario: string | null; step: string | null; createdAt: string; stage: string | null }

const CSS = `
.sc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.sc-card{background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.sc-card h2{font-size:15px;font-weight:800;margin:0}
.sc-card p{margin:0;font-size:12.5px;color:#475569;line-height:1.45}
.sc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sc-sel{font-size:12.5px;border:1px solid #e2e8f0;border-radius:8px;padding:6px 8px;background:#fff;max-width:100%}
.sc-switch{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;cursor:pointer}
.sc-switch input{width:15px;height:15px;margin:0;accent-color:#5A27E0}
.sc-list{background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden}
.sc-list table{width:100%;border-collapse:collapse;font-size:12.5px}
.sc-list th{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#94a3b8;text-align:left;padding:8px 12px;background:#fafafa}
.sc-list td{padding:8px 12px;border-top:1px solid #f1f5f9;vertical-align:top}
.sc-result{font-size:12.5px;background:#f8fafc;border:1px solid #e6e8ee;border-radius:8px;padding:8px 10px}
.sc-result .bad{color:#b91c1c}
`;

export default function ScenariosPage() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stopAt, setStopAt] = useState<Record<string, string>>({});
  const [flagged, setFlagged] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<Record<string, { matterId: string; matterRef: string; steps: Array<{ id: string; label: string; ok: boolean; error?: string }> }>>({});
  const load = useCallback(() => api<{ scenarios: Scenario[]; sandboxes: Sandbox[] }>('/engine/scenarios').then((r) => { setScenarios(r.scenarios); setSandboxes(r.sandboxes); }).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load the library.')), []);
  useEffect(() => { void load(); }, [load]);

  const run = async (s: Scenario, mode: 'run' | 'step' = 'run') => {
    setBusy(s.id);
    setErr(null);
    try {
      const r = await api<{ matterId: string; matterRef: string; steps: Array<{ id: string; label: string; ok: boolean; error?: string }> }>('/engine/scenarios', { method: 'POST', body: JSON.stringify({ scenarioId: s.id, stopAt: mode === 'run' ? stopAt[s.id] || null : null, flagged: !!flagged[s.id], mode }) });
      if (mode === 'step') { window.location.href = paths.matter(r.matterId); return; }
      setResult((cur) => ({ ...cur, [s.id]: r }));
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'The run failed.');
    } finally {
      setBusy(null);
    }
  };
  const remove = async (m: Sandbox) => {
    if (!window.confirm(`Retire ${m.matterRef}? It leaves every list; its log stays.`)) return;
    setBusy(m.id);
    try { await api(`/engine/scenarios/${m.id}`, { method: 'DELETE' }); await load(); } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not retire.'); } finally { setBusy(null); }
  };

  return (
    <div className="eg" style={{ maxWidth: 1100 }}>
      <style>{ENGINE_CSS + CSS}</style>
      <div className="eg-top">
        <h1 className="eg-h1" style={{ display: 'flex', alignItems: 'center' }}><BackLink href="/conveyi/integrations" label="Back to Tools" />Scenarios</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <a className="eg-btn" href={paths.machineMap}>Machine Map</a>
        </div>
      </div>
      {err && <div className="eg-err">{err}</div>}
      <div className="sc-grid">
        {scenarios.map((s) => {
          const steps = flagged[s.id] ? s.steps.flagged : s.steps.clean;
          const r = result[s.id];
          return (
            <div key={s.id} className="sc-card">
              <h2>{s.label}</h2>
              <p>{s.summary}</p>
              <div className="sc-row">
                <select className="sc-sel" value={stopAt[s.id] ?? ''} onChange={(e) => setStopAt((cur) => ({ ...cur, [s.id]: e.target.value }))} aria-label="Stop at">
                  <option value="">Run to the end</option>
                  {steps.map((st, i) => <option key={st.id} value={st.id}>Stop after {i + 1}. {st.label}</option>)}
                </select>
              </div>
              <div className="sc-row">
                <label className="sc-switch"><input type="checkbox" checked={!!flagged[s.id]} onChange={(e) => setFlagged((cur) => ({ ...cur, [s.id]: e.target.checked }))} />Flagged branches</label>
                <button className="eg-btn" style={{ marginLeft: 'auto' }} disabled={busy !== null} onClick={() => void run(s, 'step')} title="Create the case and take it one step at a time; every proposal and decision is yours under Tasks">Start Stepping</button>
                <button className="eg-btn on" disabled={busy !== null} onClick={() => void run(s)}>{busy === s.id ? <Spin>Running…</Spin> : 'Run'}</button>
              </div>
              {r && (
                <div className="sc-result">
                  <a href={paths.matter(r.matterId)}><b>{r.matterRef}</b></a> · {r.steps.filter((x) => x.ok).length} of {r.steps.length} steps
                  {r.steps.filter((x) => !x.ok).map((x) => <div key={x.id} className="bad">{x.label}: {x.error}</div>)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="eg-sec" style={{ marginTop: 22, fontSize: 13, fontWeight: 800, color: '#0f172a' }}>Sandbox Cases</div>
      <div className="sc-list" style={{ marginTop: 8 }}>
        <table>
          <thead><tr><th>Case</th><th>Scenario</th><th>Stopped After</th><th>Stage</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {sandboxes.length === 0 && <tr><td colSpan={6} style={{ color: '#94a3b8' }}>None yet.</td></tr>}
            {sandboxes.map((m) => (
              <tr key={m.id}>
                <td><a href={paths.matter(m.id)}><b>{m.matterRef}</b></a><div style={{ color: '#64748b' }}>{m.propertyAddress}</div></td>
                <td>{m.scenario?.replace(':flagged', ' · flagged').replace(/_/g, ' ')}</td>
                <td>{m.step}</td>
                <td>{m.stage?.replace(/_/g, ' ')}</td>
                <td>{fmtWhen(m.createdAt)}</td>
                <td style={{ textAlign: 'right' }}><button className="eg-btn" disabled={busy !== null} onClick={() => void remove(m)}>Retire</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
