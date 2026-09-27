'use client';
import { useEffect, useMemo, useState } from 'react';
import { WORK_CSS } from './WorkPanel';
import { fmtWhen, pretty, type Api, type DocumentReviewSummary, type DraftCheckView, type EngineEvent, type EngineView } from './types';
import { CheckedDraft } from './CheckedDraft';

type RegisterDiffView = { previousAt: string; added: Array<{ key: string; value: string }>; removed: Array<{ key: string; value: string }>; changed: Array<{ key: string; from: string; to: string }> };

/**
 * Documents: file something into the engine (it is classified, extracted and rule-checked;
 * a flagged result becomes a decision), and the list of what has been filed so far — every
 * event on the log that cites a source document, newest first.
 */
type Role = 'auto' | 'search' | 'enquiry_reply' | 'mortgage_offer' | 'title' | 'id_check' | 'management_pack' | 'lease' | 'survey' | 'specialist_report' | 'property_forms';

export function DocumentsPanel({ matterId, api, view, events, busy, setBusy, onChanged, doc = null }: { matterId: string; api: Api; view: EngineView; events: EngineEvent[]; busy: boolean; setBusy: (b: boolean) => void; onChanged?: () => void; doc?: string | null }) {
  const [role, setRole] = useState<Role>('auto');
  const [search, setSearch] = useState('CON29');
  const [enquiryId, setEnquiryId] = useState('');
  const [idParty, setIdParty] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const s = view.state;
  const p = view.profile;
  const buyer = !p || p.side === 'buyer';
  const leasehold = p?.tenure === 'leasehold';
  const filed = useMemo(() => events.filter((e) => e.sourceDocumentId).sort((a, b) => b.seq - a.seq), [events]);
  const [reviews, setReviews] = useState<Record<string, DocumentReviewSummary | null>>({});
  const [checks, setChecks] = useState<Array<{ check: string; label: string; status: string; message: string; values: Array<{ source: string; value: string; page: number | null }> }>>([]);
  const [openReview, setOpenReview] = useState<string | null>(null);
  const [table, setTable] = useState<{ id: string; pages: Array<{ page: number; verdict: string; ocr_confidence?: number | null }>; facts: Array<{ id: string; key: string; value: string; page: number | null; quote: string | null; verified: boolean; note: string | null; confirmedAt: string | null; confirmedBy: string | null; disputedNote: string | null }>; diff?: RegisterDiffView | null; draftCheck?: DraftCheckView | null } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Array<{ id: string; fileName: string | null; docType: string | null; createdAt: string }>>([]);
  const [outbox, setOutbox] = useState<Array<{ id: string; fileName: string | null; createdAt: string }>>([]);
  const [openMail, setOpenMail] = useState<string | null>(null);
  const [mailBody, setMailBody] = useState<Record<string, string>>({});
  const readMail = async (id: string) => {
    setOpenMail((cur) => (cur === id ? null : id));
    if (mailBody[id]) return;
    const text = await fetch(`/api/v1/documents/${id}/raw`).then((r) => r.text()).catch(() => 'Could not read this email.');
    setMailBody((cur) => ({ ...cur, [id]: text }));
  };
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<{ q: string; facts: Array<{ id: string; documentId: string; fileName: string | null; key: string; value: string; page: number | null; quote: string | null; verified: boolean }>; passages: Array<{ documentId: string; fileName: string | null; page: number; text: string }> } | null>(null);
  const ask = async () => {
    const q = question.trim();
    if (!q) return;
    setAsking(true);
    try { const r = await api<NonNullable<typeof answer>>(`/matters/${matterId}/engine/documents/ask?q=${encodeURIComponent(q)}`); setAnswer({ ...r, q }); } catch { setAnswer({ q, facts: [], passages: [] }); } finally { setAsking(false); }
  };
  const loadTable = async (id: string) => {
    setOpenReview(id);
    const r = await api<{ pages: Array<{ page: number; verdict: string }>; facts: typeof table extends infer T ? (T extends { facts: infer F } ? F : never) : never; diff?: RegisterDiffView | null; draftCheck?: DraftCheckView | null }>(`/documents/${id}/review`).catch(() => null);
    setTable(r ? { id, pages: r.pages, facts: r.facts as never, diff: r.diff ?? null, draftCheck: r.draftCheck ?? null } : null);
  };
  const mark = async (factId: string, action: 'confirm' | 'dispute' | 'clear') => {
    if (!table) return;
    const note = action === 'dispute' ? window.prompt('What is wrong with this fact?') : null;
    if (action === 'dispute' && !note) return;
    await api(`/documents/${table.id}/review`, { method: 'POST', body: JSON.stringify({ factId, action, note }) }).catch(() => {});
    await loadTable(table.id);
  };
  useEffect(() => {
    api<{ documents: Array<{ id: string; fileName: string | null; docType: string | null; createdAt: string; review?: DocumentReviewSummary | null; checked?: boolean }>; crosschecks?: typeof checks }>(`/matters/${matterId}/engine/documents`).then((r) => { setReviews(Object.fromEntries(r.documents.map((d) => [d.id, d.review ?? null]))); setChecked(new Set(r.documents.filter((d) => d.checked).map((d) => d.id))); setDrafts(r.documents.filter((d) => d.checked && !events.some((e) => e.sourceDocumentId === d.id)).map((d) => ({ id: d.id, fileName: d.fileName, docType: d.docType, createdAt: d.createdAt }))); setOutbox(r.documents.filter((d) => d.docType === 'SANDBOX_EMAIL').map((d) => ({ id: d.id, fileName: d.fileName, createdAt: d.createdAt }))); setChecks(r.crosschecks ?? []); }).catch(() => {});
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
        body: JSON.stringify({ fileName: file.name, mimeType: file.type || 'application/pdf', base64: btoa(bin), role, party: role === 'id_check' ? idParty || undefined : undefined, searchType: role === 'search' ? search : undefined, enquiryId: role === 'enquiry_reply' ? enquiryId.trim() : undefined }),
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
      <div className="ep-sec">File a Document</div>
      <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="file" accept="application/pdf,image/*,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ fontSize: 12.5 }} />
          <select className="ep-input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="auto">Classify it automatically</option>
            <option value="title">Official copy of the register</option>
            <option value="id_check">ID / AML report</option>
            {(buyer || p?.type === 'remortgage') && <option value="search">Search result</option>}
            {buyer && <option value="enquiry_reply">Reply to our enquiries</option>}
            {(buyer || p?.type === 'remortgage') && <option value="mortgage_offer">Mortgage offer</option>}
            {leasehold && <option value="lease">Lease</option>}
            {leasehold && <option value="management_pack">Management pack (LPE1)</option>}
            {buyer && <option value="property_forms">Seller's property forms (TA6 / TA7 / TA10)</option>}
            {buyer && <option value="survey">Survey / valuation report</option>}
            {buyer && <option value="specialist_report">Specialist report (damp, timber, structural…)</option>}
          </select>
          {role === 'search' && <select className="ep-input" value={search} onChange={(e) => setSearch(e.target.value)}>{['LLC1', 'CON29', 'DRAINAGE_WATER', 'ENVIRONMENTAL', 'CHANCEL', 'MINING', 'FLOOD', 'HIGHWAYS', 'PLANNING'].map((t) => <option key={t} value={t}>{t}</option>)}</select>}
          {role === 'id_check' && Object.keys(s.partyChecks ?? {}).length > 0 && <select className="ep-input" value={idParty} onChange={(e) => setIdParty(e.target.value)} aria-label="Whose result"><option value="">First client</option>{Object.values(s.partyChecks ?? {}).map((pc) => <option key={pc.party} value={pc.party}>{pc.label}</option>)}</select>}
          {role === 'enquiry_reply' && <input className="ep-input" placeholder="Enquiry id (E1)" value={enquiryId} onChange={(e) => setEnquiryId(e.target.value)} style={{ width: 120 }} />}
          <button className="ep-btn primary" style={{ margin: 0 }} disabled={busy || !file || (role === 'enquiry_reply' && !enquiryId.trim())} onClick={upload}>File into engine</button>
        </div>
        {msg && <div style={{ fontSize: 12.5, color: '#14532d', marginTop: 6 }}>{msg}</div>}
        {err && <div className="ep-err">{err}</div>}
      </div>

      {filed.length > 0 && (
        <>
          <div className="ep-sec">Ask The File</div>
          <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input className="ep-input" style={{ flex: 1 }} placeholder="Where does the lease say who repairs the roof?" value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void ask(); }} />
              <button className="ep-btn primary" style={{ margin: 0 }} disabled={asking || !question.trim()} onClick={() => void ask()}>Ask</button>
            </div>
            {answer && (
              <div style={{ marginTop: 8, fontSize: 12.5 }}>
                {answer.facts.length === 0 && answer.passages.length === 0 && <div className="ep-note">Nothing on the file answers “{answer.q}”.</div>}
                {answer.facts.map((f) => (
                  <div key={f.id} className="ep-row" style={{ alignItems: 'flex-start' }}>
                    <span className="ep-pill" style={{ background: '#f3efff', color: '#5A27E0', minWidth: 44, textAlign: 'center' }}>Fact</span>
                    <b style={{ minWidth: 160 }}>{f.key.replace(/^[a-z_]+\./, '').replace(/[._]/g, ' ')}</b>
                    <span style={{ flex: 1 }}>{f.value}{f.quote ? <i style={{ color: '#64748b' }}> — “{f.quote.slice(0, 140)}{f.quote.length > 140 ? '…' : ''}”</i> : null}</span>
                    <a href={`/api/v1/documents/${f.documentId}/raw#page=${f.page ?? 1}`} target="_blank" rel="noopener noreferrer" style={{ whiteSpace: 'nowrap' }}>{f.fileName ?? 'Document'}{f.page ? ` p.${f.page}` : ''}</a>
                  </div>
                ))}
                {answer.passages.map((p, i) => (
                  <div key={i} className="ep-row" style={{ alignItems: 'flex-start' }}>
                    <span className="ep-pill" style={{ background: '#f1f5f9', color: '#334155', minWidth: 44, textAlign: 'center' }}>Page</span>
                    <span style={{ flex: 1, color: '#334155' }}>{p.text}</span>
                    <a href={`/api/v1/documents/${p.documentId}/raw#page=${p.page}`} target="_blank" rel="noopener noreferrer" style={{ whiteSpace: 'nowrap' }}>{p.fileName ?? 'Document'} p.{p.page}</a>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      {checks.length > 0 && (
        <>
          <div className="ep-sec">Cross-Checks</div>
          <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
            {checks.map((c) => (
              <div key={c.check} className="ep-row" style={{ alignItems: 'flex-start' }}>
                <span className="ep-pill" style={{ marginTop: 2, background: c.status === 'match' ? '#dcfce7' : '#fee2e2', color: c.status === 'match' ? '#14532d' : '#7f1d1d', minWidth: 64, textAlign: 'center' }}>{c.status === 'match' ? 'Agree' : 'Differ'}</span>
                <b style={{ minWidth: 130 }}>{c.label}</b>
                <span style={{ flex: 1, minWidth: 200 }}>{c.status === 'match' ? `${c.values.length} sources` : c.values.map((v) => `${v.source}${v.page ? ` p.${v.page}` : ''}: ${v.value}`).join(' · ')}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {outbox.length > 0 && (
        <>
          <div className="ep-sec">Outbox ({outbox.length})</div>
          <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
            {outbox.map((m) => (
              <div key={m.id}>
                <div className="ep-row" style={{ cursor: 'pointer' }} onClick={() => void readMail(m.id)}>
                  <span className="ep-note" style={{ minWidth: 120 }}>{fmtWhen(m.createdAt)}</span>
                  <b>{(m.fileName ?? '').replace(/^outbox-/, '').replace(/-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.txt$/, '').replace(/_/g, ' ') || 'email'}</b>
                  <span className="ep-pill" style={{ background: '#fef3c7', color: '#78350f' }}>Rendered, Not Sent</span>
                </div>
                {openMail === m.id && <pre style={{ margin: '4px 0 10px', padding: '10px 12px', border: '1px solid #e6e8ee', borderRadius: 10, whiteSpace: 'pre-wrap', fontSize: 12.5, fontFamily: 'inherit', background: '#fafafa' }}>{mailBody[m.id] ?? 'Reading…'}</pre>}
              </div>
            ))}
          </div>
        </>
      )}
      {drafts.length > 0 && (
        <>
          <div className="ep-sec">Drafts ({drafts.length})</div>
          <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
            {drafts.map((d) => (
              <div key={d.id}>
                <div className="ep-row" style={{ cursor: 'pointer' }} onClick={() => { if (openReview === d.id) { setOpenReview(null); setTable(null); } else void loadTable(d.id); }}>
                  <span className="ep-note" style={{ minWidth: 120 }}>{fmtWhen(d.createdAt)}</span>
                  <b>{pretty((d.docType ?? 'draft').toLowerCase())}</b>
                  <span className="ep-note">{d.fileName}</span>
                  <span className="ep-pill" style={{ background: '#f3efff', color: '#5A27E0' }}>Checked Against The File</span>
                </div>
                {openReview === d.id && table && table.id === d.id && table.draftCheck && <div style={{ margin: '4px 0 10px', border: '1px solid #e6e8ee', borderRadius: 10, padding: '10px 12px' }}><CheckedDraft check={table.draftCheck} /></div>}
              </div>
            ))}
          </div>
        </>
      )}
      <div className="ep-sec">Filed on this case ({filed.length})</div>
      <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
        {filed.length === 0 && <div className="ep-note">Nothing has been filed yet{s.enrolled ? '' : ' — enrol the case first'}.</div>}
        {filed.map((e, i) => (
          <div key={e.id}>
          <div id={`doc-${e.sourceDocumentId}`} className="ep-row" style={{ cursor: reviewOf(e.sourceDocumentId) || checked.has(e.sourceDocumentId ?? '') ? 'pointer' : undefined, ...(doc && e.sourceDocumentId === doc ? { background: '#faf8ff', boxShadow: 'inset 3px 0 0 #5A27E0', paddingLeft: 8, borderRadius: 6 } : {}) }} onClick={() => { if (!reviewOf(e.sourceDocumentId) && !checked.has(e.sourceDocumentId ?? '')) return; if (openReview === e.sourceDocumentId) { setOpenReview(null); setTable(null); } else void loadTable(e.sourceDocumentId!); }}>
            <span className="ep-note" style={{ minWidth: 120 }}>#{e.seq} {fmtWhen(e.createdAt)}</span>
            <b>{pretty(e.type)}</b>
            <span className="ep-note">{typeof e.payload.searchType === 'string' ? e.payload.searchType : ''}{typeof e.payload.enquiryId === 'string' ? e.payload.enquiryId : ''}{e.confidenceScore != null ? ` · confidence ${Math.round(e.confidenceScore * 100)}%` : ''}</span>
            {filed.findIndex((x) => x.sourceDocumentId === e.sourceDocumentId) === i && badge(reviewOf(e.sourceDocumentId))}
            {e.sourceDocumentId && checked.has(e.sourceDocumentId) && <span className="ep-pill" style={{ background: '#f3efff', color: '#5A27E0' }}>Checked Against The File</span>}
          </div>
          {openReview === e.sourceDocumentId && table && table.id === e.sourceDocumentId && (
            <div style={{ margin: '4px 0 10px', border: '1px solid #e6e8ee', borderRadius: 10, overflow: 'hidden' }}>
              {table.draftCheck && <div style={{ padding: '10px 12px', borderBottom: table.pages.length ? '1px solid #eef1f5' : undefined }}><CheckedDraft check={table.draftCheck} /></div>}
              {table.diff && (table.diff.added.length + table.diff.removed.length + table.diff.changed.length > 0) && (
                <div style={{ padding: '6px 10px', background: '#fffbeb', borderBottom: '1px solid #fde68a', fontSize: 12.5, color: '#78350f' }}>
                  <b>Since The Last Read</b> {fmtWhen(table.diff.previousAt)} · {table.diff.changed.map((c) => `${c.key.replace(/^[a-z_]+\./, '')}: ${c.from} → ${c.to}`).concat(table.diff.added.map((a) => `${a.key.replace(/^[a-z_]+\./, '')} added: ${a.value}`), table.diff.removed.map((r) => `${r.key.replace(/^[a-z_]+\./, '')} gone (was ${r.value})`)).join(' · ')}
                </div>
              )}
              {table.pages.length > 0 && <div style={{ display: 'flex', gap: 4, padding: '6px 10px', background: '#f8fafc', borderBottom: '1px solid #eef1f5', flexWrap: 'wrap' }}>
                {table.pages.map((p) => <span key={p.page} title={`Page ${p.page}: ${p.verdict}${p.ocr_confidence != null ? ` · OCR ${p.ocr_confidence}%` : ''}`} style={{ width: 18, height: 18, borderRadius: 4, fontSize: 10, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: p.verdict === 'facts' ? '#dcfce7' : p.verdict === 'nothing' ? '#f1f5f9' : p.verdict === 'unreadable' ? '#fef3c7' : '#fee2e2', color: p.verdict === 'facts' ? '#14532d' : p.verdict === 'nothing' ? '#64748b' : p.verdict === 'unreadable' ? '#78350f' : '#7f1d1d' }}>{p.page}</span>)}
              </div>}
              {table.facts.length > 0 && <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead><tr style={{ textAlign: 'left', color: '#94a3b8', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em' }}><th style={{ padding: '6px 10px' }}>Fact</th><th style={{ padding: '6px 10px' }}>Value</th><th style={{ padding: '6px 10px' }}>Page</th><th style={{ padding: '6px 10px' }}>Quote</th><th style={{ padding: '6px 10px' }}>Checked</th><th style={{ padding: '6px 10px' }} /></tr></thead>
                <tbody>
                  {table.facts.map((f) => (
                    <tr key={f.id} style={{ borderTop: '1px solid #f1f5f9', verticalAlign: 'top' }}>
                      <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', fontWeight: 600 }}>{f.key.replace(/^[a-z_]+\./, '').replace(/[._]/g, ' ')}</td>
                      <td style={{ padding: '6px 10px', maxWidth: 360 }}>{f.value}</td>
                      <td style={{ padding: '6px 10px', color: '#64748b' }}>{f.page ?? ''}</td>
                      <td style={{ padding: '6px 10px', color: '#64748b', fontStyle: 'italic', maxWidth: 320 }}>{f.quote ? `“${f.quote.slice(0, 140)}${f.quote.length > 140 ? '…' : ''}”` : ''}</td>
                      <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                        {f.confirmedAt ? <span style={{ color: '#14532d', fontWeight: 700 }}>Confirmed · {f.confirmedBy}</span> : f.disputedNote ? <span style={{ color: '#b91c1c', fontWeight: 700 }} title={f.disputedNote}>Disputed</span> : f.verified ? <span style={{ color: '#14532d' }}>Quote found</span> : <span style={{ color: '#b45309' }} title={f.note ?? ''}>{f.note ?? 'unchecked'}</span>}
                      </td>
                      <td style={{ padding: '4px 10px', whiteSpace: 'nowrap', textAlign: 'right' }}>
                        {f.confirmedAt || f.disputedNote ? <button className="ep-btn" style={{ margin: 0, padding: '2px 8px', fontSize: 11.5 }} onClick={() => void mark(f.id, 'clear')}>Undo</button> : <><button className="ep-btn" style={{ margin: '0 4px 0 0', padding: '2px 8px', fontSize: 11.5 }} onClick={() => void mark(f.id, 'confirm')}>Confirm</button><button className="ep-btn" style={{ margin: 0, padding: '2px 8px', fontSize: 11.5 }} onClick={() => void mark(f.id, 'dispute')}>Dispute</button></>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>}
            </div>
          )}
          </div>
        ))}
      </div>
    </div>
  );
}
