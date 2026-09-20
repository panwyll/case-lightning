'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../shared/engine/api';
import { ENGINE_CSS } from '../shared/engine/ui';
import { STAGE_LABEL, ago, fmtDay, type QueueRow } from '../shared/engine/types';

/**
 * Addendum 3 §3 — the queue. One row per matter assigned to the handler: address,
 * current stage, a pending badge (decisions waiting on a person), the age of the oldest
 * one and the target completion date. Default sort: oldest pending decision first;
 * alternatively by target completion date. Click → the matter's timeline.
 */
type Sort = 'oldest_pending' | 'target_completion';

export default function QueuePage() {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [sort, setSort] = useState<Sort>('oldest_pending');
  const [all, setAll] = useState(false);
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ rows: QueueRow[]; scope: 'mine' | 'all' }>(`/engine/queue?sort=${sort}&all=${all ? 1 : 0}`);
      setRows(r.rows);
      setScope(r.scope);
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load the queue.');
    }
  }, [sort, all]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const waiting = (rows ?? []).reduce((n, r) => n + r.pendingCount, 0);
  return (
    <div className="eg" style={{ maxWidth: 980, margin: '0 auto', padding: '24px 16px' }}>
      <style>{ENGINE_CSS}</style>
      <div className="eg-top">
        <div>
          <h1 className="eg-h1">Queue</h1>
          <p className="eg-sub">{rows ? `${rows.length} matter${rows.length === 1 ? '' : 's'} · ${waiting} decision${waiting === 1 ? '' : 's'} waiting on a person` : 'Loading…'}{scope === 'all' ? ' · every handler' : ''}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12.5, color: '#64748b' }}>
            Sort{' '}
            <select className="eg-sel" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="oldest_pending">Oldest pending decision</option>
              <option value="target_completion">Target completion date</option>
            </select>
          </label>
          <button className={`eg-btn${all ? ' on' : ''}`} onClick={() => setAll((x) => !x)} title="Seniors and admins can see every handler's matters">{all ? 'All handlers' : 'My matters'}</button>
          <a className="eg-btn" href="/engine/shadow">Rollout</a>
        </div>
      </div>
      {err && <div className="eg-err">{err}</div>}
      {rows && rows.length === 0 && <div className="eg-empty">Nothing assigned to you is enrolled in the engine{all ? '' : ' — try “All handlers”'}.</div>}
      {rows && rows.length > 0 && (
        <div className="eg-card">
          {rows.map((r) => (
            <a key={r.matterId} className="q-row" href={`/engine/${r.matterId}`}>
              <div style={{ minWidth: 0 }}>
                <div className="q-addr">{r.propertyAddress ?? r.matterRef ?? r.matterId}</div>
                <div className="q-ref">
                  {r.matterRef ?? ''}{r.manualHandling ? ' · manual handling' : ''}{r.shadowMode ? ' · shadow' : ''}
                </div>
              </div>
              <span className="eg-chip stage">{STAGE_LABEL[r.stage] ?? r.stage}</span>
              <div className="q-cell">
                {r.pendingCount > 0 ? <span className={`eg-chip pending${r.oldestPendingAt && Date.now() - new Date(r.oldestPendingAt).getTime() > 86_400_000 ? ' hot' : ''}`}>{r.pendingCount} pending · {ago(r.oldestPendingAt)}</span> : <span className="eg-chip muted">nothing pending</span>}
                {r.reviewCount > 0 && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>{r.reviewCount} auto-clear review{r.reviewCount === 1 ? '' : 's'}</div>}
                {r.openIssues > 0 && <div style={{ fontSize: 11, color: r.holdingIssues > 0 ? '#b45309' : '#94a3b8', marginTop: 3 }}>{r.openIssues} open issue{r.openIssues === 1 ? '' : 's'}{r.holdingIssues > 0 ? ` · ${r.holdingIssues} holding ${r.stage === 'pre_completion' || r.stage === 'exchanged' ? 'completion' : 'exchange'}` : ''}</div>}
              </div>
              <div className="q-cell hide">
                <b>{r.targetCompletionDate ? fmtDay(r.targetCompletionDate) : '—'}</b>
                <div style={{ fontSize: 11 }}>target completion</div>
              </div>
            </a>
          ))}
        </div>
      )}
      <p className="eg-sub" style={{ marginTop: 14 }}>Pending counts only what a person can act on. Auto-clear reviews (assist level) are advisory and do not block a matter; shadow-mode matters are not listed here.</p>
    </div>
  );
}
