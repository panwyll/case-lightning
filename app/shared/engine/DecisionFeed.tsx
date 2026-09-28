'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DecisionCard, DECISION_CSS } from './DecisionCard';
import { DecisionPanel } from './DecisionPanel';
import { ChevronRight } from '@/app/shared/icons';
import { KIND_LABEL, pretty, type Api, type DecisionRow , chipLabel , quickApprovable } from './types';

const ROW_CSS = `
.df-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px 14px;align-items:center;padding:10px 14px;border:1px solid #e6e8ee;border-radius:12px;background:#fff;margin-bottom:8px}
.df-chip{display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#475569;background:#f1f5f9;border-radius:999px;padding:2px 8px;margin-right:8px;vertical-align:1px}
.df-chip.prop{color:#5A27E0;background:#f5f3ff}
.df-row .what{font-size:13.5px;font-weight:600;line-height:1.35;color:#0f172a}
.df-btn{border:1px solid #5A27E0;background:#fff;color:#5A27E0;border-radius:8px;padding:6px 12px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.df-btn:hover{background:#f5f3ff}
.df-btn.go{background:#5A27E0;color:#fff}
.df-btn.on{color:#64748b;border-color:#e2e8f0;padding:6px 8px}
.df-item.open{background:#f8f7ff;box-shadow:inset 3px 0 0 #5A27E0;border-radius:12px;padding:0 0 10px;margin-bottom:10px}
.df-item.open .df-row{margin-bottom:0;border-color:transparent;background:transparent}
.df-open{margin:0 10px 0 13px;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden;background:#fff}
`;

/** "search:CON29" → "CON29"; a bare id → nothing. */
const subjectLabel = (s: string | null | undefined): string => {
  if (!s) return '';
  const tail = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  if (/^(rot|bd|pof|draft)?-?[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(tail)) return '';
  return tail.replace(/\s*\(mock[^)]*\)/i, '').replace(/_/g, ' ');
};

/**
 * The "Spark Notes" feed (component #6): only decision events, oldest first, grouped
 * by matter, filterable by kind. Used by /decisions, the admin matter drawer (scoped
 * to one matter) and the Outlook taskpane (compact).
 */
export function DecisionFeed({ api, matterId, compact = false, limit = 200, onCount, hideWhenEmpty = false, onResolved }: { api: Api; matterId?: string; compact?: boolean; limit?: number; onCount?: (n: number) => void; hideWhenEmpty?: boolean; onResolved?: () => void }) {
  const [rows, setRows] = useState<DecisionRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<string>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [quickErr, setQuickErr] = useState<{ id: string; text: string } | null>(null);
  // Rows acted on are hidden at once and stay hidden until the server stops listing them, so a
  // load that started before an approval landed cannot bring a row back. Only the newest load applies.
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const loadSeq = useRef(0);
  const hide = (id: string, on: boolean) => setDone((prev) => { const n = new Set(prev); if (on) n.add(id); else n.delete(id); return n; });

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const d = await api<{ decisions: DecisionRow[] }>(`/decisions?limit=${limit}${matterId ? `&matterId=${matterId}` : ''}`);
      if (seq !== loadSeq.current) return;
      setRows(d.decisions);
      setDone((prev) => { const listed = new Set(d.decisions.map((x) => x.eventId)); const n = new Set([...prev].filter((id) => listed.has(id))); return n.size === prev.size ? prev : n; });
      setErr(null);
    } catch (e: unknown) {
      if (seq === loadSeq.current) setErr(e instanceof Error ? e.message : 'Could not load decisions.');
    }
  }, [api, matterId, limit]);

  const resolved = (eventId: string) => {
    hide(eventId, true);
    setOpen((o) => (o === eventId ? null : o));
    onResolved?.();
    void load();
  };
  const quickApprove = async (eventId: string) => {
    hide(eventId, true);
    setQuickErr((q) => (q?.id === eventId ? null : q));
    try { await api(`/decisions/${eventId}/resolve`, { method: 'POST', body: JSON.stringify({ option: 'approve' }) }); onResolved?.(); void load(); }
    catch (e: unknown) {
      const status = (e as { status?: number })?.status;
      if (status === 409) { onResolved?.(); void load(); return; }
      hide(eventId, false);
      setQuickErr({ id: eventId, text: e instanceof Error ? e.message : 'Could not approve.' });
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const live = useMemo(() => (rows === null ? null : rows.filter((r) => !done.has(r.eventId))), [rows, done]);
  useEffect(() => { if (live) onCount?.(live.length); }, [live, onCount]);
  const kinds = useMemo(() => Array.from(new Set((live ?? []).map((r) => r.kind))), [live]);
  const visible = useMemo(() => (live ?? []).filter((r) => kind === 'all' || r.kind === kind), [live, kind]);
  const groups = useMemo(() => {
    const m = new Map<string, DecisionRow[]>();
    for (const r of visible) {
      const k = r.matterId;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return [...m.entries()];
  }, [visible]);

  if (hideWhenEmpty && (live === null || live.length === 0)) return null;
  return (
    <div>
      <style>{DECISION_CSS + ROW_CSS}</style>
      {err && <div className="dc-err">{err}</div>}
      {live === null && !err && <div style={{ color: '#94a3b8', fontSize: 13, padding: 12 }}>Loading…</div>}
      {live && live.length === 0 && <div style={{ color: '#64748b', fontSize: 14, padding: compact ? 12 : 30, textAlign: 'center', border: '1px dashed #e2e8f0', borderRadius: 12 }}>Nothing waiting on you{matterId ? ' for this case' : ''}.</div>}
      {live && live.length > 0 && kinds.length > 1 && !compact && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {['all', ...kinds].map((k) => (
            <button key={k} className="dc-btn" style={{ margin: 0, background: kind === k ? '#0f172a' : '#fff', color: kind === k ? '#fff' : '#0f172a' }} onClick={() => setKind(k)}>
              {k === 'all' ? `All (${live.length})` : `${KIND_LABEL[k] ?? pretty(k)} (${live.filter((r) => r.kind === k).length})`}
            </button>
          ))}
        </div>
      )}
      {groups.map(([mid, list]) => (
        <div key={mid} style={{ marginBottom: compact ? 8 : 18 }}>
          {!matterId && !compact && (
            <div style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', color: '#64748b', margin: '0 0 6px' }}>
              {list[0].matterRef ?? mid}{list[0].propertyAddress ? ` — ${list[0].propertyAddress}` : ''} · {list.length} decision{list.length === 1 ? '' : 's'}
            </div>
          )}
          {list.map((d) => compact ? (
            <DecisionCard key={d.eventId} decision={d} api={api} compact showMatter={!matterId} onResolved={() => resolved(d.eventId)} />
          ) : (
            <div key={d.eventId} className={`df-item${open === d.eventId ? ' open' : ''}`}>
              <div className="df-row">
                <div className="what">{quickErr?.id === d.eventId && <div style={{ color: '#b91c1c', fontSize: 12, fontWeight: 500 }}>{quickErr.text}</div>}<span className={`df-chip${d.kind === 'proposal' ? ' prop' : ''}`}>{d.chip ?? chipLabel(d.kind)}</span>{d.what ?? `${KIND_LABEL[d.kind] ?? pretty(d.kind)}${subjectLabel(d.subject) ? ` · ${subjectLabel(d.subject)}` : ''}`}</div>
                {quickApprovable(d.taskKind) && open !== d.eventId && <button type="button" className="df-btn go" onClick={() => void quickApprove(d.eventId)}>Approve</button>}
                <button type="button" className={`df-btn${open === d.eventId ? ' on' : ''}`} aria-label={open === d.eventId ? 'Collapse' : 'Review'} onClick={() => setOpen(open === d.eventId ? null : d.eventId)}>{open === d.eventId ? null : 'Review '}<ChevronRight size={14} style={{ transform: open === d.eventId ? 'rotate(90deg)' : undefined }} /></button>
              </div>
              {open === d.eventId && (
                <div className="df-open">
                  <DecisionPanel eventId={d.eventId} inline onResolved={() => resolved(d.eventId)} />
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
