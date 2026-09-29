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
export const WORK_CSS = `
.wk-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:12px;align-items:start;margin-bottom:12px}
.wk-col{background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden}
.wk-head{padding:10px 14px;border-bottom:1px solid #f1f5f9;display:flex;align-items:baseline;gap:8px}
.wk-head b{font-size:13px;font-weight:800;color:#0f172a;line-height:1.3}
.wk-head .n{margin-left:auto;font-size:12px;color:#94a3b8;font-variant-numeric:tabular-nums}
.wk-item{display:block;padding:9px 14px;border-top:1px solid #f1f5f9;text-decoration:none;color:inherit}
.wk-item:first-of-type{border-top:0}
.wk-item:hover{background:#fafafa}
.wk-what{font-size:13px;font-weight:600;line-height:1.35}
.wk-where{font-size:11.5px;color:#94a3b8;margin-top:3px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.wk-clock{font-size:11.5px;margin-top:5px;display:flex;gap:10px;flex-wrap:wrap;color:#64748b;font-variant-numeric:tabular-nums}
.wk-clock .over{color:#b91c1c;font-weight:700}
.wk-more{display:block;width:100%;border:0;border-top:1px solid #f1f5f9;background:#fafafa;padding:8px 14px;font-size:12.5px;font-weight:700;color:#5A27E0;cursor:pointer;font-family:inherit;text-align:left}
.wk-wait{background:#fff;border:1px solid #e6e8ee;border-radius:12px;margin-bottom:14px;overflow:hidden}
.wk-wait-hd{display:flex;align-items:center;gap:10px;width:100%;padding:11px 14px;border:0;background:none;font-family:inherit;cursor:pointer;text-align:left;color:#0f172a}
.wk-wait-hd > b{font-size:13px;font-weight:800;color:#0f172a;line-height:1.3}
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
.wk-send{font-size:11px;font-weight:700;color:#0f172a;background:#fff;border:1px solid #e2e8f0;border-radius:7px;padding:2px 8px;cursor:pointer}
.wk-send:hover{background:#f8fafc}
.wk-send:disabled{opacity:.6;cursor:default}
.wk-who{display:flex;gap:6px;flex-wrap:wrap}
.wk-who span{font-size:11.5px;font-weight:700;color:#334155;background:#f1f5f9;border-radius:999px;padding:2px 9px;white-space:nowrap;cursor:pointer}
.wk-who span:hover{background:#ede9fe;color:#5A27E0}
.wk-who span.on{background:#5A27E0;color:#fff}
.wk-case{border-top:1px solid #eef1f5}
.wk-case-h{display:flex;align-items:center;gap:8px;padding:9px 14px 4px;text-decoration:none;color:#0f172a;font-size:13px}
.wk-case-h b{font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wk-case-h span{font-size:12px;color:#64748b;white-space:nowrap}
.wk-case-h .n{margin-left:auto;color:#94a3b8}
.wk-case .wk-row{border-top:0;padding-left:34px}
.wk-clear{display:flex;align-items:center;gap:8px;padding:2px 14px 12px;font-size:13px;color:#166534}
.wk-clear .t{color:#94a3b8;font-size:12px;margin-left:auto;font-variant-numeric:tabular-nums}
.wk-left{font-weight:700;white-space:nowrap;font-variant-numeric:tabular-nums}
.wk-left.over{color:#b91c1c}.wk-left.soon{color:#b45309}.wk-left.ok{color:#0369a1}
`;

const OWNER: Record<string, string> = {
  conveyancer: 'us', client: 'the client', seller_side: "the other side's solicitor", lender: 'the lender',
  third_party: 'a third party', mlro: 'the MLRO', hmlr: 'HM Land Registry', search_provider: 'the search provider', id_provider: 'the ID provider',
};
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
const WHO_SHORT: Record<string, string> = {
  conveyancer: 'Us', client: 'Client', seller_side: 'Other side', lender: 'Lender', third_party: 'Third party',
  mlro: 'MLRO', hmlr: 'Land Registry', search_provider: 'Search provider', id_provider: 'ID provider',
};

/** Days until the date a reply is due: negative once it has passed. */
function daysLeft(i: WorkItem, now = Date.now()): number | null {
  if (!i.dueBy) return null;
  const due = new Date(`${i.dueBy}T23:59:59`).getTime();
  return Math.floor((due - now) / 86_400_000);
}
function Left({ i }: { i: WorkItem }) {
  const d = daysLeft(i);
  if (d == null) return null;
  const cls = d < 0 ? 'over' : d <= 2 ? 'soon' : 'ok';
  const text = d < 0 ? `${-d}d overdue` : d === 0 ? 'due today' : `${d}d left`;
  return <span className={`wk-left ${cls}`}>{text}</span>;
}
/** Most pressing first: overdue, then the soonest due, then anything already chased. */
const pressing = (a: WorkItem, b: WorkItem) => (daysLeft(a) ?? 999) - (daysLeft(b) ?? 999) || b.chasesSent - a.chasesSent;

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
        <span>{i.propertyAddress ?? i.matterRef ?? 'Case'}</span>
        {i.unblocks && <span>· unblocks {i.unblocks.toLowerCase()}</span>}
      </div>
      {i.bucket === 'escalate' && i.chasesSent > 0 && <div className="wk-clock"><span className="over">{i.chasesSent} chase{i.chasesSent === 1 ? '' : 's'} unanswered</span></div>}
    </a>
  );
}

/** Four at a time: the list is for acting on, not for reading end to end. */
function Column({ title, items, checkedAt }: { title: string; items: WorkItem[]; checkedAt?: Date }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 4);
  return (
    <div className="wk-col">
      <div className="wk-head" style={items.length ? undefined : { borderBottom: 0 }}><b>{title}</b><span className="n">{items.length}</span></div>
      {/* An empty list says so, and when it was checked: proof it is working, not blank. */}
      {!items.length && checkedAt && (
        <div className="wk-clear"><CheckCircle size={16} /><span>All clear</span><span className="t">checked {checkedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span></div>
      )}
      {shown.map((i) => <Item key={`${i.matterId}:${i.id}`} i={i} />)}
      {items.length > 4 && <button className="wk-more" onClick={() => setAll((a) => !a)}>{all ? 'Fewer' : `${items.length - 4} more`}</button>}
    </div>
  );
}

/**
 * Waiting on X to do Y by Z. Collapsed, one line: who holds how many, how many are
 * overdue, and when the next one falls due. Open, every line. It chases itself.
 */
export function Waiting({ items: all, total, onChanged }: { items: WorkItem[]; /** before any search, for the count */ total?: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  // Narrowed to whoever we are waiting on (click their count); grouped by case.
  const [whoFilter, setWhoFilter] = useState<string | null>(null);
  const items = whoFilter ? all.filter((i) => i.actionOwner === whoFilter) : all;
  // A search above narrows it: open, so the matches show.
  const expanded = open || (total != null && total !== all.length);
  const [sending, setSending] = useState<string | null>(null);
  const [sendErr, setSendErr] = useState<string | null>(null);
  // Send the chase now: the same template and record the timer would use, sent by a person.
  const sendNow = async (i: WorkItem) => {
    const at = i.ref.id.indexOf(':');
    const waitKey = at < 0 ? i.ref.id : i.ref.id.slice(0, at);
    const subject = at < 0 ? null : i.ref.id.slice(at + 1) || null;
    setSending(i.id);
    setSendErr(null);
    try {
      await api(`/matters/${i.matterId}/engine`, { method: 'POST', body: JSON.stringify({ type: 'chase_now', waitKey, subject }) });
      onChanged();
    } catch (e: unknown) {
      setSendErr(e instanceof Error ? e.message : 'The chase could not be sent.');
    } finally {
      setSending(null);
    }
  };
  const sorted = items.slice().sort(pressing);
  const overdue = items.filter((i) => (daysLeft(i) ?? 0) < 0).length;
  const upcoming = sorted.find((i) => (daysLeft(i) ?? -1) >= 0);
  const byWho = Object.entries(all.reduce<Record<string, number>>((m, i) => ((m[i.actionOwner] = (m[i.actionOwner] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  return (
    <div className="wk-wait">
      <button className="wk-wait-hd" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`chev${expanded ? ' open' : ''}`}><ChevronRight size={14} /></span>
        <b>Waiting</b><span className="n">{items.length}{total != null && total !== all.length ? ` of ${total}` : ''}</span>
        <span className="wk-who">{byWho.map(([who, n]) => <span key={who} role="button" tabIndex={0} className={whoFilter === who ? 'on' : undefined} onClick={(e) => { e.stopPropagation(); setWhoFilter(whoFilter === who ? null : who); setOpen(true); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setWhoFilter(whoFilter === who ? null : who); setOpen(true); } }}>{WHO_SHORT[who] ?? pretty(who)} {n}</span>)}</span>
        <span className="sum">
          {overdue > 0 && <span className="wk-left over">{overdue} overdue</span>}
          {upcoming && upcoming.chaseInWorkingDays != null && <span>next chase in {upcoming.chaseInWorkingDays} working day{upcoming.chaseInWorkingDays === 1 ? '' : 's'}</span>}
        </span>
      </button>
      {expanded && groupByCase(sorted).map((g) => (
        <div key={g.matterId} className="wk-case">
          <a className="wk-case-h" href={paths.matter(g.matterId)}><House band={g.band} size={16} /><b>{g.address}</b>{g.ref && <span>{g.ref}</span>}{g.clients && <span>{g.clients}</span>}<span className="n">{g.items.length}</span></a>
          {g.items.map((i) => {
        const who = OWNER[i.actionOwner] ?? pretty(i.actionOwner);
        const chasing = i.chaseDue ? <span className="over">Chasing {who} on the next sweep</span>
          : i.chaseInWorkingDays != null ? <span>Chasing {who} in {i.chaseInWorkingDays} working day{i.chaseInWorkingDays === 1 ? '' : 's'}</span>
          : <span>No further chase scheduled</span>;
        return (
          <div key={`${i.matterId}:${i.id}`} className="wk-row">
            <House band={i.urgency} size={18} />
            <a href={paths.matter(i.matterId)} style={{ textDecoration: 'none', color: 'inherit', minWidth: 0 }}>
              <span className="line"><b>{i.what.charAt(0).toUpperCase() + i.what.slice(1)}</b>{i.dueBy ? <> by {day(i.dueBy)}</> : null}</span>
              {i.chasesSent > 0 && <div className="meta">Chased {i.chasesSent}×</div>}
              {i.since && <div className="meta">Asked {day(i.since)}{i.openedBy ? ` by ${i.openedBy === 'system' || i.openedBy === 'ai' ? 'the system' : i.openedBy === 'external' ? 'the other side' : i.openedBy}` : ''}</div>}
            </a>
            <span className="right">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
                {chasing}
                <button type="button" className="wk-send" disabled={sending !== null} onClick={() => void sendNow(i)}>{sending === i.id ? 'Sending…' : 'Send Now'}</button>
              </div>
              {sendErr && sending === null && <div className="over" style={{ marginTop: 2 }}>{sendErr}</div>}
            </span>
          </div>
        );
      })}
        </div>
      ))}
      {expanded && items.length === 0 && <div className="wk-row" style={{ gridTemplateColumns: '1fr', color: '#94a3b8' }}>Nothing matches.</div>}
    </div>
  );
}

/** Waits by case, in the order their most pressing wait falls. */
function groupByCase(items: WorkItem[]) {
  const m = new Map<string, { matterId: string; address: string; ref: string | null; clients: string | null; band: WorkItem['urgency']; items: WorkItem[] }>();
  for (const i of items) {
    const g = m.get(i.matterId) ?? { matterId: i.matterId, address: i.propertyAddress ?? i.matterRef ?? 'Case', ref: i.matterRef, clients: i.clients?.length ? i.clients.join(' & ') : null, band: i.urgency, items: [] };
    g.items.push(i);
    m.set(i.matterId, g);
  }
  return Array.from(m.values());
}

/** `who`: '' for the whole team, otherwise one person's id. */
export default function EngineWork({ who }: { who: string }) {
  const [data, setData] = useState<{ do: WorkItem[]; waiting: WorkItem[]; escalate: WorkItem[] } | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const load = useCallback(async () => {
    try { setData(await api(who ? `/engine/my-work?user=${who}` : '/engine/my-work?all=1')); setCheckedAt(new Date()); } catch { setData(null); }
  }, [who]);
  useEffect(() => { void load(); }, [load]);
  if (!data) return null;
  // Decisions are the tray above; what is left of DO is issues and next steps.
  const doItems = data.do.filter((i) => i.ref?.type !== 'decision');
  return (
    <div>
      <style>{WORK_CSS}</style>
      <div className="wk-cols">
        {/* "All clear" only when nothing at all needs them, decisions in the tray included. */}
        <Column title="To Do" items={doItems} checkedAt={data.do.length === 0 ? checkedAt ?? undefined : undefined} />
        {data.escalate.length > 0 && <Column title="Escalate" items={data.escalate} />}
      </div>
      {data.waiting.length > 0 && <Waiting items={data.waiting} onChanged={() => void load()} />}
    </div>
  );
}
