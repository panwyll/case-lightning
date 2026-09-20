'use client';
import { useCallback, useEffect, useState } from 'react';
import { DecisionFeed } from './DecisionFeed';
import { IssuesPanel } from './IssuesPanel';
import { STAGES, fmtDay, fmtWhen, pretty, type Api, type EngineEvent, type EngineView } from './types';

/**
 * A matter's engine view for the case handler: where it is, what is blocking the next
 * stage, what it is waiting on (with SLA age), the pending decisions, each sub-flow's
 * status, the human commands that are valid now, and the tail of the immutable log.
 */
const CSS = `
.ep{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;font-size:13px}
.ep-steps{display:flex;gap:4px;flex-wrap:wrap;margin:8px 0 12px}
.ep-step{padding:5px 9px;border-radius:999px;font-size:11.5px;font-weight:700;border:1px solid #e2e8f0;color:#94a3b8;background:#fff}
.ep-step.done{background:#f0fdf4;border-color:#86efac;color:#14532d}
.ep-step.now{background:#0f172a;border-color:#0f172a;color:#fff}
.ep-sec{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#94a3b8;margin:16px 0 6px}
.ep-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}
.ep-tile{border:1px solid #e6e8ee;border-radius:10px;padding:8px 10px;background:#fff}
.ep-tile b{display:block;font-size:12px}
.ep-pill{display:inline-block;font-size:10.5px;font-weight:800;border-radius:99px;padding:1px 7px;margin-top:3px}
.ep-btn{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:6px 10px;font-size:12.5px;cursor:pointer;margin:4px 6px 0 0;font-family:inherit}
.ep-btn.primary{background:#5A27E0;color:#fff;border-color:#5A27E0}
.ep-btn:disabled{opacity:.45;cursor:not-allowed}
.ep-block{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px;font-size:12.5px}
.ep-err{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 10px;font-size:12.5px;margin-top:8px}
.ep-log{font-size:12px;border-top:1px solid #f1f5f9;padding:6px 0;display:flex;gap:8px}
.ep-log .t{color:#94a3b8;min-width:110px}
.ep-log .a{color:#64748b;min-width:70px}
.ep-input{border:1px solid #cbd5e1;border-radius:8px;padding:6px 8px;font-size:12.5px;font-family:inherit;margin-right:6px}
`;

const PILL: Record<string, { bg: string; fg: string }> = {
  cleared: { bg: '#dcfce7', fg: '#14532d' },
  reviewed: { bg: '#dcfce7', fg: '#14532d' },
  flagged: { bg: '#fee2e2', fg: '#7f1d1d' },
  ordered: { bg: '#fef3c7', fg: '#78350f' },
  raised: { bg: '#fef3c7', fg: '#78350f' },
  requested: { bg: '#fef3c7', fg: '#78350f' },
  awaiting: { bg: '#f1f5f9', fg: '#475569' },
  returned: { bg: '#e0e7ff', fg: '#3730a3' },
  extracted: { bg: '#e0e7ff', fg: '#3730a3' },
  replied: { bg: '#e0e7ff', fg: '#3730a3' },
  received: { bg: '#e0e7ff', fg: '#3730a3' },
  drafted: { bg: '#fef3c7', fg: '#78350f' },
  approved: { bg: '#e0e7ff', fg: '#3730a3' },
  sent: { bg: '#dcfce7', fg: '#14532d' },
  not_required: { bg: '#f1f5f9', fg: '#94a3b8' },
  not_started: { bg: '#f1f5f9', fg: '#94a3b8' },
  rejected: { bg: '#fee2e2', fg: '#7f1d1d' },
  verified: { bg: '#dcfce7', fg: '#14532d' },
  unverified: { bg: '#fee2e2', fg: '#7f1d1d' },
  failed: { bg: '#fee2e2', fg: '#7f1d1d' },
  superseded: { bg: '#f1f5f9', fg: '#94a3b8' },
};
const Pill = ({ s }: { s: string }) => <span className="ep-pill" style={{ background: PILL[s]?.bg ?? '#f1f5f9', color: PILL[s]?.fg ?? '#475569' }}>{pretty(s)}</span>;

const daysAgo = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

export function EnginePanel({ matterId, api, onChanged }: { matterId: string; api: Api; onChanged?: () => void }) {
  const [view, setView] = useState<EngineView | null>(null);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [hasLender, setHasLender] = useState(true);
  const [leasehold, setLeasehold] = useState(false);
  const [pofNote, setPofNote] = useState('');
  const [pofQuestion, setPofQuestion] = useState('');
  const [enquiry, setEnquiry] = useState({ id: '', subject: '' });
  const [completionDate, setCompletionDate] = useState('');
  const [upRole, setUpRole] = useState<'auto' | 'search' | 'enquiry_reply' | 'mortgage_offer' | 'title' | 'id_check' | 'management_pack'>('auto');
  const [upSearch, setUpSearch] = useState('CON29');
  const [upEnquiry, setUpEnquiry] = useState('');
  const [upFile, setUpFile] = useState<File | null>(null);
  const [upMsg, setUpMsg] = useState<string | null>(null);
  const [bd, setBd] = useState({ payeeKind: 'seller_solicitor', payeeRef: '', accountName: '', sortCode: '', accountNumber: '', firmName: '', sourceChannel: 'email' });
  const [payFrom, setPayFrom] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const v = await api<EngineView>(`/matters/${matterId}/engine`);
      setView(v);
      setErr(null);
      const ev = await api<{ events: EngineEvent[] }>(`/matters/${matterId}/engine/events?limit=2000`);
      setEvents(ev.events.slice(-60).reverse());
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load the engine view.');
    }
  }, [api, matterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const cmd = async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/matters/${matterId}/engine`, { method: 'POST', body: JSON.stringify(body) });
      await load();
      onChanged?.();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Command failed.');
    } finally {
      setBusy(false);
    }
  };

  const upload = async () => {
    if (!upFile) return;
    setBusy(true);
    setErr(null);
    setUpMsg(null);
    try {
      const buf = await upFile.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const r = await api<{ action: { kind: string; reason?: string }; classification: { role: string; confidence: number } | null }>(`/matters/${matterId}/engine/upload`, {
        method: 'POST',
        body: JSON.stringify({ fileName: upFile.name, mimeType: upFile.type || 'application/pdf', base64: btoa(bin), role: upRole, searchType: upRole === 'search' ? upSearch : undefined, enquiryId: upRole === 'enquiry_reply' ? upEnquiry.trim() : undefined }),
      });
      setUpMsg(r.action.kind === 'skip' ? `Filed, not routed: ${r.action.reason ?? ''}` : `Filed as ${r.action.kind.replace('_', ' ')}${r.classification ? ` (classifier ${Math.round(r.classification.confidence * 100)}% sure)` : ''} — the engine has extracted and rule-checked it.`);
      setUpFile(null);
      await load();
      onChanged?.();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  if (err && !view) return <div className="ep"><style>{CSS}</style><div className="ep-err">{err}</div></div>;
  if (!view) return <div className="ep"><style>{CSS}</style><div style={{ color: '#94a3b8' }}>Loading the engine…</div></div>;
  const s = view.state;

  if (!s.enrolled) {
    return (
      <div className="ep">
        <style>{CSS}</style>
        <div className="ep-block">
          This matter is not yet run by the conveyancing engine. Enrolling it starts the freehold-purchase state machine: ID/AML, searches (auto-ordered), enquiries, mortgage offer, title, report on title, exchange, completion and registration — with every step logged and only genuine decisions surfaced to you.
        </div>
        <div style={{ marginTop: 10 }}>
          <label style={{ fontSize: 12.5, marginRight: 12 }}><input type="checkbox" checked={hasLender} onChange={(e) => setHasLender(e.target.checked)} /> Buyer has a mortgage lender</label>
          <label style={{ fontSize: 12.5, marginRight: 12 }}><input type="checkbox" checked={leasehold} onChange={(e) => setLeasehold(e.target.checked)} /> Leasehold (management pack, lease review)</label>
          <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'enrol', hasLender, transactionType: leasehold ? 'leasehold_purchase' : 'freehold_purchase' })}>Enrol matter ({leasehold ? 'leasehold' : 'freehold'} purchase)</button>
        </div>
        {err && <div className="ep-err">{err}</div>}
      </div>
    );
  }

  const stageIdx = STAGES.indexOf(s.stage);
  const openWaits = view.waits;
  return (
    <div className="ep">
      <style>{CSS}</style>
      <div className="ep-steps">
        {STAGES.map((st, i) => (
          <span key={st} className={`ep-step${i < stageIdx ? ' done' : i === stageIdx ? ' now' : ''}`} title={s.stageHistory.find((h) => h.stage === st) ? `entered ${fmtWhen(s.stageHistory.find((h) => h.stage === st)!.at)}` : ''}>{pretty(st)}</span>
        ))}
      </div>
      {s.manualHandling.required && <div className="ep-err">Manual handling required: {pretty(s.manualHandling.reason ?? '')}. Automation is paused on this matter.</div>}
      {view.blockers.length > 0 && (
        <div className="ep-block"><b>Before the next stage:</b> {view.blockers.join(' · ')}</div>
      )}

      {openWaits.length > 0 && (
        <>
          <div className="ep-sec">Waiting on others</div>
          <div className="ep-grid">
            {openWaits.map((w) => (
              <div key={`${w.key}:${w.subject}`} className="ep-tile">
                <b>{pretty(w.key)}{w.subject ? ` · ${w.subject}` : ''}</b>
                <span style={{ color: '#64748b' }}>since {fmtDay(w.openedAt)} ({daysAgo(w.openedAt)}d) · chased {w.chasesSentAt.length}× {w.escalations.some((e) => !e.resolvedAt) ? '· escalated' : ''}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="ep-sec">Decisions waiting on you ({view.pendingDecisions.length})</div>
      <DecisionFeed api={api} matterId={matterId} compact onResolved={() => { void load(); onChanged?.(); }} />

      <div className="ep-sec">Sub-flows</div>
      <div className="ep-grid">
        <div className="ep-tile"><b>ID / AML</b><Pill s={s.idCheck.status} /></div>
        {s.requiredSearches.map((t) => {
          const sr = s.searches[t];
          return <div key={t} className="ep-tile"><b>{t} search</b>{sr ? <Pill s={sr.status} /> : <Pill s="not_started" />}{sr?.flags.length ? <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 3 }}>{sr.flags.map((f) => f.code).join(', ')}</div> : null}</div>;
        })}
        {Object.values(s.enquiries).map((q) => (
          <div key={q.enquiryId} className="ep-tile"><b>Enquiry {q.enquiryId}</b><Pill s={q.status} /><div style={{ fontSize: 11.5, color: '#64748b', marginTop: 3 }}>{q.subject}</div></div>
        ))}
        <div className="ep-tile"><b>Mortgage offer{s.mortgage.facts?.lender ? ` · ${s.mortgage.facts.lender}` : ''}</b><Pill s={s.mortgage.status} /></div>
        <div className="ep-tile"><b>Proof of funds{s.proofOfFunds?.rounds ? ` · round ${s.proofOfFunds.rounds}` : ''}</b><Pill s={s.proofOfFunds?.status === 'reviewed' ? (s.proofOfFunds.resolution === 'approve' ? 'reviewed' : s.proofOfFunds.resolution === 'reject' ? 'rejected' : 'reviewed') : s.proofOfFunds?.status === 'submitted' ? 'flagged' : s.proofOfFunds?.status === 'requested' ? 'requested' : 'not_started'} />{s.proofOfFunds?.facts ? <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 3 }}>declared £{(s.proofOfFunds.facts.totalDeclaredPennies / 100).toLocaleString('en-GB')}{s.proofOfFunds.facts.requiredPennies != null ? ` of £${(s.proofOfFunds.facts.requiredPennies / 100).toLocaleString('en-GB')} needed` : ''}{s.proofOfFunds.facts.giftedPennies ? ' · includes a gift' : ''}</div> : s.proofOfFunds?.status === 'requested' ? <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 3 }}>form with the client since {fmtDay(s.proofOfFunds.requestedAt)}</div> : null}</div>
        {s.transactionType === 'leasehold_purchase' && <div className="ep-tile"><b>Management pack (LPE1)</b><Pill s={s.managementPack?.status ?? 'not_started'} /></div>}
      </div>

      {s.proofOfFunds && s.proofOfFunds.status !== 'not_started' && (() => {
        const pof = s.proofOfFunds;
        const qs = Object.values(pof.queries ?? {}).sort((a, b) => a.raisedAt.localeCompare(b.raisedAt) || (a.id > b.id ? 1 : -1));
        const open = qs.filter((q) => q.status === 'draft' || q.status === 'sent');
        const QCHIP: Record<string, { bg: string; fg: string }> = { draft: { bg: '#fef3c7', fg: '#78350f' }, sent: { bg: '#e0e7ff', fg: '#3730a3' }, answered: { bg: '#dcfce7', fg: '#14532d' }, withdrawn: { bg: '#f1f5f9', fg: '#94a3b8' } };
        return (
          <>
            <div className="ep-sec">Proof of funds — statements read, queries to the client{pof.risk ? ` · risk ${pof.risk}` : ''}{pof.approvedAt ? ` · signed off ${fmtDay(pof.approvedAt)}` : ''}</div>
            <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
              {(pof.statements?.length ?? 0) > 0 && (
                <div style={{ fontSize: 12.5, marginBottom: 6 }}>
                  <b>Statements read:</b> {pof.statements!.map((st) => `${st.fileName ?? st.documentId}${st.readable ? ` (${st.holder ?? '?'}, ${st.from ?? '?'}–${st.to ?? '?'}, ${st.transactions} lines)` : ' (unreadable)'}`).join(' · ')}
                </div>
              )}
              {(pof.flags?.length ?? 0) > 0 && <div style={{ fontSize: 12.5, marginBottom: 6 }}><b>Flags:</b> {pof.flags!.map((f) => f.code).join(', ')}</div>}
              {qs.length === 0 && <div style={{ fontSize: 12.5, color: '#64748b' }}>No queries. The rules draft one for every unusual credit when the client submits; you can add your own below.</div>}
              {qs.map((q) => (
                <div key={q.id} style={{ borderTop: '1px solid #f1f5f9', padding: '6px 0', fontSize: 12.5 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <b>{q.id}</b><span className="ep-pill" style={{ background: QCHIP[q.status].bg, color: QCHIP[q.status].fg, marginTop: 0 }}>{q.status}</span><span style={{ color: '#64748b' }}>{pretty(q.flagCode.split(':')[0].toLowerCase())}{q.raisedBy === 'system' ? ' · drafted by the rules' : ' · added by a person'}</span>
                    {(q.status === 'draft' || q.status === 'sent') && <button className="ep-btn" style={{ margin: '0 0 0 auto', padding: '2px 8px', fontSize: 11.5 }} disabled={busy} onClick={() => { const r = window.prompt('Why is this query not needed? (recorded on the log)'); if (r) void cmd({ type: 'withdraw_proof_of_funds_query', queryId: q.id, reason: r }); }}>Withdraw</button>}
                  </div>
                  <div>{q.question}</div>
                  {q.transaction && <div style={{ color: '#64748b', fontSize: 11.5 }}>Line: {q.transaction.date} · {q.transaction.description} · £{(Math.abs(q.transaction.amountPennies) / 100).toLocaleString('en-GB')}</div>}
                  {q.answer != null && <div style={{ marginTop: 3, padding: '4px 8px', background: '#f0fdf4', borderRadius: 6 }}><b>Client:</b> {q.answer || '(evidence only)'}{q.answerEvidenceDocumentIds.length ? ` · ${q.answerEvidenceDocumentIds.length} document${q.answerEvidenceDocumentIds.length === 1 ? '' : 's'}` : ''}</div>}
                </div>
              ))}
              {!pof.approvedAt && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input className="ep-input" placeholder="Add a query for the client…" value={pofQuestion} onChange={(e) => setPofQuestion(e.target.value)} style={{ width: 420 }} />
                  <button className="ep-btn" style={{ margin: 0 }} disabled={busy || pofQuestion.trim().length < 5} onClick={() => { void cmd({ type: 'raise_proof_of_funds_query', question: pofQuestion.trim() }); setPofQuestion(''); }}>Add query</button>
                  {open.length > 0 && <span style={{ fontSize: 11.5, color: '#64748b' }}>{open.length} open — sign-off is unavailable until each is sent (query from the decision) or withdrawn with a reason.</span>}
                </div>
              )}
            </div>
          </>
        );
      })()}
      <div className="ep-grid" style={{ display: 'none' }}>
        <div className="ep-tile"><b>Title{s.title.facts?.titleNumber ? ` · ${s.title.facts.titleNumber}` : ''}</b><Pill s={s.title.status} /></div>
        <div className="ep-tile"><b>Report on title</b><Pill s={s.reportOnTitle.status} />{s.reportOnTitle.sentAt ? <div style={{ fontSize: 11.5, color: '#64748b' }}>sent {fmtDay(s.reportOnTitle.sentAt)}</div> : null}</div>
        <div className="ep-tile"><b>Exchange</b><Pill s={s.exchange.exchangedAt ? 'sent' : s.deposit.received ? 'approved' : 'awaiting'} />{s.exchange.completionDate ? <div style={{ fontSize: 11.5, color: '#64748b' }}>completion {s.exchange.completionDate}</div> : null}</div>
        <div className="ep-tile"><b>Completion</b><Pill s={s.completion.confirmedAt ? 'sent' : s.completion.fundsReceivedAt ? 'approved' : s.completion.fundsRequestedAt ? 'requested' : 'awaiting'} /></div>
        <div className="ep-tile"><b>Post-completion</b><Pill s={s.postCompletion.ap1ConfirmedAt ? 'sent' : s.postCompletion.ap1SubmittedAt ? 'requested' : s.postCompletion.sdltSubmittedAt ? 'approved' : 'awaiting'} /></div>
      </div>

      <IssuesPanel api={api} state={s} busy={busy} cmd={cmd} />

      <div className="ep-sec">Payee bank details (versioned · every change is a hard stop)</div>
      <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
        {Object.values(s.bankDetails).length === 0 && <div style={{ fontSize: 12.5, color: '#64748b' }}>No bank details on file yet. Nothing can be paid, or requested, until a payee's details are recorded and verified out-of-band.</div>}
        {Object.values(s.bankDetails).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).map((b) => (
          <div key={b.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', padding: '5px 0', borderTop: '1px solid #f1f5f9', fontSize: 12.5 }}>
            <b style={{ minWidth: 150 }}>{pretty(b.payeeKind)}{b.payeeRef ? ` · ${b.payeeRef}` : ''}</b>
            <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{b.details.sortCode.replace(/(\d{2})(\d{2})(\d{2})/, '$1-$2-$3')} ····{b.details.accountNumber.slice(-4)}</span>
            <span>{b.details.accountName}</span>
            <Pill s={b.status === 'unverified' ? 'unverified' : b.status} />
            <span style={{ color: '#64748b' }}>via {b.sourceChannel} {fmtDay(b.recordedAt)}{b.verificationMethod ? ` · verified by ${pretty(b.verificationMethod)}${b.verificationRef ? ` (${b.verificationRef})` : ''}` : ''}</span>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <select className="ep-input" value={bd.payeeKind} onChange={(e) => setBd({ ...bd, payeeKind: e.target.value })}>
            {['seller_solicitor', 'firm_client_account', 'client', 'lender', 'estate_agent', 'other'].map((k) => <option key={k} value={k}>{pretty(k)}</option>)}
          </select>
          <input className="ep-input" placeholder="Who (firm / contact)" value={bd.payeeRef} onChange={(e) => setBd({ ...bd, payeeRef: e.target.value })} style={{ width: 150 }} />
          <input className="ep-input" placeholder="Account name" value={bd.accountName} onChange={(e) => setBd({ ...bd, accountName: e.target.value })} style={{ width: 160 }} />
          <input className="ep-input" placeholder="Sort code (6 digits)" value={bd.sortCode} onChange={(e) => setBd({ ...bd, sortCode: e.target.value.replace(/\D/g, '') })} style={{ width: 130 }} maxLength={6} />
          <input className="ep-input" placeholder="Account no. (8 digits)" value={bd.accountNumber} onChange={(e) => setBd({ ...bd, accountNumber: e.target.value.replace(/\D/g, '') })} style={{ width: 150 }} maxLength={8} />
          <select className="ep-input" value={bd.sourceChannel} onChange={(e) => setBd({ ...bd, sourceChannel: e.target.value })}>
            {['email', 'portal', 'phone', 'letter', 'in_person', 'manual', 'provider'].map((k) => <option key={k} value={k}>arrived by {pretty(k)}</option>)}
          </select>
          <button className="ep-btn" style={{ margin: 0 }} disabled={busy || !bd.accountName || bd.sortCode.length !== 6 || bd.accountNumber.length !== 8} onClick={() => { void cmd({ type: 'record_bank_details', payeeKind: bd.payeeKind, payeeRef: bd.payeeRef || null, details: { sortCode: bd.sortCode, accountNumber: bd.accountNumber, accountName: bd.accountName, firmName: bd.firmName || null }, sourceChannel: bd.sourceChannel }); setBd({ ...bd, accountName: '', sortCode: '', accountNumber: '' }); }}>Record details (creates a hard-stop decision)</button>
        </div>
        {s.payments.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 12.5 }}>
            <b>Payments authorised:</b> {s.payments.map((p) => `${pretty(p.purpose)} → ${pretty(p.payeeKind)}${p.amountPennies ? ` £${(p.amountPennies / 100).toLocaleString('en-GB')}` : ''} (${fmtDay(p.at)})`).join(' · ')}
          </div>
        )}
      </div>

      <div className="ep-sec">File a document into the engine</div>
      <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="file" accept="application/pdf,image/*,.txt" onChange={(e) => setUpFile(e.target.files?.[0] ?? null)} style={{ fontSize: 12.5 }} />
          <select className="ep-input" value={upRole} onChange={(e) => setUpRole(e.target.value as typeof upRole)}>
            <option value="auto">Let the engine classify it</option>
            <option value="search">Search result</option>
            <option value="enquiry_reply">Reply to enquiries</option>
            <option value="mortgage_offer">Mortgage offer</option>
            <option value="title">Official copy of the register</option>
            <option value="id_check">ID / AML report</option>
            {s.transactionType === 'leasehold_purchase' && <option value="management_pack">Management pack (LPE1)</option>}
          </select>
          {upRole === 'search' && (
            <select className="ep-input" value={upSearch} onChange={(e) => setUpSearch(e.target.value)}>
              {['LLC1', 'CON29', 'DRAINAGE_WATER', 'ENVIRONMENTAL', 'CHANCEL'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          {upRole === 'enquiry_reply' && <input className="ep-input" placeholder="Enquiry id (E1)" value={upEnquiry} onChange={(e) => setUpEnquiry(e.target.value)} style={{ width: 120 }} />}
          <button className="ep-btn primary" style={{ margin: 0 }} disabled={busy || !upFile || (upRole === 'enquiry_reply' && !upEnquiry.trim())} onClick={upload}>File into engine</button>
        </div>
        <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 6 }}>Search results, replies, offers, title and ID reports arrive here (or via OneDrive / InfoTrack automatically). The engine extracts, rule-checks and either clears it or raises a decision for you.</div>
        {upMsg && <div style={{ fontSize: 12.5, color: '#14532d', marginTop: 6 }}>{upMsg}</div>}
      </div>

      <div className="ep-sec">Actions</div>
      <div>
        {s.stage === 'instruction' && s.idCheck.status === 'not_started' && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'request_id_check' })}>Request ID / AML check</button>}
        {!s.exchange.exchangedAt && (s.proofOfFunds?.status === 'not_started' || (s.proofOfFunds?.status === 'reviewed' && s.proofOfFunds.resolution !== 'approve')) && (
          <span>
            <input className="ep-input" placeholder="Note to the client (optional)" value={pofNote} onChange={(e) => setPofNote(e.target.value)} style={{ width: 260 }} />
            <button className="ep-btn primary" disabled={busy} onClick={() => { void cmd({ type: 'request_proof_of_funds', noteToClient: pofNote.trim() || null }); setPofNote(''); }}>Send proof-of-funds form</button>
          </span>
        )}
        {s.transactionType === 'leasehold_purchase' && ['pre_contract', 'contract_review', 'pre_exchange'].includes(s.stage) && s.managementPack?.status === 'not_started' && <button className="ep-btn primary" disabled={busy} onClick={() => { const from = window.prompt('Requested from (seller\'s solicitor / managing agent)?', 'Seller\'s solicitor'); if (from) void cmd({ type: 'management_pack_requested', from }); }}>Management pack requested</button>}
        {s.transactionType === 'leasehold_purchase' && s.completion.confirmedAt && !s.postCompletion.noticeOfAssignmentAt && <button className="ep-btn" disabled={busy} onClick={() => { const on = window.prompt('Notice of assignment served on?', 'Landlord / managing agent'); if (on) void cmd({ type: 'notice_of_assignment_served', servedOn: on }); }}>Notice of assignment served</button>}
        {(s.stage === 'pre_contract' || s.stage === 'contract_review') && (
          <span>
            <input className="ep-input" placeholder="Enquiry id (E3)" value={enquiry.id} onChange={(e) => setEnquiry({ ...enquiry, id: e.target.value })} style={{ width: 110 }} />
            <input className="ep-input" placeholder="Subject" value={enquiry.subject} onChange={(e) => setEnquiry({ ...enquiry, subject: e.target.value })} style={{ width: 220 }} />
            <button className="ep-btn" disabled={busy || !enquiry.id || !enquiry.subject} onClick={() => { void cmd({ type: 'raise_enquiry', enquiryId: enquiry.id.trim(), subject: enquiry.subject.trim() }); setEnquiry({ id: '', subject: '' }); }}>Raise enquiry</button>
          </span>
        )}
        {s.stage === 'contract_review' && ['not_started', 'rejected'].includes(s.reportOnTitle.status) && (s.title.status === 'cleared' || s.title.status === 'reviewed') && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'draft_report_on_title' })}>Draft report on title (AI, needs your approval)</button>}
        {s.reportOnTitle.status === 'approved' && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'send_report_on_title' })}>Send approved report to client</button>}
        {['contract_review', 'pre_exchange'].includes(s.stage) && !s.deposit.received && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'deposit_received' })}>Deposit received</button>}
        {s.stage === 'pre_exchange' && s.exchange.conditionsMet && !s.exchange.exchangedAt && (
          <span>
            <input className="ep-input" type="date" value={completionDate} onChange={(e) => setCompletionDate(e.target.value)} />
            <button className="ep-btn primary" disabled={busy || !completionDate} onClick={() => cmd({ type: 'contracts_exchanged', completionDate })}>Contracts exchanged</button>
          </span>
        )}
        {s.stage === 'exchanged' && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'completion_statement_generated' })}>Completion statement generated</button>}
        {s.stage === 'pre_completion' && (() => {
          const verified = (kind: string) => Object.values(s.bankDetails).filter((b) => b.payeeKind === kind && b.status === 'verified');
          const firm = verified('firm_client_account');
          const seller = verified('seller_solicitor');
          const paid = s.payments.some((p) => p.payeeKind === 'seller_solicitor' && p.purpose === 'completion_monies');
          const sel = (kind: string, list: typeof firm) => (
            <select className="ep-input" value={payFrom[kind] ?? list[0]?.id ?? ''} onChange={(e) => setPayFrom({ ...payFrom, [kind]: e.target.value })}>
              {list.map((b) => <option key={b.id} value={b.id}>{b.details.accountName} ····{b.details.accountNumber.slice(-4)}</option>)}
            </select>
          );
          return (
            <span>
              {firm.length === 0 && !s.completion.fundsReceivedAt && <span className="ep-block" style={{ display: 'inline-block', marginRight: 6 }}>Record and verify the firm's client-account details before requesting funds.</span>}
              {firm.length > 0 && !s.completion.fundsReceivedAt && sel('firm_client_account', firm)}
              {firm.length > 0 && s.hasLender && !openWaits.some((w) => w.key === 'funds' && w.subject === 'lender') && !s.completion.fundsReceivedAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'funds_requested', fromRole: 'lender', bankDetailsId: payFrom.firm_client_account ?? firm[0].id })}>Request lender funds</button>}
              {firm.length > 0 && !openWaits.some((w) => w.key === 'funds' && w.subject === 'client') && !s.completion.fundsReceivedAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'funds_requested', fromRole: 'client', bankDetailsId: payFrom.firm_client_account ?? firm[0].id })}>Request client funds</button>}
              {openWaits.filter((w) => w.key === 'funds').map((w) => <button key={w.subject} className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'funds_received', fromRole: w.subject })}>{pretty(w.subject)} funds received</button>)}
              {!paid && seller.length === 0 && <span className="ep-block" style={{ display: 'inline-block', marginRight: 6 }}>No verified seller's-solicitor bank details — completion monies cannot be authorised.</span>}
              {!paid && seller.length > 0 && sel('seller_solicitor', seller)}
              {!paid && seller.length > 0 && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'payment_authorised', payeeKind: 'seller_solicitor', bankDetailsId: payFrom.seller_solicitor ?? seller[0].id, purpose: 'completion_monies' })}>Authorise completion payment</button>}
              {s.completion.fundsReceivedAt && paid && !s.completion.confirmedAt && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'completion_confirmed' })}>Completion confirmed</button>}
            </span>
          );
        })()}
        {['completed', 'post_completion'].includes(s.stage) && (
          <span>
            {!s.postCompletion.sdltSubmittedAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'sdlt_submitted' })}>SDLT submitted</button>}
            {!s.postCompletion.ap1SubmittedAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'ap1_submitted' })}>AP1 submitted</button>}
            {s.postCompletion.ap1SubmittedAt && !s.postCompletion.ap1ConfirmedAt && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'ap1_confirmed' })}>Registration confirmed</button>}
          </span>
        )}
        {!s.manualHandling.required && <button className="ep-btn" disabled={busy} onClick={() => { const reason = window.prompt('Why does this matter need manual handling?'); if (reason) void cmd({ type: 'mark_manual_handling', reason }); }}>Take over manually</button>}
      </div>
      {err && <div className="ep-err">{err}</div>}

      <div className="ep-sec" style={{ cursor: 'pointer' }} onClick={() => setShowLog((x) => !x)}>{showLog ? '▾' : '▸'} Event log ({s.lastSeq} events · {s.clientUpdatesSent} client updates · {s.chasesSent} chases)</div>
      {showLog && events.map((e) => (
        <div key={e.id} className="ep-log">
          <span className="t">#{e.seq} {fmtWhen(e.createdAt)}</span>
          <span className="a">{e.actor === 'system' || e.actor === 'ai' || e.actor === 'external' ? e.actor : 'user'}</span>
          <span>{pretty(e.type)}{typeof e.payload.searchType === 'string' ? ` · ${e.payload.searchType}` : ''}{typeof e.payload.enquiryId === 'string' ? ` · ${e.payload.enquiryId}` : ''}{typeof e.payload.to === 'string' ? ` → ${pretty(e.payload.to)}` : ''}{typeof e.payload.option === 'string' ? ` · ${pretty(e.payload.option)}` : ''}</span>
        </div>
      ))}
    </div>
  );
}
