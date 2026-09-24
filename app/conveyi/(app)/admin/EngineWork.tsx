'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { House } from '@/app/shared/engine/CaseloadMap';
import { pretty, type WorkItem } from '@/app/shared/engine/types';
import { paths } from '@/lib/paths';
import { CheckCircle, ChevronRight } from '@/app/shared/icons';

/**
 * The engine's side of the task list. DO is what is ours to do next; ESCALATE is what
 * writing again will not fix. WAITING is folded away: every line says who we are waiting
 * on, to do what, by when — and chases itself when that date passes, with the count and
 * a notch more severity on the line. Nothing here is groomed by hand.
 */
const CSS = `
.wk-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:14px;align-items:start;margin-bottom:14px}
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
.wk-clock .over{color:#b91c1c;font-weight:700}
.wk-none{padding:16px 14px;font-size:12.5px;color:#94a3b8}
.wk-wait{background:#fff;border:1px solid #e6e8ee;border-radius:12px;margin-bottom:14px;overflow:hidden}
.wk-wait-hd{display:flex;align-items:center;gap:10px;width:100%;padding:11px 14px;border:0;background:none;font-family:inherit;cursor:pointer;text-align:left;color:#0f172a}
.wk-wait-hd b{font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
.wk-wait-hd .n{font-size:12px;color:#94a3b8;font-variant-numeric:tabular-nums}
.wk-wait-hd .sum{margin-left:auto;font-size:12px;color:#64748b;display:flex;gap:10px}
.wk-wait-hd .chev{color:#94a3b8;display:inline-flex;transition:transform .12s}
.wk-wait-hd .chev.open{transform:rotate(90deg)}
.wk-row{display:grid;grid-template-columns:20px 1fr auto;gap:10px;align-items:center;padding:9px 14px;border-top:1px solid #f1f5f9;text-decoration:none;color:inherit;font-size:13px}
.wk-row:hover{background:#fafafa}
.wk-row .line b{font-weight:700}
.wk-row .meta{font-size:11.5px;color:#94a3b8;margin-top:2px}
.wk-row .right{font-size:11.5px;color:#64748b;white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}
.wk-row .right .over{color:#b91c1c;font-weight:700}
`;

const OWNER: Record<string, string> = {
  conveyancer: 'us', client: 'the client', seller_side: "the other side's solicitor", lender: 'the lender',
  third_party: 'a third party', mlro: 'the MLRO', hmlr: 'HM Land Registry', search_provider: 'the search provider', id_provider: 'the ID provider',
};
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');

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
  const href = i.ref?.type === 'decision' ? paths.decision(i.ref.id) : paths.matter(i.matterId);
  return (
    <a className="wk-item" href={href}>
      <div className="wk-what">{i.what}</div>
      <div className="wk-where">
        <House band={i.urgency} size={16} />
        <span>{i.propertyAddress ?? i.matterRef ?? 'Matter'}</span>
        {i.unblocks && <span>· unblocks {i.unblocks.toLowerCase()}</span>}
      </div>
      {i.bucket === 'escalate' && i.chasesSent > 0 && <div className="wk-clock"><span className="over">{i.chasesSent} chase{i.chasesSent === 1 ? '' : 's'} unanswered</span></div>}
    </a>
  );
}

function Column({ title, items }: { title: string; items: WorkItem[] }) {
  return (
    <div className="wk-col">
      <div className="wk-head"><b>{title}</b><span className="n">{items.length}</span></div>
      {items.length === 0 ? <div className="wk-none">None.</div> : items.map((i) => <Item key={`${i.matterId}:${i.id}`} i={i} />)}
    </div>
  );
}

/** Waiting on X to do Y by Z. Collapsed until asked for; it chases itself. */
function Waiting({ items }: { items: WorkItem[] }) {
  const [open, setOpen] = useState(false);
  const due = items.filter((i) => i.chaseDue).length;
  const chased = items.filter((i) => i.chasesSent > 0).length;
  return (
    <div className="wk-wait">
      <button className="wk-wait-hd" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`chev${open ? ' open' : ''}`}><ChevronRight size={14} /></span>
        <b>Waiting on</b><span className="n">{items.length}</span>
        <span className="sum">{chased > 0 && <span>{chased} chased</span>}{due > 0 && <span style={{ color: '#b45309', fontWeight: 700 }}>{due} due a chase</span>}</span>
      </button>
      {open && items.map((i) => {
        const who = OWNER[i.actionOwner] ?? pretty(i.actionOwner);
        return (
          <a key={`${i.matterId}:${i.id}`} className="wk-row" href={paths.matter(i.matterId)}>
            <House band={i.urgency} size={18} />
            <span>
              <span className="line">Waiting on <b>{who}</b> to {i.what}{i.dueBy ? <> by <b>{day(i.dueBy)}</b></> : null}</span>
              <div className="meta">{i.propertyAddress ?? i.matterRef ?? 'Matter'}{i.chasesSent > 0 ? ` · chased ${i.chasesSent}×` : ''}</div>
            </span>
            <span className="right">
              {i.chaseDue ? <span className="over">chase goes out on the next sweep</span>
                : i.chaseInWorkingDays != null ? <span>chase in {i.chaseInWorkingDays} working day{i.chaseInWorkingDays === 1 ? '' : 's'}</span>
                : i.sinceWorkingDays != null ? <span>{i.sinceWorkingDays}d</span> : null}
            </span>
          </a>
        );
      })}
    </div>
  );
}

export default function EngineWork({ all, showEmpty = false }: { all: boolean; showEmpty?: boolean }) {
  const [data, setData] = useState<{ do: WorkItem[]; waiting: WorkItem[]; escalate: WorkItem[] } | null>(null);
  const load = useCallback(async () => {
    try { setData(await api(`/engine/my-work?all=${all ? 1 : 0}`)); } catch { setData(null); }
  }, [all]);
  useEffect(() => { void load(); }, [load]);
  if (!data) return null;
  // Decisions are the tray above; what is left of DO is issues and next steps.
  const doItems = data.do.filter((i) => i.ref?.type !== 'decision');
  if (!doItems.length && !data.waiting.length && !data.escalate.length) {
    return showEmpty ? (
      <div style={{ background: '#fff', border: '1px solid #e6e8ee', borderRadius: 12, padding: 40, textAlign: 'center' }}>
        <div style={{ color: '#16a34a', marginBottom: 8 }}><CheckCircle size={30} /></div>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Nothing to do</div>
      </div>
    ) : null;
  }
  return (
    <div>
      <style>{CSS}</style>
      {(doItems.length > 0 || data.escalate.length > 0) && (
        <div className="wk-cols">
          {doItems.length > 0 && <Column title="Do" items={doItems} />}
          {data.escalate.length > 0 && <Column title="Escalate" items={data.escalate} />}
        </div>
      )}
      {data.waiting.length > 0 && <Waiting items={data.waiting} />}
    </div>
  );
}
