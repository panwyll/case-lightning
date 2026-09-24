'use client';
import { useCallback, useEffect, useState } from 'react';
import { CaseloadMap } from '@/app/shared/engine/CaseloadMap';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import type { CaseToken, CaseloadRollup } from '@/app/shared/engine/types';
import MatterDrawer from '@/app/conveyi/(app)/admin/MatterDrawer';

/**
 * The caseload (docs/caseload-ux.md §1–2). The firm's whole book of work on one sheet:
 * a house per matter, standing in the phase it has reached, coloured and badged by health.
 * Everything deeper — the case, its workstreams, the evidence — is one click further in.
 *
 * A house opens the same matter drawer the board does — overview, engine, flow, emails,
 * files, to-do, activity — so there is one view of a matter wherever you click it from.
 */
export default function CasesPage() {
  const [rows, setRows] = useState<CaseToken[] | null>(null);
  const [rollup, setRollup] = useState<CaseloadRollup | null>(null);
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<{ matter: Record<string, unknown>; assignees: Array<{ id: string; email: string; display_name: string | null }> } | null>(null);

  const openMatter = useCallback(async (matterId: string) => {
    try {
      setOpen(await api<{ matter: Record<string, unknown>; assignees: Array<{ id: string; email: string; display_name: string | null }> }>(`/matters/${matterId}/row`));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not open that matter.');
    }
  }, []);

  /** An edit in the drawer (stage, owner, status) moves the house, so re-read the map. */
  const patch = useCallback(async (id: string, body: Record<string, unknown>) => {
    try {
      await api(`/matters/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not save that change.');
    }
  }, []);

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
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className={`eg-btn${scope === 'mine' ? ' on' : ''}`} onClick={() => setScope(scope === 'mine' ? 'all' : 'mine')}>
            {scope === 'mine' ? 'My matters' : 'Whole team'}
          </button>
        </div>
      </div>
      {err && <div className="eg-err">{err}</div>}
      {!rows && !err && <div className="eg-sub">Reading the caseload…</div>}
      {rows && rows.length === 0 && <div className="eg-empty">No open matters{scope === 'mine' ? ' assigned to you' : ''} yet.</div>}
      {rows && rows.length > 0 && rollup && <CaseloadMap rows={rows} rollup={rollup} onOpen={(id) => void openMatter(id)} />}
      {open && (
        <MatterDrawer
          matter={open.matter}
          api={api}
          users={open.assignees}
          onPatch={(id, body) => void patch(id, body)}
          // Closing re-reads the map: the drawer's Engine tab may have just enrolled it,
          // or a stage change may have moved it to another band.
          onClose={() => { setOpen(null); void load(); }}
        />
      )}
    </div>
  );
}
