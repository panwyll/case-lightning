'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CaseloadMap } from '@/app/shared/engine/CaseloadMap';
import { ScopeSelect, type Scope } from '@/app/shared/engine/ScopeSelect';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import type { CaseToken, CaseloadRollup } from '@/app/shared/engine/types';
import { paths } from '@/lib/paths';

/** The caseload: a house per matter, in the phase it has reached, coloured by health. A house opens the matter. */
export default function CasesPage() {
  const [rows, setRows] = useState<CaseToken[] | null>(null);
  const [rollup, setRollup] = useState<CaseloadRollup | null>(null);
  const [scope, setScope] = useState<Scope>('all');
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      let r = await api<{ rows: CaseToken[]; rollup: CaseloadRollup }>(`/engine/caseload?mine=${scope === 'mine' ? 1 : 0}`);
      // Every open matter is tracked. One that is not gets enrolled now, then the map re-reads.
      if ((r.rollup.untracked ?? 0) > 0) {
        await api('/admin/enrol-all', { method: 'POST', body: '{}' }).catch(() => {});
        r = await api<{ rows: CaseToken[]; rollup: CaseloadRollup }>(`/engine/caseload?mine=${scope === 'mine' ? 1 : 0}`);
      }
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
    <div className="eg">
      <style>{ENGINE_CSS}</style>
      {err && <div className="eg-err">{err}</div>}
      {rows && rollup ? (
        <CaseloadMap title="Caseload" actions={<ScopeSelect value={scope} onChange={setScope} />} rows={rows} rollup={rollup} onOpen={(id) => router.push(paths.matter(id))} />
      ) : (
        <div className="eg-top"><h1 className="eg-h1">Caseload</h1></div>
      )}
    </div>
  );
}
