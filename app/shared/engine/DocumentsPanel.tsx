'use client';
import { Spin } from './BusyButton';
import { uploadCaseFile } from './uploadCaseFile';
import { useEffect, useMemo, useState } from 'react';
import { PasswordInput } from './PasswordInput';
import { ChevronRight } from '@/app/shared/icons';
import { WORK_CSS } from './WorkPanel';
import { Grouped, ListToolbar, useListTools, whenIn, type Filter } from './ListTools';
import { fmtWhen, pretty, type Api, type DocumentReviewSummary, type DraftCheckView, type EngineEvent, type EngineView } from './types';
import { CheckedDraft } from './CheckedDraft';

type RegisterDiffView = { previousAt: string; added: Array<{ key: string; value: string }>; removed: Array<{ key: string; value: string }>; changed: Array<{ key: string; from: string; to: string }> };

/**
 * Documents: file something into the engine (it is classified, extracted and rule-checked;
 * a flagged result becomes a decision), and the list of what has been filed so far — every
 * event on the log that cites a source document, newest first.
 */
type Role = 'auto' | 'search' | 'enquiry_reply' | 'mortgage_offer' | 'title' | 'id_check' | 'management_pack' | 'lease' | 'survey' | 'specialist_report' | 'property_forms';

type DocRow = { doc: { id: string; fileName: string | null; docType: string | null; createdAt: string }; events: EngineEvent[] };
const DOC_FILTERS: Filter<DocRow>[] = [
  { key: 'read', label: 'Read Into the Case', match: (x) => x.events.length > 0 },
  { key: 'unread', label: 'Filed Only', match: (x) => x.events.length === 0 },
  { key: 'signed', label: 'Signed Deeds', match: (x) => x.doc.docType === 'SIGNED_DEED' },
];

/** Log entries that cite a generated text file are not documents to a person; the timeline has them. */
const NOT_PAPER = new Set(['FILE_NOTE', 'EMAIL', 'ESCALATION_DOSSIER', 'DEADLINE_DOSSIER', 'PROPOSAL', 'BANK_DETAILS_NOTE', 'SANDBOX_EMAIL']);

const SECTION_CSS = `.ep-sec-btn{display:flex;align-items:center;gap:6px;width:100%;border:0;background:none;padding:0;cursor:pointer;font:inherit;text-align:left}.ep-sec-btn .chev{display:inline-flex;color:#94a3b8;transition:transform .15s}.ep-sec-btn .n{font-weight:600;color:#94a3b8;margin-left:4px}`;

/** A collapsible section of the Documents tab; each remembers whether it was left open. */
function Section({ id, title, count, defaultOpen = false, children }: { id: string; title: string; count?: number; defaultOpen?: boolean; children: React.ReactNode }) {
  const key = `docs-section:${id}`;
  const [open, setOpen] = useState<boolean>(() => { try { const v = window.localStorage.getItem(key); return v === null ? defaultOpen : v === '1'; } catch { return defaultOpen; } });
  const toggle = () => setOpen((o) => { try { window.localStorage.setItem(key, o ? '0' : '1'); } catch { /* per-viewer convenience only */ } return !o; });
  return (
    <div className="ep-secwrap">
      <button type="button" className="ep-sec ep-sec-btn" onClick={toggle} aria-expanded={open}>
        <span className="chev" style={{ transform: open ? 'rotate(90deg)' : undefined }}><ChevronRight size={16} /></span>{title}{count != null ? <span className="n">{count}</span> : null}
      </button>
      {open && children}
    </div>
  );
}

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
  // Paper only: a note, an email's text, a dossier or a proposal is a log entry, not a document; they live on the timeline.
  const [allDocs, setAllDocs] = useState<Array<{ id: string; fileName: string | null; docType: string | null; createdAt: string; locked?: boolean }>>([]);
  const filed = useMemo(() => {
    const byDoc = new Map<string, EngineEvent[]>();
    for (const e of events) if (e.sourceDocumentId) byDoc.set(e.sourceDocumentId, [...(byDoc.get(e.sourceDocumentId) ?? []), e]);
    return allDocs
      .filter((dd) => !NOT_PAPER.has(dd.docType ?? '') && !dd.locked)
      .map((dd) => ({ doc: dd, events: (byDoc.get(dd.id) ?? []).sort((a, b) => b.seq - a.seq) }))
      .sort((a, b) => (b.doc.createdAt < a.doc.createdAt ? -1 : 1));
  }, [events, allDocs]);
  const [reviews, setReviews] = useState<Record<string, DocumentReviewSummary | null>>({});
  const [checks, setChecks] = useState<Array<{ check: string; label: string; status: string; message: string; values: Array<{ source: string; value: string; page: number | null }> }>>([]);
  const [openReview, setOpenReview] = useState<string | null>(null);
  const [table, setTable] = useState<{ id: string; pages: Array<{ page: number; verdict: string; ocr_confidence?: number | null }>; facts: Array<{ id: string; key: string; value: string; page: number | null; quote: string | null; verified: boolean; note: string | null; confirmedAt: string | null; confirmedBy: string | null; disputedNote: string | null }>; diff?: RegisterDiffView | null; draftCheck?: DraftCheckView | null } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Array<{ id: string; fileName: string | null; docType: string | null; createdAt: string }>>([]);
  // Password-protected files: nothing in them can be read until someone enters the password here (or it arrives in a later message and is tried automatically).
  const [lockedDocs, setLockedDocs] = useState<Array<{ id: string; fileName: string | null; createdAt: string }>>([]);
  const [lockTick, setLockTick] = useState(0);
  const [pw, setPw] = useState<Record<string, string>>({});
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [unlockErr, setUnlockErr] = useState<Record<string, string>>({});
  const [unlockNote, setUnlockNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (!unlockNote) return; const t = setTimeout(() => setUnlockNote(null), 8000); return () => clearTimeout(t); }, [unlockNote]);
  const unlock = async (id: string) => {
    setUnlocking(id);
    setUnlockErr((m) => ({ ...m, [id]: '' }));
    try {
      const r = await api<{ note: string | null; warning: string | null }>(`/documents/${id}/unlock`, { method: 'POST', body: JSON.stringify({ password: pw[id] ?? '' }) });
      setUnlockNote({ ok: !r.warning, text: r.warning ?? r.note ?? 'Unlocked.' });
      setLockTick((t) => t + 1); onChanged?.();
    }
    catch (e: unknown) { setUnlockErr((m) => ({ ...m, [id]: e instanceof Error ? e.message : 'Could not unlock.' })); }
    finally { setUnlocking(null); }
  };
  const [rereading, setRereading] = useState<string | null>(null);
  const [reread, setReread] = useState<Record<string, string>>({});
  const readAgain = async (id: string) => {
    setRereading(id);
    try { await api(`/documents/${id}/read-again`, { method: 'POST', body: '{}' }); setReread((m) => ({ ...m, [id]: 'Reading…' })); for (const ms of [30_000, 90_000]) setTimeout(() => onChanged?.(), ms); }
    catch (e: unknown) { setReread((m) => ({ ...m, [id]: e instanceof Error ? e.message : 'Could not read it again.' })); }
    finally { setRereading(null); }
  };
  const docTools = useListTools(filed, { date: (x) => x.doc.createdAt, text: (x) => `${x.doc.fileName ?? ''} ${x.doc.docType ?? ''} ${x.events.map((e) => e.type).join(' ')}` });
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
  // Ask The File (file-ask.ts): the answer sentence by sentence, each citing its sources; a sentence the check could not support says so.
  const [answer, setAnswer] = useState<{ q: string; answer?: Array<{ text: string; sources: string[]; supported: boolean; why: string | null }> | null; notOnFile?: boolean; sources?: Array<{ id: string; kind: 'fact' | 'passage'; documentId: string; fileName: string | null; page: number | null; label: string; text: string }> } | null>(null);
  const ask = async () => {
    const q = question.trim();
    if (!q) return;
    setAsking(true);
    try { const r = await api<NonNullable<typeof answer>>(`/matters/${matterId}/engine/documents/ask?q=${encodeURIComponent(q)}`); setAnswer({ ...r, q }); } catch { setAnswer({ q, answer: null, notOnFile: true, sources: [] }); } finally { setAsking(false); }
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
    api<{ documents: Array<{ id: string; fileName: string | null; docType: string | null; createdAt: string; review?: DocumentReviewSummary | null; checked?: boolean; locked?: boolean }>; crosschecks?: typeof checks; messages?: Array<{ id: string; at: string; direction: string; channel: string; address: string | null; template: string | null; status: string | null; providerRef: string | null; subject?: string | null }> }>(`/matters/${matterId}/engine/documents`).then((r) => { setAllDocs(r.documents.map((dd) => ({ id: dd.id, fileName: dd.fileName, docType: dd.docType, createdAt: dd.createdAt, locked: dd.locked }))); setLockedDocs(r.documents.filter((d) => d.locked).map((d) => ({ id: d.id, fileName: d.fileName, createdAt: d.createdAt }))); setReviews(Object.fromEntries(r.documents.map((d) => [d.id, d.review ?? null]))); setChecked(new Set(r.documents.filter((d) => d.checked).map((d) => d.id))); setDrafts(r.documents.filter((d) => d.checked && !events.some((e) => e.sourceDocumentId === d.id)).map((d) => ({ id: d.id, fileName: d.fileName, docType: d.docType, createdAt: d.createdAt }))); setOutbox(r.documents.filter((d) => d.docType === 'SANDBOX_EMAIL').map((d) => ({ id: d.id, fileName: d.fileName, createdAt: d.createdAt }))); setChecks(r.crosschecks ?? []); }).catch(() => {});
  }, [api, matterId, filed.length, lockTick]);
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
      const r = await uploadCaseFile<{ action: { kind: string; reason?: string }; classification: { role: string; confidence: number } | null }>(api, matterId, file, { role, party: role === 'id_check' ? idParty || undefined : undefined, searchType: role === 'search' ? search : undefined, enquiryId: role === 'enquiry_reply' ? enquiryId.trim() : undefined });
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
      <style>{WORK_CSS + SECTION_CSS}</style>
      {unlockNote && <div className={unlockNote.ok ? 'ep-ok' : 'ep-warn'} role="status">{unlockNote.text}</div>}
      {lockedDocs.length > 0 && (
        <>
          <Section id="locked" title="Locked" count={lockedDocs.length} defaultOpen>
          <div className="ep-block" style={{ background: '#fffbeb', borderColor: '#fde68a' }}>
            {lockedDocs.map((d) => (
              <div key={d.id} className="ep-row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <b style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{d.fileName ?? d.id}</b>
                <span className="ep-note">{fmtWhen(d.createdAt)}</span>
                <PasswordInput className="ep-input" value={pw[d.id] ?? ''} onChange={(v) => setPw((m) => ({ ...m, [d.id]: v }))} onEnter={() => void unlock(d.id)} style={{ width: 200 }} />
                <button className="ep-btn primary" disabled={unlocking === d.id || !(pw[d.id] ?? '').length} onClick={() => void unlock(d.id)}>{unlocking === d.id ? <Spin>Unlocking…</Spin> : 'Unlock'}</button>
                {unlockErr[d.id] && <span className="ep-note" style={{ color: '#b91c1c' }}>{unlockErr[d.id]}</span>}
              </div>
            ))}
          </div>
          </Section>
        </>
      )}
      <Section id="files" title="Files" count={filed.length} defaultOpen>
      <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
        {filed.length > 0 && <ListToolbar tools={docTools} filters={DOC_FILTERS} placeholder="Search documents" />}
        <Grouped tools={docTools} empty={`Nothing has been filed yet${s.enrolled ? '' : ' — enrol the case first'}.`} render={({ doc: dd, events: evs }, g) => {
          const e = evs[0] ?? null;
          const id = dd.id;
          return (
          <div key={id}>
          <div id={`doc-${id}`} className="ep-row" style={{ cursor: reviewOf(id) || checked.has(id) ? 'pointer' : undefined, ...(doc && id === doc ? { background: '#faf8ff', boxShadow: 'inset 3px 0 0 #5A27E0', paddingLeft: 8, borderRadius: 6 } : {}) }} onClick={() => { if (!reviewOf(id) && !checked.has(id)) return; if (openReview === id) { setOpenReview(null); setTable(null); } else void loadTable(id); }}>
            <span className="ep-note" style={{ minWidth: 120 }}>{whenIn(dd.createdAt, g)}</span>
            <b style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{dd.fileName ?? pretty((dd.docType ?? 'document').toLowerCase())}</b>
            <span className="ep-note">{e ? `${pretty(e.type)}${typeof e.payload.searchType === 'string' ? ` ${e.payload.searchType}` : ''}${typeof e.payload.enquiryId === 'string' ? ` ${e.payload.enquiryId}` : ''}${e.confidenceScore != null ? ` · confidence ${Math.round(e.confidenceScore * 100)}%` : ''}` : 'Filed'}</span>
            <a className="ep-note" href={`/api/v1/documents/${id}/raw`} target="_blank" rel="noopener noreferrer" onClick={(ev) => ev.stopPropagation()}>Open</a>
            <button className="ep-btn" style={{ padding: '2px 8px', fontSize: 12 }} disabled={rereading === id} onClick={(ev) => { ev.stopPropagation(); void readAgain(id); }}>{rereading === id ? <Spin>Reading…</Spin> : 'Read Again'}</button>
            {reread[id] && <span className="ep-note">{reread[id]}</span>}
            {badge(reviewOf(id))}
            {checked.has(id) && <span className="ep-pill" style={{ background: '#f3efff', color: '#5A27E0' }}>Checked</span>}
          </div>
          {openReview === id && table && table.id === id && (
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
        );}} />
      </div>
      </Section>
      <Section id="upload" title="Upload">
      <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="file" accept="application/pdf,image/*,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ fontSize: 12.5 }} />
          <select className="ep-input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="auto">Detect Type</option>
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
          <button className="ep-btn primary" style={{ margin: 0 }} disabled={busy || !file || (role === 'enquiry_reply' && !enquiryId.trim())} onClick={upload}>Upload</button>
        </div>
        {msg && <div style={{ fontSize: 12.5, color: '#14532d', marginTop: 6 }}>{msg}</div>}
        {err && <div className="ep-err">{err}</div>}
      </div>
      </Section>

      {filed.length > 0 && (
        <>
          <Section id="ask" title="Ask">
          <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input className="ep-input" style={{ flex: 1 }} placeholder="Where does the lease say who repairs the roof?" value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void ask(); }} />
              <button className="ep-btn primary" style={{ margin: 0 }} disabled={asking || !question.trim()} onClick={() => void ask()}>Ask</button>
            </div>
            {asking && <div className="ep-note" style={{ marginTop: 8 }}>Reading the file…</div>}
            {answer && !asking && (
              <div style={{ marginTop: 10, fontSize: 13, display: 'grid', gap: 8 }}>
                {(answer.notOnFile || !(answer.sources ?? []).length) && <div className="ep-note">The file does not say: nothing on it answers “{answer.q}”.</div>}
                {answer.answer && answer.answer.length > 0 && (
                  <div style={{ lineHeight: 1.55, color: '#0f172a' }}>
                    {answer.answer.map((s, i) => (
                      <span key={i} style={s.supported ? undefined : { background: '#fef2f2', color: '#991b1b' }} title={s.why ?? undefined}>
                        {s.text}
                        {s.sources.map((id) => <sup key={id} style={{ color: '#5A27E0', fontWeight: 700, marginLeft: 2 }}>[{id}]</sup>)}
                        {!s.supported && <b style={{ fontSize: 11, marginLeft: 4 }}>(Not Supported: {s.why})</b>}{' '}
                      </span>
                    ))}
                  </div>
                )}
                {(answer.sources ?? []).length > 0 && (
                  <div>
                    {(answer.sources ?? []).map((src) => (
                      <div key={src.id} className="ep-row" style={{ alignItems: 'flex-start' }}>
                        <span className="ep-pill" style={{ background: src.kind === 'fact' ? '#f3efff' : '#f1f5f9', color: src.kind === 'fact' ? '#5A27E0' : '#334155', minWidth: 34, textAlign: 'center' }}>{src.id}</span>
                        <span style={{ flex: 1, color: '#334155', fontSize: 12.5 }}>{src.text.length > 260 ? `${src.text.slice(0, 260)}…` : src.text}</span>
                        <a href={`/api/v1/documents/${src.documentId}/raw#page=${src.page ?? 1}`} target="_blank" rel="noopener noreferrer" style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{src.label}</a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          </Section>
        </>
      )}
      {checks.length > 0 && (
        <>
          <Section id="checks" title="Cross-Checks" count={checks.length}>
          <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
            {checks.map((c) => (
              <div key={c.check} className="ep-row" style={{ alignItems: 'flex-start' }}>
                <span className="ep-pill" style={{ marginTop: 2, background: c.status === 'match' ? '#dcfce7' : '#fee2e2', color: c.status === 'match' ? '#14532d' : '#7f1d1d', minWidth: 64, textAlign: 'center' }}>{c.status === 'match' ? 'Agree' : 'Differ'}</span>
                <b style={{ minWidth: 130 }}>{c.label}</b>
                <span style={{ flex: 1, minWidth: 200 }}>{c.status === 'match' ? `${c.values.length} sources` : c.values.map((v) => `${v.source}${v.page ? ` p.${v.page}` : ''}: ${v.value}`).join(' · ')}</span>
              </div>
            ))}
          </div>
          </Section>
        </>
      )}
      {outbox.length > 0 && (
        <>
          <Section id="outbox" title="Outbox" count={outbox.length}>
          <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
            {outbox.map((m) => (
              <div key={m.id}>
                <div className="ep-row" style={{ cursor: 'pointer' }} onClick={() => void readMail(m.id)}>
                  <span className="ep-note" style={{ minWidth: 120 }}>{fmtWhen(m.createdAt)}</span>
                  <b>{(m.fileName ?? '').replace(/^outbox-/, '').replace(/-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.txt$/, '').replace(/_/g, ' ') || 'email'}</b>
                  <span className="ep-pill" style={{ background: '#fef3c7', color: '#78350f' }}>Not Sent</span>
                </div>
                {openMail === m.id && <pre style={{ margin: '4px 0 10px', padding: '10px 12px', border: '1px solid #e6e8ee', borderRadius: 10, whiteSpace: 'pre-wrap', fontSize: 12.5, fontFamily: 'inherit', background: '#fafafa' }}>{mailBody[m.id] ?? 'Reading…'}</pre>}
              </div>
            ))}
          </div>
          </Section>
        </>
      )}
      {drafts.length > 0 && (
        <>
          <Section id="drafts" title="Drafts" count={drafts.length}>
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
          </Section>
        </>
      )}
    </div>
  );
}
