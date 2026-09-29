'use client';
/**
 * Doc Packs: the firm's documents, laid out like Email Templates. Tabs by the stage that makes
 * each one, a list on the left, and the chosen document on the right as it reads filled in
 * (example details; Preview fills it from a real case). Generate, Download, Replace sit at the
 * top right. Opened from a flowchart marker (?doc=<name>), that document is selected.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { BusyButton, Spin } from '@/app/shared/engine/BusyButton';
import { CaseSearch, type CaseHit } from '@/app/shared/engine/CaseSearch';
import { Search, Sparkles, Upload } from '@/app/shared/icons';
import { DocGenerate } from './DocGenerate';

interface DocTemplate { id: string; name: string; description: string | null; file_name: string; file_size_bytes: number; has_llm_prompts: boolean; usage?: { step: string; to: string } | null }
type Preview = { preview: string; html: string | null; fileName: string; previous: string | null; sample?: boolean };

/** Tabs: the stage of the case that makes the document; the firm's own (not in the flow) last. */
const TABS = ['All', 'Instruction', 'Pre-Exchange', 'Exchange', 'Completion', "Firm's Own"] as const;
type Tab = (typeof TABS)[number];
const tabOf = (t: DocTemplate): Exclude<Tab, 'All'> => {
  if (!t.usage) return "Firm's Own";
  const stage = t.usage.step.split(',')[0].trim();
  if (stage === 'Instruction') return 'Instruction';
  if (stage === 'Contract & Exchange') return 'Exchange';
  if (stage === 'Completion') return 'Completion';
  return 'Pre-Exchange';
};
const titleCase = (s: string) => s.split(' ').map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');

const PLACEHOLDERS: Array<[string, string]> = [
  ['{{matter_ref}}', 'Case reference'], ['{{property_address}}', 'Property address'], ['{{buyer_names}}', 'Buyer names'], ['{{seller_names}}', 'Seller names'],
  ['{{exchange_date}}', 'Target exchange date'], ['{{completion_date}}', 'Target completion date'], ['{{counterparty_solicitor}}', "Other side's solicitor"],
  ['{{counterparty_agent}}', 'Estate agent'], ['{{lender}}', 'Lender'], ['{{track}}', 'Purchase / Sale / Remortgage'], ['{{stage}}', 'Current stage'],
  ['{{today}}', "Today's date"], ['{{firm_name}}', 'Firm name'], ['{{assigned_to}}', 'Conveyancer on the case'],
  ['[[Write a short welcome paragraph]]', 'A section the AI writes from the case'],
];

const CSS = `
.dp-page{background:#fff;border:1px solid #e8eaf0;border-radius:10px;padding:34px 40px;font:13.5px/1.6 Georgia,'Times New Roman',serif;color:#1e293b;box-shadow:0 1px 2px rgba(16,24,40,.04)}
.dp-page h1,.dp-page h2,.dp-page h3{font-family:inherit;color:#0f172a;margin:14px 0 8px}
.dp-page h1{font-size:19px}.dp-page h2{font-size:16px}.dp-page h3{font-size:14.5px}
.dp-page p{margin:0 0 9px}
.dp-page table{border-collapse:collapse;width:100%;margin:8px 0 12px}
.dp-page td,.dp-page th{border:1px solid #e2e8f0;padding:5px 8px;vertical-align:top}
.dp-page ul,.dp-page ol{margin:0 0 9px 20px;padding:0}
.dp-page pre{white-space:pre-wrap;font:inherit;margin:0}
.dp-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:20;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 12px 32px rgba(15,23,42,.14);padding:10px 12px;width:360px}
.dp-menu table{font-size:12px;border-collapse:collapse;width:100%}
.dp-menu td{padding:3px 0;border-top:1px solid #f1f5f9;vertical-align:top}
.dp-menu td:first-child{font-family:ui-monospace,monospace;color:#5A27E0;padding-right:10px;white-space:nowrap}
@media (max-width:900px){.dp-split{flex-direction:column}.dp-list{width:100% !important;max-height:none !important}.dp-page{padding:20px}}
`;

function Page({ p }: { p: Preview | null }) {
  if (!p) return <div className="dp-page" style={{ color: '#94a3b8', fontFamily: 'inherit' }}><Spin>Loading…</Spin></div>;
  return p.html
    ? <div className="dp-page" dangerouslySetInnerHTML={{ __html: p.html }} />
    : <div className="dp-page"><pre>{p.preview || 'Nothing to show.'}</pre></div>;
}

export default function DocPacks() {
  const [docs, setDocs] = useState<DocTemplate[] | null>(null);
  const [tab, setTab] = useState<Tab>('All');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sample, setSample] = useState<Record<string, Preview>>({});
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewCase, setPreviewCase] = useState<CaseHit | null>(null);
  const [live, setLive] = useState<Preview | null>(null);
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const [genFor, setGenFor] = useState<DocTemplate | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [phOpen, setPhOpen] = useState(false);
  const phRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!phOpen) return;
    const close = (e: MouseEvent) => { if (!phRef.current?.contains(e.target as Node)) setPhOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [phOpen]);

  const load = useCallback(async (select?: string) => {
    try {
      const r = await api<{ templates: DocTemplate[] }>('/admin/doc-templates');
      setDocs(r.templates);
      // Opened from the flowchart (?doc=<name>): that document, on All.
      const want = (select ?? (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('doc') : null))?.trim().toLowerCase();
      const hit = want ? r.templates.find((t) => t.name.toLowerCase() === want) ?? r.templates.find((t) => t.name.toLowerCase().startsWith(want)) ?? r.templates.find((t) => t.id === select) : null;
      if (hit) { setSel(hit.id); setTab('All'); }
      else setSel((cur) => cur ?? r.templates[0]?.id ?? null);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not load documents.'); setDocs((d) => d ?? []); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const cur = docs?.find((d) => d.id === sel) ?? null;
  // The chosen document is in view in the list (opened from the flowchart it may be far down).
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (sel) listRef.current?.querySelector(`[data-doc="${sel}"]`)?.scrollIntoView({ block: 'nearest' }); }, [sel, docs]);
  // The chosen document as it reads, filled with example details.
  useEffect(() => {
    if (!cur || sample[cur.id]) return;
    api<Preview>(`/admin/doc-templates/${cur.id}/generate`, { method: 'POST', body: JSON.stringify({ preview: true }) })
      .then((p) => setSample((m) => ({ ...m, [cur.id]: p })))
      .catch((e: Error) => setSample((m) => ({ ...m, [cur.id]: { preview: `Could not show it: ${e.message}`, html: null, fileName: cur.file_name, previous: null } })));
  }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Preview for a real case.
  useEffect(() => {
    setLive(null); setLiveErr(null);
    if (!cur || !previewCase || !previewOpen) return;
    api<Preview>(`/admin/doc-templates/${cur.id}/generate`, { method: 'POST', body: JSON.stringify({ preview: true, matterId: previewCase.id }) })
      .then(setLive).catch((e: Error) => setLiveErr(e.message));
  }, [cur?.id, previewCase?.id, previewOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => { const c: Record<string, number> = { All: docs?.length ?? 0 }; for (const t of docs ?? []) { const k = tabOf(t); c[k] = (c[k] ?? 0) + 1; } return c; }, [docs]);
  const sections = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const m = new Map<string, DocTemplate[]>();
    for (const t of docs ?? []) {
      if (tab !== 'All' && tabOf(t) !== tab) continue;
      const hay = `${t.name} ${t.description ?? ''} ${t.usage?.step ?? ''} ${t.usage?.to ?? ''} ${t.file_name}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      const sec = t.usage ? `To ${titleCase(t.usage.to)}` : 'Not In The Flow';
      m.set(sec, [...(m.get(sec) ?? []), t]);
    }
    return [...m.entries()].sort((a, b) => Number(a[0] === 'Not In The Flow') - Number(b[0] === 'Not In The Flow') || a[0].localeCompare(b[0])).map(([k, l]) => [k, l.sort((a, b) => a.name.localeCompare(b.name))] as const);
  }, [docs, tab, q]);

  const upload = async (form: FormData, url: string, method: string) => {
    const tok = typeof window !== 'undefined' ? window.localStorage.getItem('cl_token') : null;
    const res = await fetch(`/api/v1${url}`, { method, credentials: 'include', headers: tok ? { Authorization: `Bearer ${tok}` } : {}, body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  };
  const replace = async (t: DocTemplate, file: File) => {
    setErr(null);
    try {
      const f = new FormData(); f.append('file', file);
      await upload(f, `/admin/doc-templates/${t.id}`, 'PUT');
      setSample((m) => { const n = { ...m }; delete n[t.id]; return n; });
      await load();
      return true;
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not replace it.'); return false; }
  };
  const remove = async (t: DocTemplate) => {
    if (!window.confirm(`Delete "${t.name}"?`)) return;
    try { await api(`/admin/doc-templates/${t.id}`, { method: 'DELETE' }); setSel(null); await load(); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not delete it.'); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <style>{CSS}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 36, marginBottom: 2 }}>
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: 0, lineHeight: 1.2, color: '#0f172a' }}>Doc Packs</h1>
        <span style={{ flex: 1 }} />
        <button onClick={() => setNewOpen(true)} style={{ ...btn, height: 34, padding: '0 14px', fontSize: 13, fontWeight: 700, background: '#5A27E0', color: '#fff', border: 'none', borderRadius: 9 }}>New Document</button>
      </div>
      {err && <div style={{ ...card, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca' }}>{err}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderBottom: '1px solid #e8eaf0' }}>
        <div role="tablist" style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {TABS.map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} style={{ border: 'none', background: 'none', padding: '8px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', color: tab === k ? '#5A27E0' : '#64748b', borderBottom: `2px solid ${tab === k ? '#5A27E0' : 'transparent'}`, marginBottom: -1, fontFamily: 'inherit' }}>
              {k}{docs ? <span style={{ marginLeft: 6, fontWeight: 600, color: '#94a3b8' }}>{counts[k] ?? 0}</span> : null}
            </button>
          ))}
        </div>
        <div style={{ position: 'relative', marginLeft: 'auto', width: 260, maxWidth: '100%', marginBottom: 6 }}>
          <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', display: 'flex' }}><Search size={16} /></span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search documents" aria-label="Search documents" style={{ ...input, paddingLeft: 32 }} />
        </div>
      </div>

      <div className="dp-split" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div ref={listRef} className="dp-list" style={{ ...card, width: 260, flex: 'none', padding: 8, maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' }}>
          {docs === null && <div style={{ fontSize: 12.5, color: '#94a3b8', padding: 8 }}><Spin>Loading…</Spin></div>}
          {docs !== null && sections.length === 0 && <div style={{ fontSize: 12.5, color: '#94a3b8', padding: 8 }}>{docs.length ? 'No documents match.' : 'No documents yet.'}</div>}
          {sections.map(([sec, list]) => (
            <div key={sec} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.05em', padding: '8px 9px 4px' }}>{sec} <span style={{ fontWeight: 600 }}>{list.length}</span></div>
              {list.map((t) => (
                <button key={t.id} data-doc={t.id} onClick={() => setSel(t.id)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 9px', border: 'none', borderRadius: 8, background: sel === t.id ? '#F2EEFC' : 'transparent', cursor: 'pointer', marginBottom: 2, fontFamily: 'inherit' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{t.name}</div>
                  <div style={{ fontSize: 10.5, color: '#94a3b8' }}>{t.usage ? t.usage.step.split(',')[0] : 'Firm’s own'}</div>
                </button>
              ))}
            </div>
          ))}
        </div>

        {cur ? (
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 'calc(100vh - 240px)', overflowY: 'auto', paddingRight: 4 }}>
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 14, flex: 1, minWidth: 180 }}>{cur.name}{cur.has_llm_prompts && <span style={{ marginLeft: 8, fontSize: 11, background: '#ede9fe', color: '#6d28d9', borderRadius: 999, padding: '2px 8px', fontWeight: 700, verticalAlign: 1 }}>AI Sections</span>}</strong>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap' }}>
                  <span ref={phRef} style={{ position: 'relative' }}>
                    <button type="button" onClick={() => setPhOpen((o) => !o)} style={btn}>Placeholders</button>
                    {phOpen && (
                      <div className="dp-menu">
                        <table><tbody>{PLACEHOLDERS.map(([k, d]) => <tr key={k}><td>{k}</td><td style={{ color: '#475569' }}>{d}</td></tr>)}</tbody></table>
                      </div>
                    )}
                  </span>
                  <button type="button" onClick={() => setPreviewOpen(true)} style={btn}>Preview</button>
                  <a href={`/api/v1/admin/doc-templates/${cur.id}`} download={cur.file_name} style={{ ...btn, textDecoration: 'none' }}>Download</a>
                  <UploadLabel label="Replace" onFile={(f) => replace(cur, f)} />
                  <button type="button" onClick={() => setGenFor(cur)} style={{ ...btn, background: '#5A27E0', color: '#fff', border: 'none' }}>Generate</button>
                  {!cur.usage && <button type="button" onClick={() => void remove(cur)} style={{ ...btn, color: '#b91c1c', borderColor: '#fecaca' }}>Delete</button>}
                </div>
              </div>
              <div style={{ fontSize: 12.5, color: '#475569', marginTop: 8, display: 'flex', gap: '4px 14px', flexWrap: 'wrap', alignItems: 'center' }}>
                {cur.usage && <span><b style={metaK}>Created</b>{cur.usage.step}</span>}
                {cur.usage && <span><b style={metaK}>Sent To</b>{titleCase(cur.usage.to)}</span>}
                <span><b style={metaK}>File</b>{cur.file_name} · {(cur.file_size_bytes / 1024).toFixed(0)} KB</span>
              </div>
              {cur.description && <div style={{ fontSize: 12.5, color: '#475569', marginTop: 4 }}>{cur.description}</div>}
            </div>
            <Page p={sample[cur.id] ?? null} />
          </div>
        ) : (
          <div style={{ ...card, flex: 1, color: '#94a3b8', fontSize: 13 }}>{docs === null ? <Spin>Loading…</Spin> : 'Pick a document, or add a new one.'}</div>
        )}
      </div>

      {previewOpen && cur && (
        <div role="dialog" aria-label="Preview" onMouseDown={(e) => { if (e.target === e.currentTarget) setPreviewOpen(false); }} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.38)', zIndex: 60, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '60px 16px 16px' }}>
          <div style={{ ...card, width: '100%', maxWidth: 820, maxHeight: 'calc(100vh - 90px)', overflowY: 'auto', boxShadow: '0 24px 64px rgba(15,23,42,.24)', background: '#f8fafc' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <strong style={{ fontSize: 14 }}>Preview</strong>
              <div style={{ flex: 1, maxWidth: 380, marginLeft: 'auto' }}><CaseSearch api={api} value={previewCase} onChange={setPreviewCase} placeholder="Preview for a case" /></div>
              <button type="button" onClick={() => setPreviewOpen(false)} style={btn}>Close</button>
            </div>
            {liveErr && <div style={{ fontSize: 12.5, color: '#b91c1c', marginBottom: 8 }}>{liveErr}</div>}
            <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>{previewCase ? (live ? `${live.fileName}${live.previous ? ` · produced for this case ${live.previous.slice(0, 10)}` : ''}` : '') : 'Example details'}</div>
            <Page p={previewCase ? (liveErr ? { preview: '', html: null, fileName: '', previous: null } : live) : sample[cur.id] ?? null} />
          </div>
        </div>
      )}

      {genFor && <DocGenerate templateId={genFor.id} templateName={genFor.name} sendTo={genFor.usage?.to ?? null} onClose={() => setGenFor(null)} />}
      {newOpen && <NewDocument upload={upload} onClose={() => setNewOpen(false)} onMade={(id) => { setNewOpen(false); setTab('All'); void load(id); }} />}
    </div>
  );
}

function UploadLabel({ label, onFile }: { label: string; onFile: (f: File) => Promise<boolean> }) {
  const [phase, setPhase] = useState<'idle' | 'busy' | 'ok'>('idle');
  return (
    <label style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: 5, ...(phase === 'ok' ? { background: '#16a34a', color: '#fff', borderColor: '#16a34a' } : {}) }} title="Upload your own .docx for this document; its place in the flow stays the same">
      {phase === 'busy' ? <Spin>Uploading…</Spin> : phase === 'ok' ? 'Replaced' : <><Upload size={16} />{label}</>}
      <input type="file" accept=".docx" style={{ display: 'none' }} disabled={phase !== 'idle'} onChange={(e) => {
        const f = e.target.files?.[0]; e.target.value = '';
        if (!f) return;
        setPhase('busy');
        void onFile(f).then((ok) => { setPhase(ok ? 'ok' : 'idle'); if (ok) setTimeout(() => setPhase('idle'), 2000); });
      }} />
    </label>
  );
}

/** A new document: the firm's own .docx, or one written by the AI from a description or an existing document. */
function NewDocument({ upload, onClose, onMade }: { upload: (f: FormData, url: string, method: string) => Promise<{ id?: string; name?: string; template?: { id: string } }>; onClose: () => void; onMade: (idOrName: string) => void }) {
  const [mode, setMode] = useState<'upload' | 'ai'>('upload');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setErr(null);
    if (!name.trim()) { setErr('Give it a name.'); return false; }
    try {
      const f = new FormData();
      f.append('name', name.trim());
      if (mode === 'upload') {
        if (!file) { setErr('Choose a .docx file.'); return false; }
        f.append('file', file); f.append('description', desc.trim());
        const r = await upload(f, '/admin/doc-templates', 'POST');
        onMade(r.template?.id ?? r.id ?? name.trim());
      } else {
        if (!file && desc.trim().length < 10) { setErr('Describe the document, or add one to turn into a template.'); return false; }
        f.append('instructions', desc.trim());
        if (file) f.append('file', file);
        const r = await upload(f, '/admin/doc-templates/generate', 'POST');
        onMade(r.name ?? name.trim());
      }
      return true;
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not add it.'); return false; }
  };
  return (
    <div role="dialog" aria-label="New Document" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.38)', zIndex: 60, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '80px 16px 16px' }}>
      <div style={{ ...card, width: '100%', maxWidth: 520, boxShadow: '0 24px 64px rgba(15,23,42,.24)', padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
          <strong style={{ fontSize: 14, marginRight: 'auto' }}>New Document</strong>
          <button type="button" onClick={() => setMode('upload')} style={{ ...btn, ...(mode === 'upload' ? { borderColor: '#5A27E0', color: '#5A27E0', background: '#F2EEFC' } : {}), display: 'inline-flex', alignItems: 'center', gap: 5 }}><Upload size={16} />Upload</button>
          <button type="button" onClick={() => setMode('ai')} style={{ ...btn, ...(mode === 'ai' ? { borderColor: '#5A27E0', color: '#5A27E0', background: '#F2EEFC' } : {}), display: 'inline-flex', alignItems: 'center', gap: 5 }}><Sparkles size={16} />Create With AI</button>
        </div>
        <label style={lbl}>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Notice to complete" style={input} autoFocus />
        <label style={lbl}>{mode === 'upload' ? 'File (.docx)' : 'Existing Document (Optional)'}</label>
        <input type="file" accept={mode === 'upload' ? '.docx' : '.docx,.txt'} onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ ...input, padding: '6px 8px' }} />
        <label style={lbl}>{mode === 'upload' ? 'Description (Optional)' : 'Describe It'}</label>
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={mode === 'ai' ? 4 : 2} maxLength={4000} placeholder={mode === 'ai' ? "e.g. A formal notice to complete to the other side's solicitor, giving 10 working days." : ''} style={{ ...input, fontFamily: 'inherit', resize: 'vertical' }} />
        {err && <div style={{ fontSize: 12.5, color: '#b91c1c', marginTop: 8 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" onClick={onClose} style={btn}>Cancel</button>
          <BusyButton className="" style={{ ...btn, background: '#5A27E0', color: '#fff', border: 'none' }} busyLabel={mode === 'ai' ? 'Writing…' : 'Uploading…'} doneLabel="Added" onClick={go}>{mode === 'ai' ? 'Create' : 'Upload'}</BusyButton>
        </div>
      </div>
    </div>
  );
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e8eaf0', borderRadius: 12, padding: 12 };
const btn: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, padding: '6px 12px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#334155', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' };
const lbl: React.CSSProperties = { display: 'block', fontSize: 10.5, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.3, margin: '10px 0 3px' };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', fontSize: 12.5, padding: '7px 9px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#0f172a' };
const metaK: React.CSSProperties = { color: '#94a3b8', fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase', marginRight: 6 };
