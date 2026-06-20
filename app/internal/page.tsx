'use client';

import { useCallback, useEffect, useState } from 'react';

/* Owner-only internal analytics dashboard. Not linked from the site; gated by
 * INTERNAL_DASHBOARD_KEY (entered once, kept in localStorage). Renders the funnel,
 * economics, acquisition/churn/MRR movement and usage from /api/v1/internal/metrics. */

const KEY_STORE = 'cl_internal_key';

const gbp = (pennies: unknown) =>
  '£' + (Number(pennies ?? 0) / 100).toLocaleString(undefined, { maximumFractionDigits: 0 });
const usd = (n: unknown) => '$' + Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n: unknown) => Number(n ?? 0).toLocaleString();
const pct = (n: unknown) => (n == null ? '—' : Number(n).toFixed(1) + '%');

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
      {sub && <div className="card-sub">{sub}</div>}
    </div>
  );
}

function Table({ columns, rows }: { columns: Array<{ key: string; label: string; fmt?: (v: unknown) => string; align?: 'right' }>; rows: any[] }) {
  if (!rows?.length) return <div className="empty">No data yet.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c.key} style={c.align === 'right' ? { textAlign: 'right' } : undefined}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key} style={c.align === 'right' ? { textAlign: 'right' } : undefined}>
                  {c.fmt ? c.fmt(r[c.key]) : String(r[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function InternalDashboard() {
  const [key, setKey] = useState('');
  const [input, setInput] = useState('');
  const [data, setData] = useState<any>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem(KEY_STORE);
    if (saved) setKey(saved);
  }, []);

  const load = useCallback(async (k: string) => {
    setStatus('loading');
    setError('');
    try {
      const res = await fetch('/api/v1/internal/metrics', { headers: { authorization: `Bearer ${k}` } });
      if (res.status === 401) {
        localStorage.removeItem(KEY_STORE);
        setKey('');
        throw new Error('Wrong key.');
      }
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      setData(await res.json());
      setStatus('idle');
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (key) load(key);
  }, [key, load]);

  if (!key) {
    return (
      <main className="gate">
        <style>{css}</style>
        <div className="gate-box">
          <h1>Internal dashboard</h1>
          <p>Enter the dashboard key (INTERNAL_DASHBOARD_KEY).</p>
          <input type="password" value={input} onChange={(e) => setInput(e.target.value)} placeholder="key" onKeyDown={(e) => e.key === 'Enter' && input && (localStorage.setItem(KEY_STORE, input), setKey(input))} />
          <button onClick={() => { if (input) { localStorage.setItem(KEY_STORE, input); setKey(input); } }}>Unlock</button>
          {error && <p className="err">{error}</p>}
        </div>
      </main>
    );
  }

  const g = data?.economics?.global;
  const r = data?.retention;
  const topVisitors = data?.funnel?.find((s: any) => s.stage_order === 1)?.count;
  const maxFunnel = Math.max(1, ...(data?.funnel?.map((s: any) => Number(s.count)) ?? [1]));

  return (
    <main className="dash">
      <style>{css}</style>
      <header>
        <h1>Case Lightning — global metrics</h1>
        <div className="actions">
          <span className="ts">{data ? `updated ${new Date(data.generatedAt).toLocaleString()}` : ''}</span>
          <button onClick={() => load(key)} disabled={status === 'loading'}>{status === 'loading' ? '…' : 'Refresh'}</button>
          <button className="ghost" onClick={() => { localStorage.removeItem(KEY_STORE); setKey(''); setData(null); }}>Lock</button>
        </div>
      </header>

      {status === 'error' && <div className="err banner">{error}</div>}
      {!data && status === 'loading' && <div className="empty">Loading…</div>}

      {data && (
        <>
          <section className="cards">
            <Card label="MRR" value={gbp(g?.total_mrr_pennies_gbp)} sub="active subscriptions" />
            <Card label="Gross profit (30d)" value={gbp(g?.gross_profit_pennies_30d)} sub="MRR − AI cost" />
            <Card label="AI cost (30d)" value={gbp(g?.ai_cost_pennies_gbp_30d)} sub={usd(g?.ai_cost_usd_30d) + ' raw'} />
            <Card label="Active customers" value={num(r?.active_now)} sub={`${num(r?.trialing_now)} trialing`} />
            <Card label="Lifetime churn" value={pct(r?.lifetime_churn_rate_pct)} sub={`${num(r?.ever_churned)} of ${num(r?.ever_paid)} paid`} />
            <Card label="Visitors" value={num(topVisitors)} sub="all time" />
          </section>

          <section className="panel">
            <h2>Acquisition funnel — where people drop out</h2>
            <div className="funnel">
              {(data.funnel ?? []).map((s: any) => (
                <div className="fstage" key={s.stage_order}>
                  <div className="frow">
                    <span className="fname">{s.stage}</span>
                    <span className="fcount">{num(s.count)}</span>
                  </div>
                  <div className="fbar-track">
                    <div className="fbar" style={{ width: `${(Number(s.count) / maxFunnel) * 100}%` }} />
                  </div>
                  <div className="fmeta">
                    <span>{pct(s.pct_of_top)} of top</span>
                    {s.conversion_from_prev_pct != null && <span>· step {pct(s.conversion_from_prev_pct)}</span>}
                    {Number(s.dropoff_from_prev) > 0 && <span className="drop">· −{num(s.dropoff_from_prev)} dropped</span>}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="grid2">
            <section className="panel">
              <h2>MRR movement (monthly)</h2>
              <Table
                rows={data.mrrMovement ?? []}
                columns={[
                  { key: 'month', label: 'Month', fmt: (v) => String(v ?? '').slice(0, 7) },
                  { key: 'new_customers', label: 'New', fmt: num, align: 'right' },
                  { key: 'new_mrr_pennies', label: '+MRR', fmt: gbp, align: 'right' },
                  { key: 'churned_customers', label: 'Churned', fmt: num, align: 'right' },
                  { key: 'churned_mrr_pennies', label: '−MRR', fmt: gbp, align: 'right' },
                  { key: 'net_mrr_pennies', label: 'Net', fmt: gbp, align: 'right' },
                ]}
              />
            </section>

            <section className="panel">
              <h2>Visits by channel</h2>
              <Table
                rows={data.visits?.byChannel ?? []}
                columns={[
                  { key: 'source', label: 'Source' },
                  { key: 'medium', label: 'Medium' },
                  { key: 'campaign', label: 'Campaign' },
                  { key: 'visitors', label: 'Visitors', fmt: num, align: 'right' },
                  { key: 'pageviews', label: 'Views', fmt: num, align: 'right' },
                ]}
              />
            </section>
          </div>

          <section className="panel">
            <h2>Profit by tenant (30d)</h2>
            <Table
              rows={data.economics?.byTenant ?? []}
              columns={[
                { key: 'tenant_name', label: 'Tenant' },
                { key: 'mrr_pennies_gbp', label: 'MRR', fmt: gbp, align: 'right' },
                { key: 'ai_cost_pennies_gbp_30d', label: 'AI cost', fmt: gbp, align: 'right' },
                { key: 'gross_profit_pennies_30d', label: 'Profit', fmt: gbp, align: 'right' },
              ]}
            />
          </section>

          <div className="grid2">
            <section className="panel">
              <h2>Usage by feature</h2>
              <Table
                rows={data.usage?.byFeature ?? []}
                columns={[
                  { key: 'feature', label: 'Feature' },
                  { key: 'calls', label: 'Calls', fmt: num, align: 'right' },
                  { key: 'users', label: 'Users', fmt: num, align: 'right' },
                  { key: 'cost_usd', label: 'Cost', fmt: usd, align: 'right' },
                ]}
              />
            </section>

            <section className="panel">
              <h2>Top spenders (users, 30d)</h2>
              <Table
                rows={data.economics?.byUser ?? []}
                columns={[
                  { key: 'email', label: 'User' },
                  { key: 'ai_cost_usd_30d', label: 'AI cost', fmt: usd, align: 'right' },
                  { key: 'allocated_profit_pennies_30d', label: 'Alloc. profit', fmt: gbp, align: 'right' },
                ]}
              />
            </section>
          </div>
        </>
      )}
    </main>
  );
}

const css = `
  .dash, .gate { background:#0f1115; color:#e7e9ee; min-height:100vh; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; padding:24px; box-sizing:border-box; }
  .gate { display:flex; align-items:center; justify-content:center; }
  .gate-box { background:#171a21; border:1px solid #262b36; border-radius:14px; padding:32px; width:340px; }
  .gate-box h1 { margin:0 0 6px; font-size:20px; }
  .gate-box p { color:#9aa3b2; font-size:13px; margin:0 0 16px; }
  .gate-box input { width:100%; padding:10px 12px; border-radius:8px; border:1px solid #2b313d; background:#0f1115; color:#e7e9ee; box-sizing:border-box; margin-bottom:12px; }
  button { background:#3b82f6; color:#fff; border:0; border-radius:8px; padding:8px 14px; font-weight:600; cursor:pointer; }
  button.ghost { background:#262b36; }
  button:disabled { opacity:.5; cursor:default; }
  .err { color:#fca5a5; font-size:13px; }
  .err.banner { background:#2a1417; border:1px solid #5b2030; padding:10px 14px; border-radius:10px; margin-bottom:16px; }
  header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:12px; }
  header h1 { font-size:20px; margin:0; }
  .actions { display:flex; gap:10px; align-items:center; }
  .ts { color:#6b7384; font-size:12px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:14px; margin-bottom:22px; }
  .card { background:#171a21; border:1px solid #262b36; border-radius:14px; padding:16px; }
  .card-label { color:#9aa3b2; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .card-value { font-size:26px; font-weight:700; margin-top:6px; }
  .card-sub { color:#6b7384; font-size:12px; margin-top:4px; }
  .panel { background:#171a21; border:1px solid #262b36; border-radius:14px; padding:18px; margin-bottom:18px; }
  .panel h2 { font-size:14px; margin:0 0 14px; color:#c7cdd9; }
  .grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:18px; }
  .funnel { display:flex; flex-direction:column; gap:14px; }
  .fstage { }
  .frow { display:flex; justify-content:space-between; font-size:13px; margin-bottom:5px; }
  .fname { font-weight:600; }
  .fcount { color:#c7cdd9; }
  .fbar-track { background:#0f1115; border-radius:6px; overflow:hidden; height:22px; }
  .fbar { background:linear-gradient(90deg,#3b82f6,#22d3ee); height:100%; border-radius:6px; transition:width .4s; min-width:2px; }
  .fmeta { color:#6b7384; font-size:11px; margin-top:4px; display:flex; gap:6px; }
  .fmeta .drop { color:#f59e0b; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:#7c8597; font-weight:500; padding:6px 10px; border-bottom:1px solid #262b36; font-size:11px; text-transform:uppercase; letter-spacing:.03em; }
  td { padding:7px 10px; border-bottom:1px solid #1d222b; }
  tr:last-child td { border-bottom:0; }
  .empty { color:#6b7384; font-size:13px; padding:8px 0; }
`;
