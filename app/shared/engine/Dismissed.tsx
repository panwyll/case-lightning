'use client';
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, X } from '@/app/shared/icons';
import { fmtWhen, type Api } from './types';

const CSS = `
.dm-x{width:28px;height:28px;padding:0;border:0;background:none;color:#94a3b8;border-radius:7px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:none}
.dm-x:hover{background:#fee2e2;color:#b91c1c}
.dm-box{margin-top:14px;border:1px solid #e6e8ee;border-radius:12px;background:#fff}
.dm-box > button{display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;padding:10px 14px;font:inherit;font-size:13px;font-weight:800;color:#0f172a;cursor:pointer;text-align:left}
.dm-box .n{color:#94a3b8;font-weight:600}
.dm-row{display:flex;align-items:center;gap:10px;padding:8px 14px;border-top:1px solid #f1f5f9;font-size:13px;color:#334155}
.dm-row .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-row .m{color:#94a3b8;font-size:12px;white-space:nowrap}
.dm-row button{border:1px solid #5A27E0;background:#fff;color:#5A27E0;border-radius:8px;padding:5px 11px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit}
`;

/** Takes a task out of the tray (restorable from Dismissed). `ref` is `decision:<eventId>` or `step:<key>`. */
export async function dismissTask(api: Api, matterId: string, ref: string, title: string): Promise<void> {
  await api('/tasks/dismissed', { method: 'POST', body: JSON.stringify({ matterId, ref, title }) });
  window.dispatchEvent(new Event('conveyi:counts'));
}

export function DismissButton({ onClick }: { onClick: () => void }) {
  return <button type="button" className="dm-x" title="Dismiss (restore it from Dismissed)" aria-label="Dismiss" onClick={onClick}><X size={16} /></button>;
}

/** One case's dismissed tasks, folded; Restore puts a task back. `reloadKey` changes when something was dismissed. */
export function DismissedTasks({ api, matterId, reloadKey, onRestored }: { api: Api; matterId: string; reloadKey: number; onRestored: () => void }) {
  const [rows, setRows] = useState<Array<{ id: string; title: string | null; ref: string; dismissedAt: string; dismissedBy: string | null }>>([]);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => { api<{ dismissed: typeof rows }>(`/tasks/dismissed?matterId=${matterId}`).then((r) => setRows(r.dismissed)).catch(() => {}); }, [api, matterId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load, reloadKey]);
  const restore = async (id: string) => {
    setRows((cur) => cur.filter((d) => d.id !== id));
    await api('/tasks/dismissed', { method: 'POST', body: JSON.stringify({ restore: id }) }).catch(() => {});
    window.dispatchEvent(new Event('conveyi:counts'));
    onRestored();
    load();
  };
  return (
    <>
      <style>{CSS}</style>
      {rows.length > 0 && (
        <div className="dm-box">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}><ChevronRight size={16} style={{ transform: open ? 'rotate(90deg)' : undefined }} />Dismissed<span className="n">{rows.length}</span></button>
          {open && rows.map((d) => (
            <div key={d.id} className="dm-row">
              <span className="t">{d.title ?? d.ref}</span>
              <span className="m">{fmtWhen(d.dismissedAt)}{d.dismissedBy ? ` · ${d.dismissedBy}` : ''}</span>
              <button type="button" onClick={() => void restore(d.id)}>Restore</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
