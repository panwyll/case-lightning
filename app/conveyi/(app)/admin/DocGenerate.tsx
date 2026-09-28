'use client';
/**
 * Generate one of the firm's documents for a case, from Doc Packs. Only cases that have reached
 * the document's step can be picked; the result is shown so it can be checked, then opened on the
 * case, downloaded, or turned into a task to send.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { X } from '@/app/shared/icons';

interface CaseChoice { matterId: string; matterRef: string | null; propertyAddress: string | null; ready: boolean; reason: string | null; previous?: string | null }
interface Generated { matterId: string; name: string; documentId: string; fileName: string; preview: string; webUrl: string | null; decisionEventId: string | null; capped: boolean }

const CSS = `
.dg-ov{position:fixed;inset:0;background:rgba(15,15,30,.45);display:flex;align-items:center;justify-content:center;z-index:60;padding:16px}
.dg{background:#fff;border-radius:14px;width:min(760px,100%);max-height:88vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(15,23,42,.25)}
.dg-h{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid #eef0f4}
.dg-h b{font-size:15px;margin-right:auto}
.dg-x{border:0;background:none;cursor:pointer;color:#64748b;display:inline-flex;padding:4px}
.dg-b{padding:14px 16px;overflow:auto;flex:1;min-height:0}
.dg-in{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;margin-bottom:10px}
.dg-row{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:1px solid #e6e8ee;background:#fff;border-radius:10px;padding:9px 12px;margin-bottom:6px;font:inherit;cursor:pointer}
.dg-row:hover:not(:disabled){border-color:#c4b5fd;background:#faf8ff}
.dg-row.on{border-color:#5A27E0;box-shadow:0 0 0 2px #ede9fe}
.dg-row:disabled{cursor:default;opacity:.55}
.dg-row .a{flex:1;min-width:0;font-size:13.5px;font-weight:600;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dg-row .r{font-size:12px;color:#94a3b8;white-space:nowrap}
.dg-row .why{font-size:12px;color:#64748b;white-space:nowrap}
.dg-f{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid #eef0f4}
.dg-btn{border:1px solid #5A27E0;background:#fff;color:#5A27E0;border-radius:8px;padding:7px 14px;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;text-decoration:none;white-space:nowrap}
.dg-btn.go{background:#5A27E0;color:#fff}
.dg-btn:disabled{opacity:.55;cursor:default}
.dg-err{color:#b91c1c;font-size:13px;margin-right:auto}
.dg-ok{color:#15803d;font-size:13px;font-weight:600;margin-right:auto}
.dg-pre{white-space:pre-wrap;font:13px/1.55 ui-sans-serif,system-ui,sans-serif;color:#1e293b;background:#f8fafc;border:1px solid #e6e8ee;border-radius:10px;padding:14px;margin:0}
.dg-meta{font-size:12.5px;color:#475569;margin-bottom:8px}
.dg-row .sent{font-size:11px;font-weight:700;color:#15803d;background:#dcfce7;border-radius:99px;padding:1px 8px;white-space:nowrap}
.dg-warn{font-size:13px;color:#92400e;margin-right:auto}
`;

export function DocGenerate({ templateId, templateName, sendTo, onClose }: { templateId: string; templateName: string; sendTo: string | null; onClose: () => void }) {
  const [cases, setCases] = useState<CaseChoice[] | null>(null);
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Generated | null>(null);
  const [task, setTask] = useState<'idle' | 'busy' | 'made'>('idle');
  const [preview, setPreview] = useState<{ preview: string; fileName: string; previous: string | null } | null>(null);
  const [confirmAgain, setConfirmAgain] = useState(false);

  useEffect(() => {
    api<{ cases: CaseChoice[] }>(`/admin/doc-templates/${templateId}/cases`).then((r) => setCases(r.cases)).catch((e: unknown) => { setCases([]); setErr(e instanceof Error ? e.message : 'Could not load cases.'); });
  }, [templateId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (cases ?? []).filter((c) => !t || `${c.matterRef ?? ''} ${c.propertyAddress ?? ''}`.toLowerCase().includes(t));
  }, [cases, q]);
  const chosen = cases?.find((c) => c.matterId === pick) ?? null;

  const showPreview = async () => {
    if (!pick) return;
    setBusy(true); setErr(null);
    try { setPreview(await api<{ preview: string; fileName: string; previous: string | null }>(`/admin/doc-templates/${templateId}/generate`, { method: 'POST', body: JSON.stringify({ matterId: pick, preview: true }) })); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not preview it.'); }
    finally { setBusy(false); }
  };
  const generate = async () => {
    if (!pick) return;
    // Produced for this case already: say so, and only go again when they confirm.
    if (chosen?.previous && !confirmAgain) { setConfirmAgain(true); return; }
    setBusy(true); setErr(null);
    try { setDone(await api<Generated>(`/admin/doc-templates/${templateId}/generate`, { method: 'POST', body: JSON.stringify({ matterId: pick, again: !!chosen?.previous }) })); setConfirmAgain(false); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not generate it.'); }
    finally { setBusy(false); }
  };

  const makeTask = async () => {
    if (!done) return;
    setTask('busy'); setErr(null);
    try {
      await api(`/matters/${done.matterId}/engine`, { method: 'POST', body: JSON.stringify({ type: 'raise_issue', kind: 'other', gate: 'none', title: `Send the ${done.name.toLowerCase()} to the ${(sendTo ?? 'client').toLowerCase()}`, detail: `${done.fileName} was generated from Doc Packs and is on the case. [doc:${done.documentId}]`, documentId: done.documentId }) });
      setTask('made');
    } catch (e: unknown) { setTask('idle'); setErr(e instanceof Error ? e.message : 'Could not create the task.'); }
  };

  const caseHref = done ? `/conveyi/matters/${done.matterId}?tab=${done.decisionEventId ? 'tasks' : 'documents'}` : '#';
  return (
    <div className="dg-ov" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <style>{CSS}</style>
      <div className="dg" role="dialog" aria-modal="true" aria-label={`Generate ${templateName}`}>
        <div className="dg-h"><b>Generate {templateName}</b><button type="button" className="dg-x" aria-label="Close" onClick={onClose}><X size={18} /></button></div>
        <div className="dg-b">
          {!done ? (
            <>
              <input className="dg-in" placeholder="Search cases" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
              {cases === null && <div className="dg-meta">Loading…</div>}
              {cases && !shown.length && <div className="dg-meta">No open cases.</div>}
              {shown.map((c) => (
                <button key={c.matterId} type="button" className={`dg-row${pick === c.matterId ? ' on' : ''}`} onClick={() => { setPick(c.matterId); setPreview(null); setConfirmAgain(false); }} title={c.reason ?? undefined}>
                  <span className="a">{c.propertyAddress ?? c.matterRef ?? c.matterId}</span>
                  {c.matterRef && <span className="r">{c.matterRef}</span>}
                  {c.previous && <span className="sent">Sent {new Date(c.previous).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>}
                  {!c.ready && <span className="why">{c.reason}</span>}
                </button>
              ))}
              {preview && (
                <div style={{ marginTop: 12 }}>
                  <div className="dg-meta">{preview.fileName} · preview{preview.previous ? ` · produced ${preview.previous.slice(0, 10)}` : ''}</div>
                  <pre className="dg-pre">{preview.preview || 'Nothing to show.'}</pre>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="dg-meta">{done.fileName}{done.decisionEventId ? ' · waiting for approval in Tasks' : ' · filed on the case'}{done.capped ? ' · AI sections left blank (trial limit)' : ''}</div>
              <pre className="dg-pre">{done.preview || 'Nothing to show.'}</pre>
            </>
          )}
        </div>
        <div className="dg-f">
          {err ? <span className="dg-err">{err}</span> : confirmAgain && chosen?.previous ? <span className="dg-warn">Already produced for this case on {new Date(chosen.previous).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. Produce it again?</span> : task === 'made' ? <span className="dg-ok">Task created on the case.</span> : <span style={{ marginRight: 'auto' }} />}
          {!done ? (
            <>
              <button type="button" className="dg-btn" disabled={!pick || busy} onClick={() => void showPreview()}>{busy && !confirmAgain ? 'Loading…' : 'Preview'}</button>
              {confirmAgain && <button type="button" className="dg-btn" onClick={() => setConfirmAgain(false)}>Cancel</button>}
              <button type="button" className="dg-btn go" disabled={!chosen?.ready || busy} title={chosen && !chosen.ready ? chosen.reason ?? undefined : undefined} onClick={() => void generate()}>{busy ? 'Generating…' : confirmAgain ? 'Yes, Produce Again' : 'Generate'}</button>
            </>
          ) : (
            <>
              <a className="dg-btn" href={`/api/v1/documents/${done.documentId}/raw`} target="_blank" rel="noopener noreferrer">Download</a>
              {done.webUrl && <a className="dg-btn" href={done.webUrl} target="_blank" rel="noopener noreferrer">Open In Word</a>}
              {!done.decisionEventId && <button type="button" className="dg-btn" disabled={task !== 'idle'} onClick={() => void makeTask()}>{task === 'made' ? 'Task Created' : task === 'busy' ? 'Creating…' : `Create Task To Send`}</button>}
              <a className="dg-btn go" href={caseHref}>{done.decisionEventId ? 'Review In Tasks' : 'Open Case'}</a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
