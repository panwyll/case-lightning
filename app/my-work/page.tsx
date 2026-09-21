'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../shared/engine/api';
import { ENGINE_CSS } from '../shared/engine/ui';
import { House } from '../shared/engine/CaseloadMap';
import { pretty, type WorkItem } from '../shared/engine/types';

/**
 * My work (docs/caseload-ux.md §4–5): DO · WAITING · CHASE · ESCALATE.
 *
 * Nothing here is a list someone grooms — it is derived from the cases themselves, so it
 * cannot drift. An item leaves DO when the thing is done, appears in WAITING with the
 * clock running, and moves itself to CHASE when that clock expires.
 */
const WORK_CSS = `
.wk-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:14px;align-items:start}
.wk-col{background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden}
.wk-head{padding:10px 14px;border-bottom:1px solid #f1f5f9;display:flex;align-items:baseline;gap:8px}
.wk-head b{font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
.wk-head .n{margin-left:auto;font-size:12px;color:#94a3b8;font-variant-numeric:tabular-nums}
.wk-head .sub{font-size:11.5px;color:#94a3b8;letter-spacing:0;text-transform:none;font-weight:400}
.wk-item{display:block;padding:11px 14px;border-top:1px solid #f1f5f9;text-decoration:none;color:inherit}
.wk-item:first-of-type{border-top:0}
.wk-item:hover{background:#fafafa}
.wk-what{font-size:13px;font-weight:600;line-height:1.35}
.wk-where{font-size:11.5px;color:#94a3b8;margin-top:3px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.wk-clock{font-size:11.5px;margin-top:5px;display:flex;gap:10px;flex-wrap:wrap;color:#64748b;font-variant-numeric:tabular-nums}
.wk-clock .due{color:#b45309;font-weight:700}
.wk-clock .over{color:#b91c1c;font-weight:700}
.wk-bar{height:3px;border-radius:2px;background:#f1f5f9;margin-top:6px;overflow:hidden}
.wk-bar i{display:block;height:100%;background:#f59e0b}
.wk-none{padding:16px 14px;font-size:12.5px;color:#94a3b8}
`;

const OWNER: Record<string, string> = {
  conveyancer: 'Us', client: 'The client', seller_side: "The other side", lender: 'The lender',
  third_party: 'A third party', mlro: 'The MLRO', hmlr: 'HM Land Registry', search_provider: 'Search provider', id_provider: 'ID provider',
};

function Item({ i }: { i: WorkItem }) {
  const due = i.chaseInWorkingDays;
  // The bar measures how close this is to being escalated to a person — not how long it
  // has been open, which would sit at 100% for anything already chased once.
  const toEscalation = i.escalatesInWorkingDays;
  const pct = i.escalated ? 100 : toEscalation != null && i.sinceWorkingDays != null ? Math.min(100, Math.round((i.sinceWorkingDays / Math.max(1, i.sinceWorkingDays + Math.max(0, toEscalation))) * 100)) : null;
  return (
    <a className="wk-item" href={`/engine/${i.matterId}`}>
      <div className="wk-what">{i.what}</div>
      <div className="wk-where">
        <House band={i.urgency} size={16} />
        <span>{i.propertyAddress ?? i.matterRef ?? 'Matter'}</span>
        {i.unblocks && <span>· unblocks {i.unblocks.toLowerCase()}</span>}
      </div>
      {i.bucket !== 'do' && (
        <>
          <div className="wk-clock">
            <span>Waiting on {(OWNER[i.actionOwner] ?? pretty(i.actionOwner)).replace(/^The /, 'the ')}</span>
            {i.sinceWorkingDays != null && <span>{i.sinceWorkingDays}d elapsed</span>}
            {i.slaWorkingDays != null && <span>SLA {i.slaWorkingDays}d</span>}
            {due != null && (due <= 0 ? <span className="over">chase due now</span> : <span className="due">chase in {due}d</span>)}
            {i.chasesSent > 0 && <span>{i.chasesSent} chased</span>}
            {i.escalated && <span className="over">escalated</span>}
            {!i.escalated && i.escalatesInWorkingDays != null && i.escalatesInWorkingDays <= 3 && <span className="due">escalates in {Math.max(0, i.escalatesInWorkingDays)}d</span>}
          </div>
          {pct != null && <div className="wk-bar" title={i.escalated ? 'escalated' : `${pct}% of the way to escalation`}><i style={{ width: `${pct}%`, background: pct >= 100 ? '#dc2626' : pct > 70 ? '#f59e0b' : '#cbd5e1' }} /></div>}
        </>
      )}
      {i.bucket === 'chase' && (
        <div className="wk-clock">
          <span>{i.mode === 'automatic' ? 'The engine sends this chase on the next sweep' : 'Shadow mode — nothing is sent; approve it to chase'}</span>
        </div>
      )}
      {i.bucket === 'escalate' && (
        <div className="wk-clock">
          <span className="over">{i.chasesSent ? `${i.chasesSent} written chase${i.chasesSent === 1 ? ' has' : 's have'} not worked — call them` : i.escalatesInWorkingDays != null && i.escalatesInWorkingDays <= 0 ? 'The date has passed' : 'A date we owe is close'}</span>
        </div>
      )}
    </a>
  );
}

function Column({ title, sub, items }: { title: string; sub: string; items: WorkItem[] }) {
  return (
    <div className="wk-col">
      <div className="wk-head"><b>{title}</b><span className="sub">{sub}</span><span className="n">{items.length}</span></div>
      {items.length === 0 ? <div className="wk-none">Nothing here.</div> : items.map((i) => <Item key={i.id} i={i} />)}
    </div>
  );
}

export default function MyWorkPage() {
  const [data, setData] = useState<{ do: WorkItem[]; waiting: WorkItem[]; chase: WorkItem[]; escalate: WorkItem[]; matters: number } | null>(null);
  const [all, setAll] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api(`/engine/my-work?all=${all ? 1 : 0}`));
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load your work.');
    }
  }, [all]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="eg" style={{ maxWidth: 1180, margin: '0 auto', padding: '16px 16px 60px' }}>
      <style>{ENGINE_CSS + WORK_CSS}</style>
      <div className="eg-top">
        <div>
          <h1 className="eg-h1">My work</h1>
          <p className="eg-sub">
            {data ? `${data.do.length} to do · ${data.waiting.length} waiting · ${data.chase.length} to chase · ${data.escalate.length} to escalate across ${data.matters} matter${data.matters === 1 ? '' : 's'}` : 'Loading…'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className={`eg-btn${all ? ' on' : ''}`} onClick={() => setAll(!all)}>{all ? 'Whole team' : 'Mine only'}</button>
          <a className="eg-btn" href="/today">Today</a>
          <a className="eg-btn" href="/cases">Caseload</a>
        </div>
      </div>
      {err && <div className="eg-err">{err}</div>}
      {data && (
        <div className="wk-cols">
          <Column title="Do" sub="yours now" items={data.do} />
          <Column title="Waiting" sub="someone else, still ours" items={data.waiting} />
          <Column title="Chase" sub="the clock ran out" items={data.chase} />
          <Column title="Escalate" sub="writing again won't fix it" items={data.escalate} />
        </div>
      )}
    </div>
  );
}
