'use client';
/**
 * The owner's console pages: Overview, Firms (and one firm in depth), Billing, Usage and Errors.
 * Each reads /api/v1/internal/console with the dashboard key.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Table } from './Acquisition';

type Any = Record<string, any>;
const gbp = (p: unknown) => '£' + (Number(p ?? 0) / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 });
const usd = (n: unknown) => '$' + Number(n ?? 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n: unknown) => Number(n ?? 0).toLocaleString('en-GB');
const day = (iso: unknown) => (iso ? new Date(String(iso)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const when = (iso: unknown) => {
  if (!iso) return '—';
  const ms = Date.now() - new Date(String(iso)).getTime();
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export const STANDING: Record<string, [string, string]> = {
  paying: ['Paying', '#4ade80'], trial: ['Trial', '#93c5fd'], comped: ['Comped', '#a78bfa'], grace: ['Payment failed', '#fbbf24'], suspended: ['Suspended', '#f87171'], pilot: ['Pilot', '#94a3b8'],
};
const Standing = ({ s }: { s: string }) => { const [l, c] = STANDING[s] ?? [s, '#94a3b8']; return <span className="chip" style={{ color: c, borderColor: `${c}55` }}>{l}</span>; };
/** A firm by its name, or (before it has named itself) by the person who signed it up. */
const label = (f: { name?: string | null; contact?: string | null }) => (!f.name || /^Tenant-/.test(f.name) ? f.contact ?? 'Unnamed firm' : f.name);
const SOURCE: Record<string, string> = { api: 'Server', engine: 'Engine', webhook: 'Webhook', cron: 'Cron', ai: 'AI', send: 'Send', billing: 'Billing' };

export function useConsole<T = Any>(k: string, page: string, params: Record<string, string | number | null | undefined>, onBadKey: () => void) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const qs = new URLSearchParams(Object.entries({ page, ...params }).filter(([, v]) => v != null && v !== '').map(([a, v]) => [a, String(v)])).toString();
  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const r = await fetch(`/api/v1/internal/console?${qs}`, { headers: { authorization: `Bearer ${k}` } });
      if (r.status === 401) { onBadKey(); return; }
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }, [k, qs, onBadKey]);
  useEffect(() => { void load(); }, [load]);
  return { data, err, loading, reload: load };
}

type Nav = (page: string, params?: Record<string, string>) => void;

// ───────────────────────── Overview ─────────────────────────

export function Overview({ k, onBadKey, go }: { k: string; onBadKey: () => void; go: Nav }) {
  const { data: d, err } = useConsole(k, 'overview', {}, onBadKey);
  if (err) return <div className="err banner">{err}</div>;
  if (!d) return <div className="ts">Loading…</div>;
  const f = d.firms;
  const failRate = d.ai?.calls_24h ? Math.round((100 * d.ai.failed_24h) / d.ai.calls_24h) : 0;
  return (
    <div>
      <header><h1>Overview</h1></header>
      <section className="cards">
        <button className="card link" onClick={() => go('firms')}><div className="card-label">Firms</div><div className="card-value">{f.total}</div><div className="card-sub">{f.new30d} new in 30 days</div></button>
        <button className="card link" onClick={() => go('billing')}><div className="card-label">Paying</div><div className="card-value">{f.paying}</div><div className="card-sub">{f.trial} trial · {f.comped} comped</div></button>
        <button className={`card link${f.grace + f.suspended ? ' warn' : ''}`} onClick={() => go('billing')}><div className="card-label">Payment problems</div><div className="card-value">{f.grace + f.suspended}</div><div className="card-sub">{f.grace} in grace · {f.suspended} suspended</div></button>
        <button className="card link" onClick={() => go('billing')}><div className="card-label">Cases this month</div><div className="card-value">{num(d.cases?.month)}</div><div className="card-sub">{num(d.cases?.billed)} billed · {gbp(d.cases?.pennies)}</div></button>
        <button className="card link" onClick={() => go('usage')}><div className="card-label">AI cost, 30 days</div><div className="card-value">{usd(d.ai?.cost_30d)}</div><div className="card-sub">{num(d.ai?.calls_30d)} calls</div></button>
        <button className={`card link${failRate >= 10 ? ' warn' : ''}`} onClick={() => go('usage')}><div className="card-label">AI calls, 24 hours</div><div className="card-value">{num(d.ai?.calls_24h)}</div><div className="card-sub">{num(d.ai?.failed_24h)} failed ({failRate}%)</div></button>
        <button className={`card link${d.errors24h ? ' warn' : ''}`} onClick={() => go('errors', { days: '1' })}><div className="card-label">Errors, 24 hours</div><div className="card-value">{num(d.errors24h)}</div><div className="card-sub">all sources</div></button>
        <div className="card"><div className="card-label">Mail held</div><div className="card-value">{num(d.heldMail)}</div><div className="card-sub">for suspended firms</div></div>
      </section>
      <div className="two">
        <section className="panel">
          <h2>Latest errors <button className="more" onClick={() => go('errors')}>All Errors</button></h2>
          {d.recentErrors.length === 0 ? <p className="ts">None in the last 7 days.</p> : d.recentErrors.map((e: Any, i: number) => (
            <div key={i} className="row"><span className="src">{SOURCE[e.source] ?? e.source}</span><span className="grow" title={e.message}>{e.message}</span><span className="ts">{when(e.created_at)}</span></div>
          ))}
        </section>
        <section className="panel">
          <h2>Newest firms <button className="more" onClick={() => go('firms')}>All Firms</button></h2>
          {d.recentFirms.map((x: Any) => (
            <button key={x.id} className="row link" onClick={() => go('firms', { id: x.id })}><span className="grow">{label(x)}</span><Standing s={x.standing} /><span className="ts">{day(x.created_at)}</span></button>
          ))}
        </section>
      </div>
    </div>
  );
}

// ───────────────────────── Firms ─────────────────────────

export function Firms({ k, onBadKey, go, id }: { k: string; onBadKey: () => void; go: Nav; id: string | null }) {
  const { data, err, reload } = useConsole<{ firms: Any[] }>(k, 'firms', {}, onBadKey);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<string>('');
  if (id) return <FirmDetail k={k} onBadKey={onBadKey} id={id} go={go} onChanged={reload} />;
  if (err) return <div className="err banner">{err}</div>;
  if (!data) return <div className="ts">Loading…</div>;
  const shown = data.firms.filter((f) => (!only || f.standing === only) && (!q.trim() || `${f.name} ${f.contact ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())));
  const counts = data.firms.reduce<Record<string, number>>((m, f) => ((m[f.standing] = (m[f.standing] ?? 0) + 1), m), {});
  return (
    <div>
      <header><h1>Firms</h1></header>
      <div className="bar">
        <input className="q" placeholder="Search firms" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={`pill${only === '' ? ' on' : ''}`} onClick={() => setOnly('')}>All {data.firms.length}</button>
        {Object.entries(counts).map(([s, n]) => <button key={s} className={`pill${only === s ? ' on' : ''}`} onClick={() => setOnly(only === s ? '' : s)}>{STANDING[s]?.[0] ?? s} {n}</button>)}
      </div>
      <section className="panel flush">
        <table className="t">
          <thead><tr><th>Firm</th><th>Billing</th><th className="r">Users</th><th className="r">Cases</th><th className="r">Charged</th><th className="r">AI 30d</th><th className="r">Failures 7d</th><th>Last seen</th><th>Since</th></tr></thead>
          <tbody>
            {shown.map((f) => (
              <tr key={f.id} className="link" onClick={() => go('firms', { id: f.id })}>
                <td className="strong">{label(f)}</td>
                <td><Standing s={f.standing} />{f.standing === 'comped' && f.comp_until ? <span className="ts"> to {day(f.comp_until)}</span> : f.standing === 'trial' && f.trialEndsAt ? <span className="ts"> to {day(f.trialEndsAt)}</span> : f.standing === 'grace' ? <span className="ts"> to {day(f.graceEndsAt)}</span> : null}</td>
                <td className="r">{num(f.users)}</td><td className="r">{num(f.cases)}</td><td className="r">{num(f.charged)}</td>
                <td className="r">{usd(f.ai_cost_30d)}</td>
                <td className={`r${Number(f.errors_7d) ? ' bad' : ''}`}>{num(f.errors_7d)}</td>
                <td>{when(f.last_seen)}</td><td>{day(f.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function FirmDetail({ k, onBadKey, id, go, onChanged }: { k: string; onBadKey: () => void; id: string; go: Nav; onChanged: () => void }) {
  const { data: d, err, reload } = useConsole(k, 'firm', { id }, onBadKey);
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const comp = async (on: boolean) => {
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/v1/internal/firms', { method: 'PATCH', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: id, comp: on, until: on ? until || null : null }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await reload(); onChanged();
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };
  if (err) return <div className="err banner">{err}</div>;
  if (!d) return <div className="ts">Loading…</div>;
  const b = d.billing ?? {};
  const comped = !!d.comp?.comp_plan && (!d.comp.comp_until || new Date(d.comp.comp_until) > new Date());
  const standing = comped ? 'comped' : b.grace ? 'grace' : b.pilot ? 'pilot' : b.trialing ? 'trial' : b.entitled ? 'paying' : 'suspended';
  const name = label(d.info ?? {});
  return (
    <div>
      <header><h1><button className="back" onClick={() => go('firms')} aria-label="Back to Firms">←</button>{name} <Standing s={standing} /></h1></header>
      <section className="cards">
        <Card label="Since" value={day(d.info?.created_at)} />
        <Card label="Users" value={num(d.users.length)} />
        <Card label="Cases charged" value={num(d.charges.length)} sub={`${d.charges.filter((c: Any) => c.billed).length} billed`} />
        <Card label="AI calls, 30 days" value={num(d.usage.reduce((t: number, u: Any) => t + u.calls, 0))} sub={usd(d.usage.reduce((t: number, u: Any) => t + Number(u.cost), 0))} />
        <Card label="Failures, 30 days" value={num(d.errors.length)} />
      </section>
      <section className="panel">
        <h2>Billing</h2>
        <div className="kv">
          <span>Status</span><span>{b.status ?? '—'}{b.trialEndsAt ? ` · trial ends ${day(b.trialEndsAt)}` : ''}{b.graceEndsAt ? ` · grace ends ${day(b.graceEndsAt)}` : ''}</span>
          <span>Comp</span>
          <span className="inline">
            {comped ? <>{d.comp.comp_until ? `until ${day(d.comp.comp_until)}` : 'no end date'} <button className="ghost" disabled={busy} onClick={() => void comp(false)}>End Comp</button></>
              : <><input type="date" className="date" value={until} onChange={(e) => setUntil(e.target.value)} title="Until (blank: no end)" /><button disabled={busy} onClick={() => void comp(true)}>Comp</button></>}
            {msg && <span className="err">{msg}</span>}
          </span>
        </div>
      </section>
      <div className="two">
        <section className="panel"><h2>Users</h2><Table rows={d.users} empty="Nobody yet." columns={[{ key: 'display_name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'role', label: 'Role' }, { key: 'last_seen', label: 'Last seen', fmt: when }]} /></section>
        <section className="panel"><h2>AI usage, 30 days</h2><Table rows={d.usage} empty="None." columns={[{ key: 'event_type', label: 'Feature' }, { key: 'calls', label: 'Calls', fmt: num, align: 'right' }, { key: 'failed', label: 'Failed', fmt: num, align: 'right' }, { key: 'cost', label: 'Cost', fmt: usd, align: 'right' }]} /></section>
      </div>
      <section className="panel"><h2>Failures, 30 days <button className="more" onClick={() => go('errors', { firm: id })}>Open In Errors</button></h2><Table rows={d.errors} maxHeight={320} empty="None." columns={[{ key: 'created_at', label: 'When', fmt: when }, { key: 'source', label: 'Source', fmt: (v) => SOURCE[String(v)] ?? String(v) }, { key: 'route', label: 'Where' }, { key: 'message', label: 'What' }]} /></section>
      <div className="two">
        <section className="panel"><h2>Cases charged</h2><Table rows={d.charges} maxHeight={320} empty="None yet." columns={[{ key: 'charged_at', label: 'When', fmt: day }, { key: 'matter_ref', label: 'Case' }, { key: 'trigger_feature', label: 'Opened by' }, { key: 'billed', label: 'Billed', fmt: (v) => (v ? 'Yes' : 'No') }, { key: 'unbilled_reason', label: 'Why not', fmt: (v) => String(v ?? '') }]} /></section>
        <section className="panel"><h2>Subscription history</h2><Table rows={d.events} maxHeight={320} empty="Never subscribed." columns={[{ key: 'occurred_at', label: 'When', fmt: day }, { key: 'event_type', label: 'Event' }, { key: 'to_status', label: 'Status', fmt: (v) => String(v ?? '') }]} /></section>
      </div>
    </div>
  );
}

// ───────────────────────── Billing ─────────────────────────

export function Billing({ k, onBadKey, go }: { k: string; onBadKey: () => void; go: Nav }) {
  const { data: d, err } = useConsole(k, 'billing', {}, onBadKey);
  if (err) return <div className="err banner">{err}</div>;
  if (!d) return <div className="ts">Loading…</div>;
  const problems = d.firms.filter((f: Any) => f.standing === 'grace' || f.standing === 'suspended');
  const comps = d.firms.filter((f: Any) => f.standing === 'comped');
  const trials = d.firms.filter((f: Any) => f.standing === 'trial');
  const month = d.monthly[0];
  return (
    <div>
      <header><h1>Billing</h1></header>
      <section className="cards">
        <Card label="Paying" value={num(d.firms.filter((f: Any) => f.standing === 'paying').length)} />
        <Card label="On trial" value={num(trials.length)} />
        <Card label="Comped" value={num(comps.length)} />
        <Card label="Payment problems" value={num(problems.length)} />
        <Card label="Billed this month" value={gbp(month?.pennies)} sub={`${num(month?.billed)} of ${num(month?.cases)} cases`} />
        <Card label="Stripe report failures" value={num(d.failures.length)} />
      </section>
      <section className="panel">
        <h2>Payment problems</h2>
        {problems.length === 0 ? <p className="ts">None.</p> : problems.map((f: Any) => (
          <button key={f.id} className="row link" onClick={() => go('firms', { id: f.id })}><span className="grow">{label(f)}</span><Standing s={f.standing} /><span className="ts">{f.graceEndsAt ? `grace ends ${day(f.graceEndsAt)}` : 'service paused'}</span></button>
        ))}
      </section>
      <div className="two">
        <section className="panel">
          <h2>Comps</h2>
          {comps.length === 0 ? <p className="ts">None.</p> : comps.map((f: Any) => (
            <button key={f.id} className="row link" onClick={() => go('firms', { id: f.id })}><span className="grow">{label(f)}</span><span className="ts">{f.comp_until ? `until ${day(f.comp_until)}` : 'no end date'}</span></button>
          ))}
        </section>
        <section className="panel">
          <h2>Trials</h2>
          {trials.length === 0 ? <p className="ts">None.</p> : trials.map((f: Any) => (
            <button key={f.id} className="row link" onClick={() => go('firms', { id: f.id })}><span className="grow">{label(f)}</span><span className="ts">{f.trialEndsAt ? `ends ${day(f.trialEndsAt)}` : ''}</span></button>
          ))}
        </section>
      </div>
      <div className="two">
        <section className="panel"><h2>Cases by month</h2><Table rows={d.monthly} empty="No cases yet." columns={[{ key: 'month', label: 'Month' }, { key: 'cases', label: 'Cases', fmt: num, align: 'right' }, { key: 'billed', label: 'Billed', fmt: num, align: 'right' }, { key: 'pennies', label: 'Revenue', fmt: gbp, align: 'right' }]} /></section>
        <section className="panel"><h2>Cases by outcome</h2><Table rows={d.byReason} empty="No cases yet." columns={[{ key: 'reason', label: 'Outcome', fmt: (v) => ({ TRIAL: 'Free (trial)', COMP: 'Free (comped)', PILOT: 'Free (pilot)', NO_SUBSCRIPTION: 'Not billed (no subscription)', ERROR: 'Stripe report failed', SANDBOX: 'Sandbox' } as Record<string, string>)[String(v)] ?? String(v) }, { key: 'cases', label: 'Cases', fmt: num, align: 'right' }]} /></section>
      </div>
      <section className="panel"><h2>Subscription events</h2><Table filter rows={d.events} maxHeight={360} empty="None yet." columns={[{ key: 'occurred_at', label: 'When', fmt: day }, { key: 'firm', label: 'Firm', fmt: (v) => String(v ?? '—') }, { key: 'event_type', label: 'Event' }, { key: 'from_status', label: 'From', fmt: (v) => String(v ?? '') }, { key: 'to_status', label: 'To', fmt: (v) => String(v ?? '') }]} /></section>
      {d.failures.length > 0 && <section className="panel"><h2>Stripe report failures</h2><Table rows={d.failures} columns={[{ key: 'charged_at', label: 'When', fmt: day }, { key: 'firm', label: 'Firm' }, { key: 'stripe_error', label: 'Error' }]} /></section>}
    </div>
  );
}

// ───────────────────────── Usage ─────────────────────────

export function Usage({ k, onBadKey, go }: { k: string; onBadKey: () => void; go: Nav }) {
  const [days, setDays] = useState('30');
  const { data: d, err } = useConsole(k, 'usage', { days }, onBadKey);
  const max = useMemo(() => Math.max(1, ...((d?.daily ?? []) as Any[]).map((x) => x.calls)), [d]);
  if (err) return <div className="err banner">{err}</div>;
  return (
    <div>
      <header><h1>Usage</h1><Range value={days} onChange={setDays} /></header>
      {!d ? <div className="ts">Loading…</div> : (<>
        <section className="cards">
          <Card label="AI calls" value={num(d.daily.reduce((t: number, x: Any) => t + x.calls, 0))} />
          <Card label="Failed" value={num(d.daily.reduce((t: number, x: Any) => t + x.failed, 0))} />
          <Card label="Cost" value={usd(d.daily.reduce((t: number, x: Any) => t + Number(x.cost), 0))} />
        </section>
        <section className="panel">
          <h2>AI calls per day <span className="hint">· failed in red</span></h2>
          <div className="bars">
            {d.daily.map((x: Any) => (
              <div key={x.day} className="bar-col" title={`${x.day}: ${x.calls} calls, ${x.failed} failed, ${usd(x.cost)}`}>
                <div className="bar-fill" style={{ height: `${(100 * x.calls) / max}%` }}><div className="bar-bad" style={{ height: `${x.calls ? (100 * x.failed) / x.calls : 0}%` }} /></div>
              </div>
            ))}
          </div>
        </section>
        <div className="two">
          <section className="panel"><h2>By feature</h2><Table rows={d.byFeature} columns={[{ key: 'feature', label: 'Feature' }, { key: 'calls', label: 'Calls', fmt: num, align: 'right' }, { key: 'failed', label: 'Failed', fmt: num, align: 'right' }, { key: 'cost', label: 'Cost', fmt: usd, align: 'right' }, { key: 'avg_ms', label: 'Avg ms', fmt: num, align: 'right' }]} /></section>
          <section className="panel"><h2>By model</h2><Table rows={d.byModel} columns={[{ key: 'model', label: 'Model' }, { key: 'calls', label: 'Calls', fmt: num, align: 'right' }, { key: 'failed', label: 'Failed', fmt: num, align: 'right' }, { key: 'input_tokens', label: 'In tokens', fmt: num, align: 'right' }, { key: 'output_tokens', label: 'Out tokens', fmt: num, align: 'right' }, { key: 'cost', label: 'Cost', fmt: usd, align: 'right' }]} /></section>
        </div>
        <section className="panel">
          <h2>By firm</h2>
          {d.byFirm.map((x: Any) => (
            <button key={x.tenant_id ?? 'none'} className="row link" onClick={() => x.tenant_id && go('firms', { id: x.tenant_id })}><span className="grow">{x.firm ?? 'No firm'}</span><span className="ts">{num(x.calls)} calls · {num(x.failed)} failed</span><span className="strong">{usd(x.cost)}</span></button>
          ))}
        </section>
      </>)}
    </div>
  );
}

// ───────────────────────── Errors ─────────────────────────

export function Errors({ k, onBadKey, go, firm, initialDays }: { k: string; onBadKey: () => void; go: Nav; firm: string | null; initialDays?: string | null }) {
  const [days, setDays] = useState(initialDays ?? '7');
  const [source, setSource] = useState('');
  const [view, setView] = useState<'grouped' | 'all'>('grouped');
  const [open, setOpen] = useState<number | null>(null);
  const { data: d, err, loading, reload } = useConsole(k, 'errors', { days, source, firm }, onBadKey);
  if (err) return <div className="err banner">{err}</div>;
  const list: Any[] = d?.errors ?? [];
  const bySource = list.reduce<Record<string, number>>((m, e) => ((m[e.source] = (m[e.source] ?? 0) + 1), m), {});
  return (
    <div>
      <header><h1>Errors{firm && list[0]?.firm ? ` · ${list[0].firm}` : ''}</h1><span className="actions"><Range value={days} onChange={setDays} /><button onClick={() => void reload()} disabled={loading}>{loading ? '…' : 'Refresh'}</button></span></header>
      <div className="bar">
        <button className={`pill${source === '' ? ' on' : ''}`} onClick={() => setSource('')}>All</button>
        {Object.keys(SOURCE).map((s) => <button key={s} className={`pill${source === s ? ' on' : ''}`} onClick={() => setSource(source === s ? '' : s)}>{SOURCE[s]}{bySource[s] ? ` ${bySource[s]}` : ''}</button>)}
        <span className="spacer" />
        {firm && <button className="pill" onClick={() => go('errors')}>All Firms</button>}
        <button className={`pill${view === 'grouped' ? ' on' : ''}`} onClick={() => setView('grouped')}>Grouped</button>
        <button className={`pill${view === 'all' ? ' on' : ''}`} onClick={() => setView('all')}>Every One</button>
      </div>
      {!d ? <div className="ts">Loading…</div> : list.length === 0 ? <section className="panel"><p className="ts">No errors in this range.</p></section> : view === 'grouped' ? (
        <section className="panel flush">
          <table className="t">
            <thead><tr><th className="r">Count</th><th>Source</th><th>Where</th><th>What</th><th>Last</th></tr></thead>
            <tbody>{d.groups.map((g: Any, i: number) => (
              <tr key={i}><td className="r strong">{num(g.count)}</td><td><span className="src">{SOURCE[g.source] ?? g.source}</span></td><td className="mono">{g.route || '—'}</td><td className="wrap">{g.message}</td><td>{when(g.last)}</td></tr>
            ))}</tbody>
          </table>
        </section>
      ) : (
        <section className="panel flush">
          <table className="t">
            <thead><tr><th>When</th><th>Source</th><th>Firm</th><th>Where</th><th>What</th></tr></thead>
            <tbody>{list.map((e, i) => (<Fragment key={i}>
              <tr className={e.detail ? 'link' : undefined} onClick={() => e.detail && setOpen(open === i ? null : i)}>
                <td title={String(e.created_at)}>{when(e.created_at)}</td><td><span className="src">{SOURCE[e.source] ?? e.source}</span></td>
                <td>{e.tenant_id ? <button className="lnk" onClick={(ev) => { ev.stopPropagation(); go('firms', { id: e.tenant_id }); }}>{e.firm ?? 'Unnamed firm'}</button> : '—'}</td>
                <td className="mono">{e.route || '—'}{e.status ? ` · ${e.status}` : ''}</td><td className="wrap">{e.message}</td>
              </tr>
              {open === i && e.detail && <tr><td colSpan={5}><pre className="stack">{e.detail}</pre></td></tr>}
            </Fragment>))}</tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Range({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select className="range" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Time range">
      <option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 12 months</option>
    </select>
  );
}

export const CONSOLE_CSS = `
.shell { display:grid; grid-template-columns:200px minmax(0,1fr); min-height:100vh; background:#0f1115; color:#e7e9ee; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
.side { border-right:1px solid #1f242d; padding:20px 12px; display:flex; flex-direction:column; gap:2px; position:sticky; top:0; height:100vh; box-sizing:border-box; }
.side .brand { font-weight:800; font-size:14px; margin:0 8px 16px; color:#fff; }
.side button { text-align:left; background:none; border:0; color:#aab1bf; font:inherit; font-size:13.5px; padding:8px 10px; border-radius:8px; cursor:pointer; }
.side button:hover { background:#171a21; color:#fff; }
.side button.on { background:#241f3d; color:#c4b5fd; font-weight:700; }
.side .foot { margin-top:auto; }
.main { padding:24px 28px; min-width:0; }
.main .dash { padding:0; min-height:auto; }
header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:18px; }
header h1 { font-size:20px; margin:0; display:flex; align-items:center; gap:10px; }
.back { background:none; border:1px solid #2e3440; color:#c7cdd9; border-radius:8px; width:30px; height:30px; cursor:pointer; font-size:15px; }
button { font:inherit; font-size:12.5px; padding:6px 12px; border-radius:8px; border:1px solid #7c5cff; background:#7c5cff; color:#fff; cursor:pointer; }
button.ghost, .pill, .more { background:transparent; color:#c4b5fd; }
button:disabled { opacity:.5; cursor:default; }
.card.link { text-align:left; cursor:pointer; font:inherit; color:inherit; background:#171a21; border:1px solid #262b36; }
.card.link:hover { border-color:#3b3f5c; }
.card.warn { border-color:#7c2d12; }
.card.warn .card-value { color:#fbbf24; }
.two { display:grid; grid-template-columns:repeat(auto-fit,minmax(420px,1fr)); gap:18px; }
.panel.flush { padding:0; overflow:auto; }
.panel h2 { display:flex; align-items:center; gap:10px; }
.more { margin-left:auto; border:1px solid #3b3f5c; font-size:11.5px; padding:3px 9px; }
.row { display:flex; align-items:center; gap:10px; width:100%; padding:8px 4px; border:0; border-top:1px solid #1f242d; background:none; color:inherit; font:inherit; font-size:13px; text-align:left; border-radius:0; }
.row:first-of-type { border-top:0; }
.row.link { cursor:pointer; }
.row.link:hover { background:#1b1f28; }
.grow { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.strong { font-weight:700; color:#fff; }
.src { display:inline-block; font-size:11px; font-weight:700; color:#c7cdd9; background:#1f242d; border-radius:6px; padding:2px 7px; white-space:nowrap; }
.chip { display:inline-block; font-size:11.5px; font-weight:700; border:1px solid; border-radius:99px; padding:1px 8px; white-space:nowrap; }
.bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
.bar .spacer { flex:1; }
.q { background:#0f1115; border:1px solid #2e3440; color:#e7e9ee; border-radius:8px; padding:7px 10px; font:inherit; font-size:13px; width:260px; }
.pill { border:1px solid #2e3440; border-radius:99px; padding:4px 11px; font-size:12px; color:#aab1bf; }
.pill.on { background:#241f3d; border-color:#7c5cff; color:#c4b5fd; }
.t { width:100%; border-collapse:collapse; font-size:13px; }
.t th { text-align:left; color:#8b93a3; font-weight:600; padding:9px 12px; border-bottom:1px solid #262b36; position:sticky; top:0; background:#171a21; white-space:nowrap; }
.t td { padding:8px 12px; border-top:1px solid #1f242d; vertical-align:top; color:#c7cdd9; }
.t tr.link { cursor:pointer; }
.t tr.link:hover td { background:#1b1f28; }
.t .r { text-align:right; font-variant-numeric:tabular-nums; }
.t .bad { color:#f87171; font-weight:700; }
.t .wrap { white-space:normal; word-break:break-word; max-width:560px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
.lnk { background:none; border:0; padding:0; color:#c4b5fd; font-size:13px; cursor:pointer; }
.stack { margin:0; font-size:11.5px; color:#aab1bf; white-space:pre-wrap; background:#0f1115; border-radius:8px; padding:10px; }
.kv { display:grid; grid-template-columns:120px 1fr; gap:10px 16px; font-size:13px; align-items:center; }
.kv > span:nth-child(odd) { color:#8b93a3; }
.inline { display:inline-flex; align-items:center; gap:8px; flex-wrap:wrap; }
.date { background:#0f1115; border:1px solid #2e3440; color:#e7e9ee; border-radius:7px; padding:5px 8px; font:inherit; font-size:12.5px; color-scheme:dark; }
.bars { display:flex; align-items:flex-end; gap:3px; height:160px; }
.bar-col { flex:1; height:100%; display:flex; align-items:flex-end; }
.bar-fill { width:100%; background:#7c5cff; border-radius:3px 3px 0 0; display:flex; align-items:flex-end; min-height:1px; }
.bar-bad { width:100%; background:#ef4444; border-radius:3px 3px 0 0; }
@media (max-width:760px){ .shell { grid-template-columns:1fr; } .side { position:static; height:auto; flex-direction:row; flex-wrap:wrap; } .side .foot { margin:0; } .two { grid-template-columns:1fr; } .main { padding:16px; } }
`;
