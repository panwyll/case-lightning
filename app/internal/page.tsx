'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

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

type Col = { key: string; label: string; fmt?: (v: unknown) => string; align?: 'right' };

/** Sortable, optionally filterable table. Sorting is what turns a dump into something
 *  you can investigate: click a header to find the biggest spender, the quietest firm,
 *  the oldest signup. Numbers sort numerically, everything else as text. */
function Table({ columns, rows, filter, empty, maxHeight }: { columns: Col[]; rows: any[]; filter?: boolean; empty?: string; maxHeight?: number }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);

  const view = useMemo(() => {
    let out = rows ?? [];
    const needle = q.trim().toLowerCase();
    if (needle) out = out.filter((r) => columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(needle)));
    if (sort) {
      const { key, dir } = sort;
      out = [...out].sort((a, b) => {
        const av = a[key], bv = b[key];
        const an = Number(av), bn = Number(bv);
        const numeric = av !== null && bv !== null && av !== '' && bv !== '' && !isNaN(an) && !isNaN(bn);
        if (numeric) return (an - bn) * dir;
        return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
      });
    }
    return out;
  }, [rows, columns, q, sort]);

  const toggle = (key: string) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: -1 }));

  if (!rows?.length) return <div className="empty">{empty ?? 'No data yet.'}</div>;
  return (
    <div className="table-wrap">
      {filter && (
        <input className="tfilter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" />
      )}
      <div className="tscroll" style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
      <table>
        <thead>
          <tr>{columns.map((c) => (
            <th
              key={c.key}
              onClick={() => toggle(c.key)}
              className="sortable"
              style={c.align === 'right' ? { textAlign: 'right' } : undefined}
            >
              {c.label}{sort?.key === c.key ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {view.map((r, i) => (
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
      {maxHeight && view.length > 0 && (
        <div className="tcount">{view.length} row{view.length === 1 ? '' : 's'}{q ? ' matching' : ''} &middot; scroll for more</div>
      )}
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

  // Everything worth a nudge, derived from data already fetched — no extra round trips.
  // Ordered worst-first so the top of the list is the thing to do next.
  const attention = useMemo(() => {
    const out: Array<{ level: 'bad' | 'warn' | 'info'; title: string; detail: string }> = [];
    const firms: any[] = data?.signups?.byTenant ?? [];
    const days = 86_400_000;
    const ago = (d: any) => (d ? (Date.now() - new Date(d).getTime()) / days : Infinity);

    const pastDue = firms.filter((f) => f.billing_status === 'past_due');
    if (pastDue.length) out.push({ level: 'bad', title: `${pastDue.length} firm(s) past due`,
      detail: `Payment failed: ${pastDue.map((f) => f.firm_name).join(', ')}. They keep access until Stripe gives up.` });

    const stalled = firms.filter((f) => Number(f.actions) === 0);
    if (stalled.length) out.push({ level: 'warn', title: `${stalled.length} firm(s) connected but never did anything`,
      detail: `Signed in, then nothing: ${stalled.map((f) => f.firm_name).join(', ')}. This is the activation gap — worth a personal email.` });

    const unnamed = firms.filter((f) => f.unnamed && Number(f.actions) > 0);
    if (unnamed.length) out.push({ level: 'warn', title: `${unnamed.length} firm(s) never finished onboarding`,
      detail: 'Still called Tenant-<id>, so step 1 (name your firm) was skipped. Letters and emails go out unbranded.' });

    const quiet = firms.filter((f) => Number(f.actions) > 0 && ago(f.last_seen_at) > 7 && ago(f.signed_up_at) > 7);
    if (quiet.length) out.push({ level: 'warn', title: `${quiet.length} firm(s) have gone quiet`,
      detail: `No activity in over a week: ${quiet.map((f) => f.firm_name).join(', ')}.` });

    const trialing = firms.filter((f) => f.billing_status === 'trialing');
    if (trialing.length) out.push({ level: 'info', title: `${trialing.length} firm(s) on trial`,
      detail: 'Stripe owns the clock — they convert or lapse without you doing anything.' });

    if (!(data?.funnel ?? []).length) out.push({ level: 'info', title: 'Funnel has no data',
      detail: 'v_funnel_global returned nothing — likely no pageview_event rows yet, so top-of-funnel is blind.' });

    return out;
  }, [data]);

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

          {(data.funnel ?? []).length > 0 && (
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
          )}

          {attention.length > 0 && (
            <section className="panel attention">
              <h2>Needs your attention</h2>
              <ul className="alerts">
                {attention.map((a, i) => (
                  <li key={i} className={`alert ${a.level}`}>
                    <span className="adot" />
                    <div>
                      <strong>{a.title}</strong>
                      <span className="awhy">{a.detail}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel">
            <h2>Signups per day &mdash; who has connected at all</h2>
            <p className="note">
              Counts every firm that signed in, paid or not. The funnel&rsquo;s acquisition
              figures only count paid conversions, so before the first sale they read as
              zero even when firms are turning up.
            </p>
            <Table
              maxHeight={260}
              rows={[...(data.signups?.daily ?? [])].reverse().slice(0, 30)}
              columns={[
                { key: 'day', label: 'Day', fmt: (v) => String(v ?? '').slice(0, 10) },
                { key: 'new_tenants', label: 'New firms', fmt: num, align: 'right' },
                { key: 'new_users', label: 'New users', fmt: num, align: 'right' },
                { key: 'activated_tenants', label: 'Activated', fmt: num, align: 'right' },
              ]}
            />
          </section>

          <section className="panel">
            <h2>Every firm that has signed in</h2>
            <p className="note">
              &ldquo;Unnamed&rdquo; means the firm never completed step 1 of onboarding &mdash; it&rsquo;s
              still called Tenant-&lt;id&gt;. Actions is audit rows: zero means they connected
              and did nothing.
            </p>
            <Table
              filter
              maxHeight={340}
              empty="Nobody has signed in yet."
              rows={data.signups?.byTenant ?? []}
              columns={[
                { key: 'firm_name', label: 'Firm' },
                { key: 'signed_up_at', label: 'Signed up', fmt: (v) => String(v ?? '').slice(0, 10) },
                { key: 'users', label: 'Users', fmt: num, align: 'right' },
                { key: 'matters', label: 'Matters', fmt: num, align: 'right' },
                { key: 'actions', label: 'Actions', fmt: num, align: 'right' },
                { key: 'last_seen_at', label: 'Last seen', fmt: (v) => String(v ?? '').slice(0, 10) },
                { key: 'billing_status', label: 'Billing', fmt: (v) => String(v ?? 'none') },
                { key: 'plan', label: 'Plan', fmt: (v) => String(v ?? '—') },
              ]}
            />
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
  .note { font-size:12px; line-height:1.5; color:#7e8798; margin:-8px 0 14px; max-width:70ch; }
  .attention { border-color:#3a3320; background:#191712; }
  .alerts { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:10px; }
  .alert { display:flex; gap:10px; align-items:flex-start; font-size:13px; line-height:1.5; }
  .alert strong { display:block; color:#e8ecf4; font-weight:600; }
  .awhy { color:#8b94a5; }
  .adot { width:8px; height:8px; border-radius:99px; margin-top:6px; flex:none; background:#64748b; }
  .alert.bad .adot { background:#f87171; }
  .alert.warn .adot { background:#fbbf24; }
  .alert.info .adot { background:#60a5fa; }
  th.sortable { cursor:pointer; user-select:none; }
  th.sortable:hover { color:#e8ecf4; }
  .tfilter { width:100%; max-width:280px; margin:0 0 10px; padding:7px 10px; border-radius:8px;
             border:1px solid #2a3040; background:#12151c; color:#e8ecf4; font-size:13px; font-family:inherit; }
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
  .tscroll { overflow-x:auto; }
  /* Sticky header so the column you're reading stays labelled while you scroll. */
  .tscroll thead th { position:sticky; top:0; z-index:1; background:#141821; }
  .tcount { font-size:11px; color:#6b7488; padding:8px 10px 0; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; color:#7c8597; font-weight:500; padding:6px 10px; border-bottom:1px solid #262b36; font-size:11px; text-transform:uppercase; letter-spacing:.03em; }
  td { padding:7px 10px; border-bottom:1px solid #1d222b; }
  tr:last-child td { border-bottom:0; }
  .empty { color:#6b7384; font-size:13px; padding:8px 0; }
`;
