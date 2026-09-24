'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { House } from '@/app/shared/engine/CaseloadMap';
import { pretty, type WorkItem } from '@/app/shared/engine/types';
import { paths } from '@/lib/paths';
import { CheckCircle } from '@/app/shared/icons';

/**
 * The engine's side of the task list: what we are waiting for, what is due a chase, and
 * what writing again will not fix. Derived from the cases, never groomed by hand.
 */
const CSS = `
.wk-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:14px;align-items:start}
.wk-col{background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden}
.wk-head{padding:10px 14px;border-bottom:1px solid #f1f5f9;display:flex;align-items:baseline;gap:8px}
.wk-head b{font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
.wk-head .n{margin-left:auto;font-size:12px;color:#94a3b8;font-variant-numeric:tabular-nums}
.wk-item{display:block;padding:11px 14px;border-top:1px solid #f1f5f9;text-decoration:none;color:inherit}
.wk-item:first-of-type{border-top:0}
.wk-item:hover{background:#fafafa}
.wk-what{font-size:13px;font-weight:600;line-height:1.35}
.wk-where{font-size:11.5px;color:#94a3b8;margin-top:3px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.wk-clock{font-size:11.5px;margin-top:5px;display:flex;gap:10px;flex-wrap:wrap;color:#64748b;font-variant-numeric:tabular-nums}
.wk-clock .due{color:#b45309;font-weight:700}
.wk-clock .over{color:#b91c1c;font-weight:700}
.wk-none{padding:16px 14px;font-size:12.5px;color:#94a3b8}
`;

const OWNER: Record<string, string> = {
  conveyancer: 'us', client: 'the client', seller_side: 'the other side', lender: 'the lender',
  third_party: 'a third party', mlro: 'the MLRO', hmlr: 'HM Land Registry', search_provider: 'the search provider', id_provider: 'the ID provider',
};

/**
 * A decision mirrored into the task list carries its link and an engine tag in its text.
 * Take those out and hand back the id, so the row reads as a sentence with one button.
 */
export function decisionTask(text: string | null | undefined): { text: string; id: string } | null {
  if (!text) return null;
  const m = text.match(/\[engine:([0-9a-f-]{36})\]/i);
  if (!m) return null;
  const clean = text
    .replace(/\s*→\s*https?:\/\/\S+/g, '')
    .replace(/\s*\[engine:[^\]]*\]/g, '')
    .replace(/\s*\([a-z_]+\)\s*$/i, '')
    .replace(/^Decision needed\s*[—-]\s*/i, '')
    .trim();
  return { text: clean.charAt(0).toUpperCase() + clean.slice(1), id: m[1] };
}

function Item({ i }: { i: WorkItem }) {
  const due = i.chaseInWorkingDays;
  const href = i.ref?.type === 'decision' ? paths.decision(i.ref.id) : paths.matter(i.matterId);
  return (
    <a className="wk-item" href={href}>
      <div className="wk-what">{i.what}</div>
      <div className="wk-where">
        <House band={i.urgency} size={16} />
        <span>{i.propertyAddress ?? i.matterRef ?? 'Matter'}</span>
        {i.unblocks && <span>· unblocks {i.unblocks.toLowerCase()}</span>}
      </div>
      {i.bucket !== 'do' && (
        <div className="wk-clock">
          <span>Waiting on {OWNER[i.actionOwner] ?? pretty(i.actionOwner)}</span>
          {i.sinceWorkingDays != null && <span>{i.sinceWorkingDays}d</span>}
          {i.slaWorkingDays != null && <span>SLA {i.slaWorkingDays}d</span>}
          {due != null && (due <= 0 ? <span className="over">chase due</span> : <span className="due">chase in {due}d</span>)}
          {i.chasesSent > 0 && <span>{i.chasesSent} chased</span>}
          {i.escalated && <span className="over">escalated</span>}
        </div>
      )}
    </a>
  );
}

function Column({ title, items }: { title: string; items: WorkItem[] }) {
  return (
    <div className="wk-col">
      <div className="wk-head"><b>{title}</b><span className="n">{items.length}</span></div>
      {items.length === 0 ? <div className="wk-none">None.</div> : items.map((i) => <Item key={i.id} i={i} />)}
    </div>
  );
}

export default function EngineWork({ all, showEmpty = false }: { all: boolean; showEmpty?: boolean }) {
  const [data, setData] = useState<{ do: WorkItem[]; waiting: WorkItem[]; chase: WorkItem[]; escalate: WorkItem[] } | null>(null);
  const load = useCallback(async () => {
    try { setData(await api(`/engine/my-work?all=${all ? 1 : 0}`)); } catch { setData(null); }
  }, [all]);
  useEffect(() => { void load(); }, [load]);
  if (!data) return null;
  const doItems = data.do;
  if (!doItems.length && !data.waiting.length && !data.chase.length && !data.escalate.length) {
    return showEmpty ? (
      <div style={{ background: '#fff', border: '1px solid #e6e8ee', borderRadius: 12, padding: 40, textAlign: 'center' }}>
        <div style={{ color: '#16a34a', marginBottom: 8 }}><CheckCircle size={30} /></div>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Nothing to do</div>
      </div>
    ) : null;
  }
  return (
    <div className="wk-cols" style={{ marginTop: 0, marginBottom: 14 }}>
      <style>{CSS}</style>
      <Column title="Do" items={doItems} />
      <Column title="Waiting" items={data.waiting} />
      <Column title="Chase" items={data.chase} />
      {data.escalate.length > 0 && <Column title="Escalate" items={data.escalate} />}
    </div>
  );
}
