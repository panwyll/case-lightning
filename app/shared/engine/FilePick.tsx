'use client';
import { useMemo, useRef, useState } from 'react';
import { Upload, FileText, X, Search, Loader, Check } from '@/app/shared/icons';
import { fmtDay, type CaseDocument } from './types';

/**
 * Choosing the file that evidences something: drop or upload it, or pick one of the few recent files
 * on the case (the ones that fit first), searchable. Never a dropdown of every file on the case.
 * Once chosen it is one line with Open and a way to clear it.
 */
const CSS = `
.fp{display:grid;gap:8px}
.fp-drop{display:flex;align-items:center;justify-content:center;gap:8px;border:1.5px dashed #cbd5e1;border-radius:10px;padding:14px;font-size:13px;font-weight:600;color:#475569;background:#fff;cursor:pointer}
.fp-drop:hover,.fp-drop.over{border-color:#5A27E0;color:#5A27E0;background:#f5f3ff}
.fp-drop[aria-busy=true]{cursor:progress}
.fp-find{position:relative}
.fp-find svg{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:#94a3b8}
.fp-find input{padding-left:32px !important}
.fp-list{display:grid;background:#fff;border:1px solid #e6e8ee;border-radius:10px;overflow:hidden}
.fp-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border:0;border-top:1px solid #f1f5f9;background:none;font:inherit;font-size:13px;color:#0f172a;text-align:left;cursor:pointer}
.fp-item:first-child{border-top:0}
.fp-item:hover{background:#f5f3ff}
.fp-item svg{flex:none;color:#64748b}
.fp-item .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-item .d{flex:none;font-size:12px;color:#94a3b8}
.fp-none{padding:8px 10px;font-size:12.5px;color:#64748b}
.fp-chosen{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #bbf7d0;border-radius:10px;padding:8px 10px;font-size:13px;font-weight:600;color:#0f172a}
.fp-chosen > svg{color:#166534;flex:none}
.fp-chosen .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-chosen a{font-size:12.5px;font-weight:700;color:#5A27E0;text-decoration:none}
.fp-chosen button{border:0;background:none;padding:2px;color:#64748b;cursor:pointer;display:inline-flex}
.bb-spin{animation:fp-spin .8s linear infinite;flex:none}
@keyframes fp-spin{to{transform:rotate(360deg)}}
.fp-err{font-size:12.5px;color:#b91c1c;font-weight:600}
`;

export function FilePick({ docs, value, onChange, upload, fits, since, shown = 4 }: {
  /** The case's files (null while loading). */
  docs: CaseDocument[] | null;
  value: string;
  onChange: (id: string) => void;
  /** Files a new document and returns it. */
  upload?: (file: File) => Promise<CaseDocument>;
  /** Files of the right kind come first. */
  fits?: (d: CaseDocument) => boolean;
  /** Files added since this moment (the issue was raised, the step opened) come first. */
  since?: string | null;
  shown?: number;
}) {
  const [q, setQ] = useState('');
  const [added, setAdded] = useState<CaseDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const all = useMemo(() => {
    const list = [...added, ...(docs ?? []).filter((d) => !added.some((a) => a.id === d.id))];
    const score = (d: CaseDocument) => (fits?.(d) ? 2 : 0) + (since && d.createdAt >= since ? 1 : 0);
    return list.sort((a, b) => score(b) - score(a) || b.createdAt.localeCompare(a.createdAt));
  }, [docs, added, fits, since]);
  const chosen = all.find((d) => d.id === value) ?? null;
  const needle = q.trim().toLowerCase();
  const matches = needle ? all.filter((d) => `${d.fileName ?? ''} ${d.docType ?? ''}`.toLowerCase().includes(needle)) : all;

  const take = async (file: File | undefined) => {
    if (!file || !upload) return;
    setBusy(true); setErr(null);
    try { const d = await upload(file); setAdded((cur) => [d, ...cur]); onChange(d.id); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'The upload failed.'); }
    finally { setBusy(false); }
  };

  if (chosen) return (
    <div className="fp">
      <style>{CSS}</style>
      <div className="fp-chosen">
        <Check size={16} />
        <span className="n">{chosen.fileName ?? chosen.docType ?? 'File'}</span>
        <a href={chosen.webUrl ?? `/api/v1/documents/${chosen.id}/raw`} target="_blank" rel="noreferrer">Open</a>
        <button type="button" aria-label="Choose a different file" onClick={() => onChange('')}><X size={16} /></button>
      </div>
    </div>
  );

  return (
    <div className="fp">
      <style>{CSS}</style>
      {upload && (
        <div
          className={`fp-drop${over ? ' over' : ''}`} role="button" tabIndex={0} aria-busy={busy}
          onClick={() => !busy && input.current?.click()}
          onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !busy) { e.preventDefault(); input.current?.click(); } }}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void take(e.dataTransfer.files?.[0]); }}
        >
          {busy ? <><Loader size={16} className="bb-spin" />Uploading…</> : <><Upload size={16} />Drop A File Or Upload</>}
          <input ref={input} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void take(f); }} />
        </div>
      )}
      {err && <div className="fp-err">{err}</div>}
      {docs === null ? <div className="fp-none">Loading…</div> : all.length > 0 && (
        <>
          {all.length > shown && <label className="fp-find"><Search size={16} /><input className="ep-input" placeholder="Search the case files" value={q} onChange={(e) => setQ(e.target.value)} /></label>}
          <div className="fp-list">
            {matches.slice(0, shown).map((d) => (
              <button key={d.id} type="button" className="fp-item" onClick={() => onChange(d.id)}>
                <FileText size={16} /><span className="n">{d.fileName ?? d.docType ?? 'File'}</span><span className="d">{fmtDay(d.createdAt)}</span>
              </button>
            ))}
            {!matches.length && <div className="fp-none">Nothing Matches</div>}
          </div>
        </>
      )}
    </div>
  );
}
