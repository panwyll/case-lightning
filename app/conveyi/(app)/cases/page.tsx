'use client';
import { useCallback, useEffect, useState } from 'react';
import { CaseloadMap } from '@/app/shared/engine/CaseloadMap';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import type { CaseToken, CaseloadRollup } from '@/app/shared/engine/types';

/**
 * The caseload (docs/caseload-ux.md §1–2). The firm's whole book of work on one sheet:
 * a house per matter, standing in the phase it has reached, coloured and badged by health.
 * Everything deeper — the case, its workstreams, the evidence — is one click further in.
 */
export default function CasesPage() {
  const [rows, setRows] = useState<CaseToken[] | null>(null);
  const [rollup, setRollup] = useState<CaseloadRollup | null>(null);
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ rows: CaseToken[]; rollup: CaseloadRollup }>(`/engine/caseload?mine=${scope === 'mine' ? 1 : 0}`);
      setRows(r.rows);
      setRollup(r.rollup);
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load the caseload.');
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="eg" style={{ maxWidth: 1040, margin: '0 auto', padding: '16px 16px 60px' }}>
      <style>{ENGINE_CSS}</style>
      <div className="eg-top">
        <div>
          <h1 className="eg-h1">Caseload</h1>
          <p className="eg-sub">
            {rollup ? `${rollup.total + (rollup.untracked ?? 0)} open · ${rollup.total} followed by CONVEYi · ${rollup.needsSomeone} need someone` : 'Loading…'}
            {' · '}health is measured against what each phase should take, not the age of the case
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className={`eg-btn${scope === 'mine' ? ' on' : ''}`} onClick={() => setScope(scope === 'mine' ? 'all' : 'mine')}>
            {scope === 'mine' ? 'My matters' : 'Whole team'}
          </button>
        </div>
      </div>
      {err && <div className="eg-err">{err}</div>}
      {!rows && !err && <div className="eg-sub">Reading the caseload…</div>}
      {rows && rows.length === 0 && <div className="eg-empty">No matters are enrolled in the engine yet.</div>}
      {rows && rows.length > 0 && rollup && (
        <CaseloadMap rows={rows} rollup={rollup} onOpen={(id) => { window.location.href = `/engine/${id}`; }} />
      )}
    </div>
  );
}
