'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DecisionCard, DECISION_CSS } from './DecisionCard';
import { KIND_LABEL, pretty, type Api, type DecisionRow } from './types';

/**
 * The "Spark Notes" feed (component #6): only decision events, oldest first, grouped
 * by matter, filterable by kind. Used by /decisions, the admin matter drawer (scoped
 * to one matter) and the Outlook taskpane (compact).
 */
export function DecisionFeed({ api, matterId, compact = false, limit = 200, onCount, hideWhenEmpty = false, onResolved }: { api: Api; matterId?: string; compact?: boolean; limit?: number; onCount?: (n: number) => void; hideWhenEmpty?: boolean; onResolved?: () => void }) {
  const [rows, setRows] = useState<DecisionRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<string>('all');

  const load = useCallback(async () => {
    try {
      const d = await api<{ decisions: DecisionRow[] }>(`/decisions?limit=${limit}${matterId ? `&matterId=${matterId}` : ''}`);
      setRows(d.decisions);
      setErr(null);
      onCount?.(d.decisions.length);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load decisions.');
    }
  }, [api, matterId, limit, onCount]);

  useEffect(() => {
    void load();
  }, [load]);

  const kinds = useMemo(() => Array.from(new Set((rows ?? []).map((r) => r.kind))), [rows]);
  const visible = useMemo(() => (rows ?? []).filter((r) => kind === 'all' || r.kind === kind), [rows, kind]);
  const groups = useMemo(() => {
    const m = new Map<string, DecisionRow[]>();
    for (const r of visible) {
      const k = r.matterId;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return [...m.entries()];
  }, [visible]);

  if (hideWhenEmpty && (rows === null || rows.length === 0)) return null;
  return (
    <div>
      <style>{DECISION_CSS}</style>
      {err && <div className="dc-err">{err}</div>}
      {rows === null && !err && <div style={{ color: '#94a3b8', fontSize: 13, padding: 12 }}>Loading…</div>}
      {rows && rows.length === 0 && <div style={{ color: '#64748b', fontSize: 14, padding: compact ? 12 : 30, textAlign: 'center', border: '1px dashed #e2e8f0', borderRadius: 12 }}>Nothing waiting on you{matterId ? ' for this case' : ''}.</div>}
      {rows && rows.length > 0 && kinds.length > 1 && !compact && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {['all', ...kinds].map((k) => (
            <button key={k} className="dc-btn" style={{ margin: 0, background: kind === k ? '#0f172a' : '#fff', color: kind === k ? '#fff' : '#0f172a' }} onClick={() => setKind(k)}>
              {k === 'all' ? `All (${rows.length})` : `${KIND_LABEL[k] ?? pretty(k)} (${rows.filter((r) => r.kind === k).length})`}
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
          {list.map((d) => (
            <DecisionCard key={d.eventId} decision={d} api={api} compact={compact} showMatter={!matterId && compact} onResolved={() => { void load(); onResolved?.(); }} />
          ))}
        </div>
      ))}
    </div>
  );
}
