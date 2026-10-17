'use client';
/**
 * Create Cases In InTouch: which of the firm's InTouch data markers takes each field of a case opened in CONVEYi
 * (lib/server/integrations/intouch/case-system.ts). Off until the required ones are filled in.
 */
import { useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { BusyButton } from '@/app/shared/engine/BusyButton';
import { CREATE_FIELDS, markersReady, type CreateMarkers } from '@/lib/server/integrations/intouch/create-fields';

export function CreateCases({ markers, canManage }: { markers: CreateMarkers; canManage: boolean }) {
  const [m, setM] = useState<CreateMarkers>(markers ?? {});
  const [err, setErr] = useState<string | null>(null);
  const on = markersReady(m);
  const set = (k: string, v: string) => setM((x) => ({ ...x, [k]: v }));
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.4fr)', gap: '6px 14px', alignItems: 'center', maxWidth: 640 }}>
        <span className="eg-sub" style={{ fontWeight: 800 }}>Field</span>
        <span className="eg-sub" style={{ fontWeight: 800 }}>Your InTouch Data Marker</span>
        {CREATE_FIELDS.map((f) => (
          <div key={f.key} style={{ display: 'contents' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{f.label}{f.required ? ' *' : ''}</span>
            <input className="eg-in" disabled={!canManage} value={(m[f.key] as string | undefined) ?? ''} onChange={(e) => set(f.key, e.target.value)} placeholder={f.key === 'reference' ? 'e.g. matter.reference' : ''} aria-label={`InTouch data marker for ${f.label}`} />
          </div>
        ))}
        <span style={{ fontSize: 13, fontWeight: 600 }}>Workflow Template</span>
        <span style={{ display: 'flex', gap: 6 }}>
          <input className="eg-in" style={{ flex: 1, minWidth: 0 }} disabled={!canManage} value={m.template?.marker ?? ''} onChange={(e) => setM((x) => ({ ...x, template: { marker: e.target.value, value: x.template?.value ?? '' } }))} placeholder="Marker" aria-label="Template data marker" />
          <input className="eg-in" style={{ flex: 1, minWidth: 0 }} disabled={!canManage} value={m.template?.value ?? ''} onChange={(e) => setM((x) => ({ ...x, template: { marker: x.template?.marker ?? '', value: e.target.value } }))} placeholder="Value" aria-label="Template value" />
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
        {canManage && <BusyButton className="eg-btn primary" busyLabel="Saving…" doneLabel="Saved" onClick={async () => {
          try { await api('/integrations/intouch/create-markers', { method: 'POST', body: JSON.stringify({ ...m, template: m.template?.marker?.trim() && m.template?.value?.trim() ? m.template : null }) }); setErr(null); return true; }
          catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not save.'); return false; }
        }}>Save</BusyButton>}
        <span className="eg-sub">{on ? 'On: new cases are created in InTouch' : 'Off until the starred fields are filled in'}</span>
      </div>
      {err && <div className="eg-err" style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}
