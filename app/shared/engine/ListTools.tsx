'use client';
import { useMemo, useState, type ReactNode } from 'react';

/**
 * One way to keep any list that can grow from becoming a scroll job: a search box, filter
 * chips, and date groups the way Outlook shows mail (Today, Yesterday, This week, Last week,
 * Earlier this month, then by month), recent groups open and older ones folded.
 */
export type Bucket = { key: string; label: string; open: boolean };

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export function bucketOf(iso: string, now = new Date()): Bucket {
  const d = new Date(iso);
  const today = startOfDay(now).getTime();
  const day = startOfDay(d).getTime();
  const DAY = 86_400_000;
  const dow = (startOfDay(now).getDay() + 6) % 7; // Monday = 0
  const weekStart = today - dow * DAY;
  if (day >= today) return { key: '0', label: 'Today', open: true };
  if (day >= today - DAY) return { key: '1', label: 'Yesterday', open: true };
  if (day >= weekStart) return { key: '2', label: 'This Week', open: true };
  if (day >= weekStart - 7 * DAY) return { key: '3', label: 'Last Week', open: false };
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return { key: '4', label: 'Earlier This Month', open: false };
  const m = d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return { key: `5-${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`, label: m, open: false };
}

export interface Filter<T> { key: string; label: string; match: (t: T) => boolean }

export function useListTools<T>(items: T[], opts: { date: (t: T) => string; text: (t: T) => string; filters?: Filter<T>[]; newestFirst?: boolean }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const q = query.trim().toLowerCase();
  const searching = q.length > 0 || filter !== 'all';
  const shown = useMemo(() => items.filter((t) => (!q || opts.text(t).toLowerCase().includes(q)) && (filter === 'all' || (opts.filters?.find((f) => f.key === filter)?.match(t) ?? true))), [items, q, filter, opts]);
  const groups = useMemo(() => {
    const out: Array<Bucket & { items: T[] }> = [];
    const byKey = new Map<string, Bucket & { items: T[] }>();
    const now = new Date();
    const sorted = [...shown].sort((a, b) => (opts.newestFirst === false ? 1 : -1) * (opts.date(a) < opts.date(b) ? -1 : opts.date(a) > opts.date(b) ? 1 : 0));
    for (const t of sorted) {
      const b = bucketOf(opts.date(t), now);
      let g = byKey.get(b.key);
      if (!g) { g = { ...b, items: [] }; byKey.set(b.key, g); out.push(g); }
      g.items.push(t);
    }
    return out;
  }, [shown, opts]);
  // A search opens every group it found something in; otherwise recent groups start open.
  const isOpen = (g: Bucket) => (g.key in toggled ? toggled[g.key] : searching || g.open);
  const toggle = (g: Bucket) => setToggled((m) => ({ ...m, [g.key]: !isOpen(g) }));
  return { query, setQuery, filter, setFilter, groups, isOpen, toggle, total: items.length, shown: shown.length };
}

/** The search box and filter chips over a list. */
export function ListToolbar<T>({ tools, filters, placeholder = 'Search' }: { tools: ReturnType<typeof useListTools<T>>; filters?: Filter<T>[]; placeholder?: string }) {
  return (
    <div className="lt-bar">
      <style>{CSS}</style>
      <input className="lt-q" type="search" value={tools.query} onChange={(e) => tools.setQuery(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {filters && filters.length > 0 && (
        <div className="lt-chips" role="group" aria-label="Filter">
          <button type="button" className={`lt-chip${tools.filter === 'all' ? ' on' : ''}`} onClick={() => tools.setFilter('all')} aria-pressed={tools.filter === 'all'}>All</button>
          {filters.map((f) => <button key={f.key} type="button" className={`lt-chip${tools.filter === f.key ? ' on' : ''}`} onClick={() => tools.setFilter(tools.filter === f.key ? 'all' : f.key)} aria-pressed={tools.filter === f.key}>{f.label}</button>)}
        </div>
      )}
      {(tools.query || tools.filter !== 'all') && <span className="lt-n">{tools.shown} of {tools.total}</span>}
    </div>
  );
}

/** The date groups, each folding on its header. */
export function Grouped<T>({ tools, render, empty = 'Nothing here.' }: { tools: ReturnType<typeof useListTools<T>>; render: (t: T, g: Bucket) => ReactNode; empty?: string }) {
  if (!tools.groups.length) return <div className="lt-empty"><style>{CSS}</style>{tools.total ? 'Nothing matches.' : empty}</div>;
  return (
    <div className="lt">
      <style>{CSS}</style>
      {tools.groups.map((g) => {
        const open = tools.isOpen(g);
        return (
          <section key={g.key} className="lt-g">
            <button type="button" className="lt-h" onClick={() => tools.toggle(g)} aria-expanded={open}>
              <span className={`lt-car${open ? ' open' : ''}`} aria-hidden>›</span>{g.label}<span className="lt-c">{g.items.length}</span>
            </button>
            {open && <div className="lt-body">{g.items.map((t) => render(t, g))}</div>}
          </section>
        );
      })}
    </div>
  );
}

/** When a row outside Today / Yesterday needs its day as well as its time. */
export const whenIn = (iso: string, g: Bucket) => {
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return g.key === '0' || g.key === '1' ? t : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · ${t}`;
};

const CSS = `
.lt-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 10px}
.lt-q{flex:1;min-width:200px;max-width:360px;border:1px solid #cbd5e1;border-radius:8px;padding:6px 10px;font:inherit;font-size:13px;background:#fff}
.lt-chips{display:flex;gap:6px;flex-wrap:wrap}
.lt-chip{border:1px solid #e2e8f0;background:#fff;border-radius:999px;padding:3px 11px;font-size:12px;font-weight:600;color:#475569;cursor:pointer}
.lt-chip.on{background:#0f172a;border-color:#0f172a;color:#fff}
.lt-n{font-size:12px;color:#94a3b8}
.lt-g{margin-bottom:4px}
.lt-h{display:flex;align-items:center;gap:8px;width:100%;background:none;border:0;border-bottom:1px solid #eef1f5;padding:7px 2px;font:inherit;font-size:11.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#64748b;cursor:pointer;text-align:left}
.lt-h:hover{color:#0f172a}
.lt-car{display:inline-block;transition:transform .12s;font-size:14px;line-height:1}
.lt-car.open{transform:rotate(90deg)}
.lt-c{margin-left:auto;font-weight:700;color:#94a3b8;letter-spacing:0}
.lt-body{padding:4px 0 8px}
.lt-empty{font-size:13px;color:#94a3b8;padding:8px 2px}
`;
