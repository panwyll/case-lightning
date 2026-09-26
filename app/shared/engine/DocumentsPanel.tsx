'use client';
import { useEffect, useMemo, useState } from 'react';
import { WORK_CSS } from './WorkPanel';
import { fmtWhen, pretty, type Api, type DocumentReviewSummary, type EngineEvent, type EngineView } from './types';

/**
 * Documents: file something into the engine (it is classified, extracted and rule-checked;
 * a flagged result becomes a decision), and the list of what has been filed so far — every
 * event on the log that cites a source document, newest first.
 */
type Role = 'auto' | 'search' | 'enquiry_reply' | 'mortgage_offer' | 'title' | 'id_check' | 'management_pack' | 'survey' | 'specialist_report';

export function DocumentsPanel({ matterId, api, view, events, busy, setBusy, onChanged, doc = null }: { matterId: string; api: Api; view: EngineView; events: EngineEvent[]; busy: boolean; setBusy: (b: boolean) => void; onChanged?: () => void; doc?: string | null }) {
  const [role, setRole] = useState<Role>('auto');
  const [search, setSearch] = useState('CON29');
  const [enquiryId, setEnquiryId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const s = view.state;
  const p = view.profile;
  const buyer = !p || p.side === 'buyer';
  const leasehold = p?.tenure === 'leasehold';
  const filed = useMemo(() => events.filter((e) => e.sourceDocumentId).sort((a, b) => b.seq - a.seq), [events]);
  const [reviews, setReviews] = useState<Record<string, DocumentReviewSummary | null>>({});
  useEffect(() => {
    api<{ documents: Array<{ id: string; review?: DocumentReviewSummary | null }> }>(`/matters/${matterId}/engine/documents`).then((r) => setReviews(Object.fromEntries(r.documents.map((d) => [d.id, d.review ?? null])))).catch(() => {});
  }, [api, matterId, filed.length]);
  const reviewOf = (id: string | null | undefined) => (id ? reviews[id] : null) ?? null;
  const badge = (r: DocumentReviewSummary | null) => {
    if (!r) return null;
    const ok = r.complete && r.unreadable === 0;
    const bg = ok ? '#dcfce7' : r.complete ? '#fef3c7' : '#fee2e2';
    const fg = ok ? '#14532d' : r.complete ? '#78350f' : '#7f1d1d';
    return <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '2px 8px', background: bg, color: fg, whiteSpace: 'nowrap' }} title={`${r.read} of ${r.pages} pages read${r.unreadable ? ` · ${r.unreadable} unreadable` : ''}${r.unattested ? ` · ${r.unattested} not attested` : ''} · ${r.verified} of ${r.facts} facts verified against the page text`}>{r.complete ? 'Read' : 'Partly read'} {r.read}/{r.pages}{r.facts ? ` · ${r.verified}/${r.facts} facts` : ''}</span>;
  };
  useEffect(() => {
    if (!doc) return;
    document.getElementById(`doc-${doc}`)?.scrollIntoView({ block: 'center' });
  }, [doc, filed.length]);

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const buf = await file.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const r = await api<{ action: { kind: string; reason?: string }; classification: { role: string; confidence: number } | null }>(`/matters/${matterId}/engine/upload`, {
        method: 'POST',
        body: JSON.stringify({ fileName: file.name, mimeType: file.type || 'application/pdf', base64: btoa(bin), role, searchType: role === 'search' ? search : undefined, enquiryId: role === 'enquiry_reply' ? enquiryId.trim() : undefined }),
      });
      setMsg(r.action.kind === 'skip' ? `Filed, not routed: ${r.action.reason ?? ''}` : `Filed as ${r.action.kind.replace('_', ' ')}${r.classification ? ` (classifier ${Math.round(r.classification.confidence * 100)}% sure)` : ''} — the engine has extracted and rule-checked it.`);
      setFile(null);
      onChanged?.();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ep">
      <style>{WORK_CSS}</style>
      <div className="ep-sec">File a document into the engine</div>
      <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="file" accept="application/pdf,image/*,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ fontSize: 12.5 }} />
          <select className="ep-input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="auto">Let the engine classify it</option>
            <option value="title">Official copy of the register</option>
            <option value="id_check">ID / AML report</option>
            {(buyer || p?.type === 'remortgage') && <option value="search">Search result</option>}
            {buyer && <option value="enquiry_reply">Reply to our enquiries</option>}
            {(buyer || p?.type === 'remortgage') && <option value="mortgage_offer">Mortgage offer</option>}
            {leasehold && <option value="management_pack">Management pack (LPE1)</option>}
            {buyer && <option value="survey">Survey / valuation report</option>}
            {buyer && <option value="specialist_report">Specialist report (damp, timber, structural…)</option>}
          </select>
          {role === 'search' && <select className="ep-input" value={search} onChange={(e) => setSearch(e.target.value)}>{['LLC1', 'CON29', 'DRAINAGE_WATER', 'ENVIRONMENTAL', 'CHANCEL'].map((t) => <option key={t} value={t}>{t}</option>)}</select>}
          {role === 'enquiry_reply' && <input className="ep-input" placeholder="Enquiry id (E1)" value={enquiryId} onChange={(e) => setEnquiryId(e.target.value)} style={{ width: 120 }} />}
          <button className="ep-btn primary" style={{ margin: 0 }} disabled={busy || !file || (role === 'enquiry_reply' && !enquiryId.trim())} onClick={upload}>File into engine</button>
        </div>
        {msg && <div style={{ fontSize: 12.5, color: '#14532d', marginTop: 6 }}>{msg}</div>}
        {err && <div className="ep-err">{err}</div>}
      </div>

      <div className="ep-sec">Filed on this case ({filed.length})</div>
      <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
        {filed.length === 0 && <div className="ep-note">Nothing has been filed into the engine yet{s.enrolled ? '' : ' — enrol the case first'}.</div>}
        {filed.map((e) => (
          <div key={e.id} id={`doc-${e.sourceDocumentId}`} className="ep-row" style={doc && e.sourceDocumentId === doc ? { background: '#faf8ff', boxShadow: 'inset 3px 0 0 #5A27E0', paddingLeft: 8, borderRadius: 6 } : undefined}>
            <span className="ep-note" style={{ minWidth: 120 }}>#{e.seq} {fmtWhen(e.createdAt)}</span>
            <b>{pretty(e.type)}</b>
            <span className="ep-note">{typeof e.payload.searchType === 'string' ? e.payload.searchType : ''}{typeof e.payload.enquiryId === 'string' ? e.payload.enquiryId : ''}{e.confidenceScore != null ? ` · confidence ${Math.round(e.confidenceScore * 100)}%` : ''}</span>
            {badge(reviewOf(e.sourceDocumentId))}
          </div>
        ))}
      </div>
    </div>
  );
}
