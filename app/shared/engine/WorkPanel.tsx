'use client';
import { useState, type ReactNode } from 'react';
import { DecisionFeed } from './DecisionFeed';
import { TRANSACTION_LABEL, TRANSACTION_TYPES, fmtDay, fmtWhen, pretty, stageLabel, type Api, type EngineState, type EngineView, type ProfileView, type TransactionType } from './types';

/**
 * The work panel for one matter: where it is on this transaction type's spine, what
 * blocks the next phase, what it is waiting on, the decisions pending, and then the work
 * grouped by WORKSTREAM — each lane showing its facts and the commands a person may
 * record now. Which lanes appear, and which commands, comes from the transaction profile
 * the server returns (docs/transaction-types.md); nothing here is duplicated per type.
 */
export const WORK_CSS = `
.ep{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;font-size:13px}
.ep-steps{display:flex;gap:4px;flex-wrap:wrap;margin:8px 0 12px}
.ep-step{padding:5px 9px;border-radius:999px;font-size:11.5px;font-weight:700;border:1px solid #e2e8f0;color:#94a3b8;background:#fff}
.ep-step.done{background:#f0fdf4;border-color:#86efac;color:#14532d}
.ep-step.now{background:#0f172a;border-color:#0f172a;color:#fff}
.ep-sec{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#94a3b8;margin:16px 0 6px}
.ep-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}
.ep-tile{border:1px solid #e6e8ee;border-radius:10px;padding:8px 10px;background:#fff}
.ep-tile b{display:block;font-size:12px}
.ep-tile .d{font-size:11.5px;color:#64748b;margin-top:3px}
.ep-pill{display:inline-block;font-size:10.5px;font-weight:800;border-radius:99px;padding:1px 7px;margin-top:3px}
.ep-btn{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:6px 10px;font-size:12.5px;cursor:pointer;margin:4px 6px 0 0;font-family:inherit}
.ep-btn.primary{background:#5A27E0;color:#fff;border-color:#5A27E0}
.ep-btn:disabled{opacity:.45;cursor:not-allowed}
.ep-block{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px;font-size:12.5px}
.ep-err{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 10px;font-size:12.5px;margin-top:8px}
.ep-ok{color:#14532d;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 10px;font-size:12.5px;margin-top:8px}
.ep-warn{color:#78350f;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px;font-size:12.5px;margin-top:8px}
.ep-input{border:1px solid #cbd5e1;border-radius:8px;padding:6px 8px;font-size:12.5px;font-family:inherit;margin-right:6px}
.ep-lane{border:1px solid #e6e8ee;border-radius:12px;background:#fff;margin-top:10px;overflow:hidden}
.ep-lane-h{display:flex;gap:10px;align-items:center;padding:8px 12px;background:#fafafa;border:0;border-bottom:1px solid #f1f5f9;width:100%;text-align:left;cursor:pointer;font-family:inherit;color:inherit;flex-wrap:wrap}
.ep-lane-h b{font-size:12.5px}
.ep-lane-h .tw{color:#94a3b8;font-size:11px;width:10px}
.ep-lane-h .sub{display:flex;gap:4px;flex-wrap:wrap;margin-left:auto}
.ep-over{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;margin-top:6px}
.ep-over button{border:1px solid #e6e8ee;border-radius:10px;background:#fff;padding:8px 10px;text-align:left;cursor:pointer;font-family:inherit;color:inherit}
.ep-over button.on{border-color:#0f172a}
.ep-over b{display:block;font-size:12px}
.ep-over .n{font-size:11px;color:#64748b;margin-top:3px}
.ep-lane-h .st{font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;border-radius:99px;padding:2px 8px}
.ep-lane-b{padding:10px 12px}
.ep-lane-b .acts{margin-top:6px}
.ep-row{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;padding:5px 0;border-top:1px solid #f1f5f9;font-size:12.5px}
.ep-row:first-child{border-top:0}
.ep-note{font-size:11.5px;color:#64748b}
.ep-enrol{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:10px}
.ep-enrol label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#334155}
.ep-enrol input,.ep-enrol select{border:1px solid #cbd5e1;border-radius:8px;padding:6px 8px;font-size:12.5px;font-family:inherit}
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
  done: { bg: '#dcfce7', fg: '#14532d' },
  redeemed: { bg: '#e0e7ff', fg: '#3730a3' },
  discharged: { bg: '#dcfce7', fg: '#14532d' },
  not_required: { bg: '#f1f5f9', fg: '#94a3b8' },
  not_applicable: { bg: '#f1f5f9', fg: '#94a3b8' },
  not_started: { bg: '#f1f5f9', fg: '#94a3b8' },
  rejected: { bg: '#fee2e2', fg: '#7f1d1d' },
  verified: { bg: '#dcfce7', fg: '#14532d' },
  unverified: { bg: '#fee2e2', fg: '#7f1d1d' },
  failed: { bg: '#fee2e2', fg: '#7f1d1d' },
  superseded: { bg: '#f1f5f9', fg: '#94a3b8' },
};
const Pill = ({ s }: { s: string }) => <span className="ep-pill" style={{ background: PILL[s]?.bg ?? '#f1f5f9', color: PILL[s]?.fg ?? '#475569' }}>{pretty(s)}</span>;
const LANE_STATE: Record<string, { bg: string; fg: string }> = { done: { bg: '#dcfce7', fg: '#14532d' }, open: { bg: '#fef3c7', fg: '#78350f' }, blocked: { bg: '#fee2e2', fg: '#7f1d1d' }, idle: { bg: '#f1f5f9', fg: '#64748b' } };
const daysAgo = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
const gbp = (p: number | null | undefined) => (p == null ? '' : `£${(p / 100).toLocaleString('en-GB')}`);

interface Tile { label: string; status: string; detail?: string }
interface LaneDef { id: string; title: string; state: 'done' | 'open' | 'blocked' | 'idle'; note?: string; tiles: Tile[]; actions?: ReactNode; extra?: ReactNode }
export type Notice = { kind: 'ok' | 'warn' | 'err'; text: string; at: number } | null;
const NoticeBox = ({ n }: { n: Notice }) => (n ? <div className={n.kind === 'ok' ? 'ep-ok' : n.kind === 'warn' ? 'ep-warn' : 'ep-err'} role={n.kind === 'err' ? 'alert' : 'status'}>{n.text}</div> : null);

/**
 * One macro block. Collapsed: the title, its rolled-up status and each sub-block as a chip.
 * Expanded: the sub-blocks as tiles with their own status, any detail, and the commands a
 * person may record now.
 */
function Lane({ lane, open, onToggle, notice }: { lane: LaneDef; open: boolean; onToggle: () => void; notice?: Notice }) {
  return (
    <div className="ep-lane" id={`lane-${lane.id}`} data-lane={lane.id}>
      <button type="button" className="ep-lane-h" onClick={onToggle} aria-expanded={open}>
        <span className="tw">{open ? '▾' : '▸'}</span>
        <b>{lane.title}</b>
        <span className="st" style={{ background: LANE_STATE[lane.state].bg, color: LANE_STATE[lane.state].fg }}>{lane.state}</span>
        {lane.note && <span className="ep-note">{lane.note}</span>}
        {!open && <span className="sub">{lane.tiles.map((t) => <span key={t.label} className="ep-pill" style={{ background: PILL[t.status]?.bg ?? '#f1f5f9', color: PILL[t.status]?.fg ?? '#475569', marginTop: 0 }}>{t.label} · {pretty(t.status)}</span>)}</span>}
      </button>
      {open && (
        <div className="ep-lane-b">
          {lane.tiles.length > 0 && <div className="ep-grid">{lane.tiles.map((t) => <div key={t.label} className="ep-tile"><b>{t.label}</b><Pill s={t.status} />{t.detail && <div className="d">{t.detail}</div>}</div>)}</div>}
          {lane.extra}
          {lane.actions && <div className="acts">{lane.actions}</div>}
          <NoticeBox n={notice ?? null} />
        </div>
      )}
    </div>
  );
}

type Cmd = (body: Record<string, unknown>) => Promise<void>;

/** Enrolment: the transaction type decides everything that follows. */
function EnrolForm({ busy, cmd, err }: { busy: boolean; cmd: Cmd; err: string | null }) {
  const [type, setType] = useState<TransactionType>('freehold_purchase');
  const [hasLender, setHasLender] = useState(true);
  const [hasExistingMortgage, setHasExistingMortgage] = useState(true);
  const [parties, setParties] = useState(1);
  const [consideration, setConsideration] = useState('');
  const [searches, setSearches] = useState('');
  const buyer = type === 'freehold_purchase' || type === 'leasehold_purchase';
  const seller = type === 'freehold_sale' || type === 'leasehold_sale';
  const remo = type === 'remortgage';
  const toe = type === 'transfer_of_equity';
  const NOTE: Record<TransactionType, string> = {
    freehold_purchase: 'ID/AML → searches (auto-ordered), enquiries, mortgage offer, proof of funds → title, report on title → exchange → completion → SDLT, AP1 → registered.',
    leasehold_purchase: 'As a freehold purchase, plus the management pack (LPE1), the lease review and the notice of assignment after completion.',
    freehold_sale: "ID/AML → property forms from the client, official copies, contract pack out → the buyer's enquiries answered → redemption figure → exchange → completion monies in, the lender redeemed → balance to the client → discharge → closed.",
    leasehold_sale: 'As a freehold sale, plus obtaining the management pack from the freeholder / agent for the buyer and the TA7.',
    remortgage: 'No exchange: title and the new offer investigated, redemption figure from the old lender → mortgage deed executed, certificate of title → advance in, old lender redeemed → AP1 → discharged and registered.',
    transfer_of_equity: "No exchange: every party identified, the lender's consent where charged, the clients decide how they hold (declaration of trust for tenants in common) → transfer deed executed, any consideration in → SDLT where due, AP1 → registered.",
  };
  return (
    <div className="ep">
      <style>{WORK_CSS}</style>
      <div className="ep-block">Transaction type: Every step is logged and only genuine decisions are put in front of you.</div>
      <div className="ep-enrol">
        <label>Transaction type
          <select value={type} onChange={(e) => setType(e.target.value as TransactionType)}>{TRANSACTION_TYPES.map((t) => <option key={t} value={t}>{TRANSACTION_LABEL[t]}</option>)}</select>
        </label>
        {(buyer || remo) && <label>{remo ? 'New lender' : 'Buyer has a mortgage lender'}<select value={hasLender ? 'yes' : 'no'} onChange={(e) => setHasLender(e.target.value === 'yes')}><option value="yes">Yes — lender-funded</option><option value="no">No — cash</option></select></label>}
        {(seller || remo || toe) && <label>Existing mortgage on the property<select value={hasExistingMortgage ? 'yes' : 'no'} onChange={(e) => setHasExistingMortgage(e.target.value === 'yes')}><option value="yes">Yes — charge to redeem / consent needed</option><option value="no">No — unencumbered</option></select></label>}
        {(buyer || toe) && <label>Clients (co-owners after completion)<input type="number" min={1} max={4} value={parties} onChange={(e) => setParties(Math.max(1, Number(e.target.value) || 1))} /></label>}
        {toe && <label>Consideration (£, 0 for none)<input type="number" min={0} value={consideration} onChange={(e) => setConsideration(e.target.value)} placeholder="0" /></label>}
        {(buyer || remo) && <label>Searches (comma-separated; blank = the type's defaults)<input value={searches} onChange={(e) => setSearches(e.target.value)} placeholder={buyer ? 'LLC1, CON29, DRAINAGE_WATER, ENVIRONMENTAL' : 'none by default'} /></label>}
      </div>
      <div className="ep-note" style={{ marginTop: 8 }}>{NOTE[type]}</div>
      <button className="ep-btn primary" disabled={busy} onClick={() => {
        const body: Record<string, unknown> = { type: 'enrol', transactionType: type, hasLender: buyer || remo ? hasLender : false, hasExistingMortgage: seller || remo || toe ? hasExistingMortgage : false, parties: buyer || toe ? parties : 1 };
        if (toe) body.considerationPennies = Math.round((Number(consideration) || 0) * 100);
        const list = searches.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
        if (list.length) body.requiredSearches = list;
        void cmd(body);
      }}>Enrol as {TRANSACTION_LABEL[type].toLowerCase()}</button>
      {err && <div className="ep-err">{err}</div>}
    </div>
  );
}

export function WorkPanel({ matterId, api, view, busy, err, cmd, onChanged, notice }: { matterId: string; api: Api; view: EngineView; busy: boolean; err: string | null; cmd: Cmd; onChanged?: () => void; notice?: Notice }) {
  const [pofNote, setPofNote] = useState('');
  const [pofQuestion, setPofQuestion] = useState('');
  const [enquiry, setEnquiry] = useState({ id: '', subject: '' });
  const [inbound, setInbound] = useState('');
  const [replySel, setReplySel] = useState<Record<string, boolean>>({});
  const [completionDate, setCompletionDate] = useState('');
  const [bd, setBd] = useState({ payeeKind: 'seller_solicitor', payeeRef: '', accountName: '', sortCode: '', accountNumber: '', firmName: '', sourceChannel: 'email' });
  const [payFrom, setPayFrom] = useState<Record<string, string>>({});
  const [openLanes, setOpenLanes] = useState<Record<string, boolean>>({});
  // The lane whose button was last pressed: the outcome of that press is shown there, not
  // at the foot of the page. Any click inside a lane (capture phase) sets it.
  const [activeLane, setActiveLane] = useState<string | null>(null);
  const noticeFor = (id: string): Notice => (activeLane === id ? (notice ?? (err ? { kind: 'err', text: err, at: 0 } : null)) : null);
  const s = view.state;
  if (!s.enrolled) return <EnrolForm busy={busy} cmd={cmd} err={err} />;

  const p: ProfileView = view.profile ?? { type: (s.transactionType ?? 'freehold_purchase') as TransactionType, label: 'Freehold purchase', side: 'buyer', tenure: 'freehold', hasExchange: true, stages: ['instruction', 'pre_contract', 'contract_review', 'pre_exchange', 'exchanged', 'pre_completion', 'completed', 'post_completion'], stageLabels: {}, workstreams: [], subflows: [], defaultSearches: [], counterparty: '', fundsFrom: ['lender', 'client'], registration: 'ap1', note: '', lifecycle: [], gates: ['exchange', 'completion', 'registration', 'close'] };
  const has = (ws: string) => p.workstreams.includes(ws);
  const buyer = p.side === 'buyer';
  const seller = p.side === 'seller';
  const remo = p.type === 'remortgage';
  const toe = p.type === 'transfer_of_equity';
  const leasehold = p.tenure === 'leasehold';
  const stageIdx = p.stages.indexOf(s.stage);
  const atLeast = (st: string) => p.stages.indexOf(s.stage) >= p.stages.indexOf(st);
  const openWaits = view.waits;
  const completed = !!s.completion.confirmedAt;
  const exchanged = !!s.exchange.exchangedAt;
  const closed = !!s.closedAt;
  const deeds = s.deeds ?? { mortgageDeedAt: null, certificateOfTitleAt: null, transferDeedAt: null, deedOfTrustAt: null };
  const parties = s.parties ?? 1;
  const tic = (s.clientDecisions?.ownership_basis?.decision ?? '').startsWith('tenants_in_common');
  const verified = (kind: string) => Object.values(s.bankDetails).filter((b) => b.payeeKind === kind && b.status === 'verified');
  const paidTo = (kind: string, purpose?: string) => s.payments.some((x) => x.payeeKind === kind && (!purpose || x.purpose === purpose));
  const pickAccount = (kind: string, list: ReturnType<typeof verified>) => (
    <select className="ep-input" value={payFrom[kind] ?? list[0]?.id ?? ''} onChange={(e) => setPayFrom({ ...payFrom, [kind]: e.target.value })}>
      {list.map((b) => <option key={b.id} value={b.id}>{b.details.accountName} ····{b.details.accountNumber.slice(-4)}</option>)}
    </select>
  );
  const authorise = (kind: string, purpose: 'completion_monies' | 'other', label: string, amountPennies?: number | null) => {
    const list = verified(kind);
    if (!list.length) return <span className="ep-block" style={{ display: 'inline-block', marginRight: 6 }}>No verified {pretty(kind)} bank details.</span>;
    return <span>{pickAccount(kind, list)}<button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'payment_authorised', payeeKind: kind, bankDetailsId: payFrom[kind] ?? list[0].id, purpose, amountPennies: amountPennies ?? undefined })}>{label}</button></span>;
  };
  const ask = (q: string, dflt = '') => window.prompt(q, dflt);
  const inboundOpen = Object.values(s.inboundEnquiries ?? {}).filter((q) => !q.repliedAt);
  const inboundAll = Object.values(s.inboundEnquiries ?? {}).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const red = s.redemption ?? { status: 'not_applicable' as const, lender: null, redemptionPennies: null, validUntil: null, dailyInterestPennies: null, requestedAt: null, receivedAt: null, redeemedAt: null, dischargedAt: null };
  const redemptionApplies = !!s.hasExistingMortgage && (seller || remo);
  const consent = s.lenderConsent ?? { status: 'not_applicable' as const, lender: null, conditions: null, requestedAt: null, receivedAt: null };
  const forms = s.propertyForms ?? { status: 'not_applicable' as const, forms: [], requestedAt: null, receivedAt: null, facts: null };

  const resolved = (st: string) => st === 'cleared' || st === 'reviewed';
  const lanes: LaneDef[] = [];
  const lane = (l: LaneDef | null | false) => { if (l) lanes.push(l); };

  lane({ id: 'id_aml', title: 'ID / AML', state: resolved(s.idCheck.status) ? 'done' : s.idCheck.status === 'flagged' ? 'blocked' : s.idCheck.status === 'requested' ? 'open' : 'idle', note: parties > 1 ? `${parties} clients — every party is identified` : undefined,
    tiles: [{ label: 'ID / AML check', status: s.idCheck.status }],
    actions: s.stage === 'instruction' && s.idCheck.status === 'not_started' ? <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'request_id_check' })}>Request ID / AML check</button> : null });

  if (has('source_of_funds')) {
    const pof = s.proofOfFunds;
    const st = pof?.status === 'reviewed' ? (pof.resolution === 'approve' ? 'done' : 'blocked') : pof?.status === 'submitted' ? 'blocked' : pof?.status === 'requested' ? 'open' : 'idle';
    const qs = Object.values(pof?.queries ?? {}).sort((a, b) => a.raisedAt.localeCompare(b.raisedAt) || (a.id > b.id ? 1 : -1));
    const open = qs.filter((q) => q.status === 'draft' || q.status === 'sent');
    const QCHIP: Record<string, { bg: string; fg: string }> = { draft: { bg: '#fef3c7', fg: '#78350f' }, sent: { bg: '#e0e7ff', fg: '#3730a3' }, answered: { bg: '#dcfce7', fg: '#14532d' }, withdrawn: { bg: '#f1f5f9', fg: '#94a3b8' } };
    lane({ id: 'source_of_funds', title: 'Source of funds', state: st, note: pof?.risk ? `risk ${pof.risk}${pof.approvedAt ? ` · signed off ${fmtDay(pof.approvedAt)}` : ''}` : s.requireProofOfFunds ? 'firm policy: signed off before exchange' : undefined,
      tiles: [
        { label: `Proof of funds${pof?.rounds ? ` · round ${pof.rounds}` : ''}`, status: pof?.status === 'reviewed' ? (pof.resolution === 'approve' ? 'reviewed' : pof.resolution === 'reject' ? 'rejected' : 'reviewed') : pof?.status === 'submitted' ? 'flagged' : pof?.status === 'requested' ? 'requested' : 'not_started', detail: pof?.facts ? `declared ${gbp(pof.facts.totalDeclaredPennies)}${pof.facts.requiredPennies != null ? ` of ${gbp(pof.facts.requiredPennies)} needed` : ''}${pof.facts.giftedPennies ? ' · includes a gift' : ''}` : pof?.status === 'requested' ? `form with the client since ${fmtDay(pof.requestedAt)}` : undefined },
        ...(qs.length ? [{ label: 'Queries to the client', status: open.length ? 'raised' : 'replied', detail: `${qs.length} raised · ${open.length} open` }] : []),
      ],
      extra: pof && pof.status !== 'not_started' ? (
        <div style={{ marginTop: 8 }}>
          {pof.channel === 'unsent' && pof.formUrl && (
            <div className="ep-warn" style={{ marginTop: 0, marginBottom: 8 }}>
              Not sent{pof.sendError ? ` — ${pof.sendError}` : '.'} Send the client this link: <a href={pof.formUrl} target="_blank" rel="noreferrer">{pof.formUrl}</a>
            </div>
          )}
          {(pof.statements?.length ?? 0) > 0 && <div style={{ fontSize: 12.5, marginBottom: 6 }}><b>Statements read:</b> {pof.statements!.map((x) => `${x.fileName ?? x.documentId}${x.readable ? ` (${x.holder ?? '?'}, ${x.from ?? '?'}–${x.to ?? '?'}, ${x.transactions} lines)` : ' (unreadable)'}`).join(' · ')}</div>}
          {(pof.flags?.length ?? 0) > 0 && <div style={{ fontSize: 12.5, marginBottom: 6 }}><b>Flags:</b> {pof.flags!.map((f) => f.code).join(', ')}</div>}
          {qs.length === 0 && <div className="ep-note">No queries.</div>}
          {qs.map((q) => (
            <div key={q.id} className="ep-row" style={{ display: 'block' }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <b>{q.id}</b><span className="ep-pill" style={{ background: QCHIP[q.status].bg, color: QCHIP[q.status].fg, marginTop: 0 }}>{q.status}</span><span className="ep-note">{pretty(q.flagCode.split(':')[0].toLowerCase())}{q.raisedBy === 'system' ? ' · drafted by the rules' : ' · added by a person'}</span>
                {(q.status === 'draft' || q.status === 'sent') && <button className="ep-btn" style={{ margin: '0 0 0 auto', padding: '2px 8px', fontSize: 11.5 }} disabled={busy} onClick={() => { const r = ask('Why is this query not needed? (recorded on the log)'); if (r) void cmd({ type: 'withdraw_proof_of_funds_query', queryId: q.id, reason: r }); }}>Withdraw</button>}
              </div>
              <div>{q.question}</div>
              {q.transaction && <div className="ep-note">Line: {q.transaction.date} · {q.transaction.description} · {gbp(Math.abs(q.transaction.amountPennies))}</div>}
              {q.answer != null && <div style={{ marginTop: 3, padding: '4px 8px', background: '#f0fdf4', borderRadius: 6 }}><b>Client:</b> {q.answer || '(evidence only)'}{q.answerEvidenceDocumentIds.length ? ` · ${q.answerEvidenceDocumentIds.length} document${q.answerEvidenceDocumentIds.length === 1 ? '' : 's'}` : ''}</div>}
            </div>
          ))}
          {!pof.approvedAt && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input className="ep-input" placeholder="Add a query for the client…" value={pofQuestion} onChange={(e) => setPofQuestion(e.target.value)} style={{ width: 420, maxWidth: '100%' }} />
              <button className="ep-btn" style={{ margin: 0 }} disabled={busy || pofQuestion.trim().length < 5} onClick={() => { void cmd({ type: 'raise_proof_of_funds_query', question: pofQuestion.trim() }); setPofQuestion(''); }}>Add query</button>
              {open.length > 0 && <span className="ep-note">{open.length} open — sign-off is unavailable until each is sent (query from the decision) or withdrawn with a reason.</span>}
            </div>
          )}
        </div>
      ) : null,
      actions: !exchanged && (pof?.status === 'not_started' || (pof?.status === 'reviewed' && pof.resolution !== 'approve')) ? (
        <span><input className="ep-input" placeholder="Note to the client (optional)" value={pofNote} onChange={(e) => setPofNote(e.target.value)} style={{ width: 260 }} /><button className="ep-btn primary" disabled={busy} onClick={() => { void cmd({ type: 'request_proof_of_funds', noteToClient: pofNote.trim() || null }); setPofNote(''); }}>Send proof-of-funds form</button></span>
      ) : null });
  }

  if (has('property_forms')) lane({ id: 'property_forms', title: 'Property forms (TA6 / TA10 / TA7)', state: forms.status === 'received' ? 'done' : forms.status === 'requested' ? 'open' : 'idle', note: 'from the client; the pack goes out with them',
    tiles: [{ label: `Forms${forms.forms.length ? ` · ${forms.forms.join(', ')}` : ''}`, status: forms.status, detail: forms.requestedAt && !forms.receivedAt ? `requested ${fmtDay(forms.requestedAt)} · the client is chased on the SLA` : forms.receivedAt ? `received ${fmtDay(forms.receivedAt)}` : undefined }],
    actions: <>
      {forms.status === 'not_started' && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'request_property_forms' })}>Send the forms to the client</button>}
      {forms.status !== 'received' && forms.status !== 'not_applicable' && <button className="ep-btn" disabled={busy} onClick={() => { const f = ask('Which forms came back? (comma-separated)', leasehold ? 'TA6, TA10, TA7' : 'TA6, TA10'); if (f) void cmd({ type: 'property_forms_received', forms: f.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) }); }}>Forms received</button>}
    </> });

  lane({ id: 'title', title: 'Title', state: resolved(s.title.status) ? (has('report_on_title') && s.reportOnTitle.status !== 'sent' ? 'open' : 'done') : s.title.status === 'flagged' ? 'blocked' : 'idle', note: p.tenure === 'any' ? 'freehold or leasehold' : `expected ${p.tenure}`,
    tiles: [
      { label: `Official copies${s.title.facts?.titleNumber ? ` · ${s.title.facts.titleNumber}` : ''}`, status: s.title.status, detail: s.title.facts?.tenure ?? 'file the official copy of the register under Documents' },
      ...(has('report_on_title') ? [{ label: 'Report on title', status: s.reportOnTitle.status, detail: s.reportOnTitle.sentAt ? `sent ${fmtDay(s.reportOnTitle.sentAt)}` : undefined }] : []),
    ],
    actions: has('report_on_title') ? <>
      {s.stage === 'contract_review' && ['not_started', 'rejected'].includes(s.reportOnTitle.status) && resolved(s.title.status) && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'draft_report_on_title' })}>Draft report on title (AI, needs your approval)</button>}
      {s.reportOnTitle.status === 'approved' && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'send_report_on_title' })}>Send approved report to client</button>}
    </> : null });

  if (has('searches') && s.requiredSearches.length > 0) lane({ id: 'searches', title: 'Searches', state: s.requiredSearches.every((t) => resolved(s.searches[t]?.status ?? '')) ? 'done' : s.requiredSearches.some((t) => s.searches[t]?.status === 'flagged') ? 'blocked' : 'open', note: 'ordered automatically on entry to pre-contract',
    tiles: s.requiredSearches.map((t) => ({ label: t, status: s.searches[t]?.status ?? 'not_started', detail: s.searches[t]?.flags.length ? s.searches[t].flags.map((f) => f.code).join(', ') : undefined })) });

  if (has('enquiries') && buyer) lane({ id: 'enquiries', title: 'Enquiries (ours, to the other side)', state: Object.values(s.enquiries).length === 0 ? 'idle' : Object.values(s.enquiries).every((q) => ['cleared', 'reviewed', 'withdrawn'].includes(q.status)) ? 'done' : Object.values(s.enquiries).some((q) => q.status === 'flagged') ? 'blocked' : 'open',
    tiles: Object.values(s.enquiries).map((q) => ({ label: `Enquiry ${q.enquiryId}`, status: q.status, detail: q.subject })),
    actions: (s.stage === 'pre_contract' || s.stage === 'contract_review') ? <><input className="ep-input" placeholder="Enquiry id (E3)" value={enquiry.id} onChange={(e) => setEnquiry({ ...enquiry, id: e.target.value })} style={{ width: 110 }} /><input className="ep-input" placeholder="Subject" value={enquiry.subject} onChange={(e) => setEnquiry({ ...enquiry, subject: e.target.value })} style={{ width: 220 }} /><button className="ep-btn" disabled={busy || !enquiry.id || !enquiry.subject} onClick={() => { void cmd({ type: 'raise_enquiry', enquiryId: enquiry.id.trim(), subject: enquiry.subject.trim() }); setEnquiry({ id: '', subject: '' }); }}>Raise enquiry</button></> : null });

  if (has('enquiries') && seller) lane({ id: 'enquiries', title: "Buyer's enquiries (replies we owe)", state: inboundAll.length === 0 ? (s.contractPack?.sentAt ? 'open' : 'idle') : inboundOpen.length ? 'blocked' : 'done', note: inboundAll.length ? `${inboundAll.length} received · ${inboundOpen.length} awaiting our reply` : s.contractPack?.sentAt ? "pack out — awaiting the buyer's enquiries" : 'arrive once the pack is out',
    tiles: inboundAll.map((q) => ({ label: q.id, status: q.repliedAt ? 'replied' : 'raised', detail: `round ${q.round} · ${fmtDay(q.receivedAt)}${q.repliedAt ? ` · replied ${fmtDay(q.repliedAt)}` : ''}` })),
    extra: inboundAll.length ? <div style={{ marginTop: 8 }}>{inboundAll.map((q) => (
      <div key={q.id} className="ep-row">
        {!q.repliedAt && <input type="checkbox" checked={!!replySel[q.id]} onChange={(e) => setReplySel({ ...replySel, [q.id]: e.target.checked })} />}
        <b>{q.id}</b><span style={{ flex: 1 }}>{q.question}</span><Pill s={q.repliedAt ? 'replied' : 'raised'} />
      </div>
    ))}</div> : null,
    actions: <>
      {s.contractPack?.sentAt && !exchanged && <span><input className="ep-input" placeholder="Enquiries received, one per line" value={inbound} onChange={(e) => setInbound(e.target.value)} style={{ width: 360, maxWidth: '100%' }} /><button className="ep-btn" disabled={busy || !inbound.trim()} onClick={() => { const qs = inbound.split(/\n|;/).map((x) => x.trim()).filter(Boolean).map((question) => ({ question })); void cmd({ type: 'buyer_enquiries_received', enquiries: qs }); setInbound(''); }}>Record buyer&apos;s enquiries</button></span>}
      {inboundOpen.length > 0 && <button className="ep-btn primary" disabled={busy || !Object.values(replySel).some(Boolean)} onClick={() => { const ids = Object.keys(replySel).filter((k) => replySel[k]); void cmd({ type: 'enquiry_replies_sent', enquiryIds: ids }); setReplySel({}); }}>Replies sent ({Object.values(replySel).filter(Boolean).length})</button>}
    </> });

  if (has('mortgage') && s.hasLender) lane({ id: 'mortgage', title: remo ? 'New mortgage' : 'Mortgage', state: resolved(s.mortgage.status) ? (deeds.mortgageDeedAt && deeds.certificateOfTitleAt ? 'done' : 'open') : s.mortgage.status === 'flagged' ? 'blocked' : 'open', note: s.mortgage.facts?.lender ?? undefined,
    tiles: [
      { label: 'Offer', status: s.mortgage.status },
      { label: 'Mortgage deed', status: deeds.mortgageDeedAt ? 'done' : 'not_started', detail: deeds.mortgageDeedAt ? `executed ${fmtDay(deeds.mortgageDeedAt)} (witnessed)` : undefined },
      { label: 'Certificate of title', status: deeds.certificateOfTitleAt ? 'sent' : 'not_started', detail: deeds.certificateOfTitleAt ? `sent ${fmtDay(deeds.certificateOfTitleAt)}` : undefined },
    ],
    actions: <>
      {!deeds.mortgageDeedAt && resolved(s.mortgage.status) && <button className="ep-btn" disabled={busy} onClick={() => { if (window.confirm('The client has signed the mortgage deed in the presence of a witness?')) void cmd({ type: 'mortgage_deed_executed', witnessed: true }); }}>Mortgage deed executed</button>}
      {!deeds.certificateOfTitleAt && resolved(s.mortgage.status) && <button className="ep-btn" disabled={busy} onClick={() => { const d = ask('Completion date on the certificate (YYYY-MM-DD):', s.exchange.completionDate ?? s.targetCompletionDate ?? ''); if (d !== null) void cmd({ type: 'certificate_of_title_sent', completionDate: d || undefined }); }}>Certificate of title sent</button>}
      {['pre_contract', 'contract_review', 'pre_exchange'].includes(s.stage) && resolved(s.mortgage.status) && buyer && <button className="ep-btn" disabled={busy} onClick={() => { const r = ask('Why was the offer withdrawn / lapsed?'); if (r) void cmd({ type: 'mortgage_offer_withdrawn', reason: r }); }}>Offer withdrawn</button>}
    </> });

  if (has('redemption') && redemptionApplies) lane({ id: 'redemption', title: 'Redemption of the existing mortgage', state: red.status === 'redeemed' || red.status === 'discharged' ? 'done' : red.status === 'received' ? (completed ? 'open' : 'done') : red.status === 'requested' ? 'open' : 'blocked', note: red.lender ?? undefined,
    tiles: [
      { label: 'Redemption statement', status: red.status, detail: red.redemptionPennies != null ? `${gbp(red.redemptionPennies)}${red.validUntil ? ` · valid to ${red.validUntil}` : ''}${red.dailyInterestPennies ? ` · ${gbp(red.dailyInterestPennies)}/day` : ''}` : undefined },
      { label: 'Payment to the lender', status: paidTo('lender') ? 'approved' : 'not_started', detail: 'authorised by a person against verified lender details (hard stop)' },
      { label: 'Redeemed', status: red.status === 'redeemed' || red.status === 'discharged' ? 'redeemed' : 'not_started', detail: red.redeemedAt ? fmtDay(red.redeemedAt) : undefined },
    ],
    actions: <>
      {red.status === 'not_started' && <button className="ep-btn primary" disabled={busy} onClick={() => { const l = ask('Lender?', red.lender ?? ''); if (l !== null) void cmd({ type: 'request_redemption_statement', lender: l || undefined }); }}>Request redemption statement</button>}
      {(red.status === 'not_started' || red.status === 'requested') && <button className="ep-btn" disabled={busy} onClick={() => { const amt = ask('Redemption figure (£):'); if (amt === null) return; const until = ask('Valid until (YYYY-MM-DD, optional):', '') ?? ''; void cmd({ type: 'redemption_statement_received', redemptionPennies: Math.round(Number(amt) * 100) || undefined, validUntil: until || undefined }); }}>Statement received</button>}
      {red.status === 'received' && atLeast('pre_completion') && !paidTo('lender') && authorise('lender', 'other', 'Authorise redemption payment', red.redemptionPennies)}
      {red.status === 'received' && completed && paidTo('lender') && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'mortgage_redeemed' })}>Mortgage redeemed</button>}
    </> });

  if (has('lender_consent') && s.hasExistingMortgage) lane({ id: 'lender_consent', title: "Lender's consent to the transfer", state: consent.status === 'received' ? 'done' : consent.status === 'requested' ? 'open' : 'blocked', note: consent.lender ?? undefined,
    tiles: [{ label: 'Consent', status: consent.status, detail: consent.conditions ?? undefined }],
    actions: <>
      {consent.status === 'not_started' && <button className="ep-btn primary" disabled={busy} onClick={() => { const l = ask('Lender?'); if (l !== null) void cmd({ type: 'request_lender_consent', lender: l || undefined }); }}>Request consent</button>}
      {consent.status !== 'received' && consent.status !== 'not_applicable' && <button className="ep-btn" disabled={busy} onClick={() => { const c = ask('Conditions of consent (optional):', ''); if (c !== null) void cmd({ type: 'lender_consent_received', conditions: c || undefined }); }}>Consent received</button>}
    </> });

  if (has('co_ownership') && parties > 1) lane({ id: 'co_ownership', title: `Co-ownership · ${parties} clients`, state: !s.clientDecisions?.ownership_basis ? 'blocked' : tic && !deeds.deedOfTrustAt ? 'open' : 'done', note: "the clients' decision, advised separately where their interests differ",
    tiles: [
      { label: 'How they hold', status: s.clientDecisions?.ownership_basis ? 'done' : 'not_started', detail: s.clientDecisions?.ownership_basis ? `${pretty(s.clientDecisions.ownership_basis.decision)} · ${fmtDay(s.clientDecisions.ownership_basis.at)}${s.clientDecisions.ownership_basis.note ? ` · ${s.clientDecisions.ownership_basis.note}` : ''}` : undefined },
      ...(tic ? [{ label: 'Declaration of trust', status: deeds.deedOfTrustAt ? 'done' : 'not_started', detail: deeds.deedOfTrustAt ? `executed ${fmtDay(deeds.deedOfTrustAt)}` : undefined }] : []),
    ],
    actions: <>
      {!completed && ['joint_tenants', 'tenants_in_common_equal', 'tenants_in_common_unequal'].map((d) => (
        <button key={d} className={`ep-btn${!s.clientDecisions?.ownership_basis ? ' primary' : ''}`} disabled={busy || s.clientDecisions?.ownership_basis?.decision === d} onClick={() => { const n = ask(`Record the clients' instruction to hold as ${pretty(d)} (how / when):`); if (n !== null) void cmd({ type: 'client_decision_recorded', subject: 'ownership_basis', decision: d, note: n || null }); }}>{pretty(d)}</button>
      ))}
      {tic && !deeds.deedOfTrustAt && <button className="ep-btn primary" disabled={busy} onClick={() => { const names = ask('Parties who signed (comma-separated):'); if (!names) return; const shares = ask('Shares (e.g. 60/40, optional):', '') ?? ''; void cmd({ type: 'deed_of_trust_executed', parties: names.split(',').map((x) => x.trim()).filter(Boolean), shares: shares || undefined }); }}>Declaration of trust executed</button>}
    </> });

  if (has('survey') && s.survey && s.survey.status !== 'not_started') lane({ id: 'survey', title: 'Survey / physical condition', state: s.survey.status === 'client_satisfied' ? 'done' : s.survey.status === 'further_investigation' || s.survey.status === 'client_renegotiating' ? 'blocked' : 'open', note: `${s.survey.reports.length} report${s.survey.reports.length === 1 ? '' : 's'} on file`,
    tiles: [{ label: "Client's view", status: s.survey.status === 'client_satisfied' ? 'done' : s.survey.status }],
    actions: !exchanged && s.survey.status !== 'client_satisfied' ? <>
      <button className="ep-btn primary" disabled={busy || s.survey.status === 'further_investigation'} title={s.survey.status === 'further_investigation' ? 'Further investigation is outstanding' : ''} onClick={() => { const n = ask('The client confirms they are satisfied with the physical condition — record their instruction (date / channel):'); if (n !== null) void cmd({ type: 'client_decision_recorded', subject: 'physical_condition', decision: 'satisfied', note: n || null }); }}>Client satisfied with the property</button>
      <button className="ep-btn" disabled={busy} onClick={() => { const n = ask('The client wants to renegotiate — what did they say?'); if (n) void cmd({ type: 'client_decision_recorded', subject: 'physical_condition', decision: 'renegotiate', note: n }); }}>Client wants to renegotiate</button>
    </> : null });

  if (has('leasehold')) lane({ id: 'leasehold', title: 'Leasehold', state: resolved(s.managementPack?.status ?? '') ? (buyer && completed && !s.postCompletion.noticeOfAssignmentAt ? 'open' : 'done') : s.managementPack?.status === 'flagged' ? 'blocked' : s.managementPack?.status === 'requested' ? 'open' : 'idle', note: seller ? 'the pack is obtained from the freeholder / agent for the buyer' : 'LPE1 reviewed as client-advice points',
    tiles: [
      { label: 'Management pack (LPE1)', status: s.managementPack?.status ?? 'not_started' },
      ...(buyer ? [{ label: 'Notice of assignment', status: s.postCompletion.noticeOfAssignmentAt ? 'sent' : 'not_started' }] : []),
    ],
    actions: <>
      {['pre_contract', 'contract_review', 'pre_exchange'].includes(s.stage) && s.managementPack?.status === 'not_started' && <button className="ep-btn primary" disabled={busy} onClick={() => { const from = ask('Requested from?', seller ? 'Freeholder / managing agent' : "Seller's solicitor"); if (from) void cmd({ type: 'management_pack_requested', from }); }}>Management pack requested</button>}
      {buyer && completed && !s.postCompletion.noticeOfAssignmentAt && <button className="ep-btn" disabled={busy} onClick={() => { const on = ask('Notice of assignment served on?', 'Landlord / managing agent'); if (on) void cmd({ type: 'notice_of_assignment_served', servedOn: on }); }}>Notice of assignment served</button>}
    </> });

  if (p.hasExchange) lane({ id: 'exchange', title: seller ? 'Contract pack & exchange' : 'Contract & exchange', state: exchanged ? 'done' : s.stage === 'pre_exchange' ? (s.exchange.conditionsMet ? 'open' : 'blocked') : 'idle', note: exchanged ? `exchanged ${fmtDay(s.exchange.exchangedAt)} · completion ${s.exchange.completionDate}` : s.targetExchangeDate ? `target exchange ${fmtDay(s.targetExchangeDate)}` : undefined,
    tiles: [
      ...(seller ? [{ label: 'Contract pack', status: s.contractPack?.sentAt ? 'sent' : 'not_started', detail: s.contractPack?.sentAt ? `sent ${fmtDay(s.contractPack.sentAt)}` : undefined }] : []),
      ...(buyer ? [{ label: 'Deposit', status: s.deposit.received ? 'received' : 'awaiting' }] : []),
      { label: 'Contract approved / signed', status: s.readiness.signedContractHeldAt ? 'done' : s.readiness.contractApprovedAt ? 'approved' : 'not_started', detail: 'readiness milestones (advisory)' },
      ...(s.requireExchangeAuthority ? [{ label: "Client's authority to exchange", status: s.clientDecisions?.exchange_authority?.decision === 'authorised' ? 'done' : 'not_started' }] : []),
      { label: 'Exchange', status: exchanged ? 'done' : s.exchange.conditionsMet ? 'approved' : 'awaiting', detail: exchanged ? undefined : s.exchange.conditionsMet ? 'conditions met — exchange when instructed' : 'conditions derive from the gates' },
      ...(exchanged ? [{ label: 'Completion statement', status: s.completion.statementGeneratedAt ? 'done' : 'not_started' }] : []),
    ],
    actions: <>
      {seller && !s.contractPack?.sentAt && atLeast('pre_contract') && <button className="ep-btn primary" disabled={busy || forms.status !== 'received' || s.title.status === 'awaiting'} title={forms.status !== 'received' ? 'The property forms are not in' : s.title.status === 'awaiting' ? 'Official copies are not on file' : ''} onClick={() => cmd({ type: 'contract_pack_sent' })}>Contract pack sent</button>}
      {['contract_review', 'pre_exchange'].includes(s.stage) && !s.readiness.contractApprovedAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'contract_approved' })}>Contract approved</button>}
      {['contract_review', 'pre_exchange'].includes(s.stage) && !s.readiness.signedContractHeldAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'signed_contract_held' })}>Signed contract held</button>}
      {buyer && ['contract_review', 'pre_exchange'].includes(s.stage) && !s.deposit.received && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'deposit_received' })}>Deposit received</button>}
      {!exchanged && s.requireExchangeAuthority && s.clientDecisions?.exchange_authority?.decision !== 'authorised' && ['contract_review', 'pre_exchange'].includes(s.stage) && <button className="ep-btn primary" disabled={busy} onClick={() => { const n = ask("Record the client's authority to exchange (how and when they instructed you):"); if (n !== null) void cmd({ type: 'client_decision_recorded', subject: 'exchange_authority', decision: 'authorised', note: n || null }); }}>Client authorises exchange</button>}
      {s.stage === 'pre_exchange' && s.exchange.conditionsMet && !exchanged && <span><input className="ep-input" type="date" value={completionDate} onChange={(e) => setCompletionDate(e.target.value)} /><button className="ep-btn primary" disabled={busy || !completionDate} onClick={() => cmd({ type: 'contracts_exchanged', completionDate })}>Contracts exchanged</button></span>}
      {s.stage === 'exchanged' && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'completion_statement_generated' })}>Completion statement generated</button>}
      {exchanged && !completed && <button className="ep-btn" disabled={busy} onClick={() => { const d = ask('New contractual completion date (YYYY-MM-DD):', s.exchange.completionDate ?? ''); if (d) { const r = ask('Reason?'); if (r) void cmd({ type: 'change_completion_date', completionDate: d, reason: r }); } }}>Change completion date</button>}
    </> });

  if (toe || buyer) lane({ id: 'transfer_deed', title: 'Transfer deed (TR1)', state: deeds.transferDeedAt ? 'done' : toe && s.stage === 'pre_completion' ? 'blocked' : 'idle', note: buyer ? 'advisory on a purchase: signed with the contract in practice' : 'every party signs, witnessed',
    tiles: [{ label: 'Transfer deed', status: deeds.transferDeedAt ? 'done' : 'not_started', detail: deeds.transferDeedAt ? `executed ${fmtDay(deeds.transferDeedAt)}` : undefined }],
    actions: !deeds.transferDeedAt && !completed ? <button className={`ep-btn${toe ? ' primary' : ''}`} disabled={busy} onClick={() => { const names = ask('Parties who signed (comma-separated):'); if (names) void cmd({ type: 'transfer_deed_executed', parties: names.split(',').map((x) => x.trim()).filter(Boolean), witnessed: true }); }}>Transfer deed executed</button> : null });

  {
    const firm = verified('firm_client_account');
    const needsRequest = p.fundsFrom.includes('lender') || p.fundsFrom.includes('client');
    lane({ id: 'completion', title: 'Completion & money', state: completed ? (seller && !paidTo('client') ? 'open' : 'done') : s.stage === 'pre_completion' ? 'open' : 'idle', note: completed ? `completed ${fmtDay(s.completion.confirmedAt)}` : p.fundsFrom.length ? `money from: ${p.fundsFrom.map((f) => pretty(f)).join(', ')}` : undefined,
      tiles: [
        ...(p.fundsFrom.includes('lender') ? [{ label: remo ? 'Advance from the new lender' : 'Lender funds', status: s.completion.fundsReceivedAt ? 'received' : openWaits.some((w) => w.key === 'funds' && w.subject === 'lender') ? 'requested' : 'not_started' }] : []),
        ...(p.fundsFrom.includes('client') ? [{ label: "Client's balance", status: s.completion.fundsReceivedAt ? 'received' : openWaits.some((w) => w.key === 'funds' && w.subject === 'client') ? 'requested' : 'not_started' }] : []),
        ...(p.fundsFrom.includes('buyer_solicitor') ? [{ label: "Completion monies from the buyer's solicitor", status: s.completion.fundsReceivedAt ? 'received' : 'awaiting' }] : []),
        ...(p.fundsFrom.includes('incoming_owner') && (s.considerationPennies ?? 0) > 0 ? [{ label: `Consideration from the incoming owner · ${gbp(s.considerationPennies)}`, status: s.completion.fundsReceivedAt ? 'received' : 'awaiting' }] : []),
        ...(buyer ? [{ label: "Completion payment to the seller's solicitor", status: paidTo('seller_solicitor', 'completion_monies') ? 'approved' : 'not_started', detail: 'authorised by a person against verified details (hard stop)' }] : []),
        { label: 'Completion', status: completed ? 'done' : 'not_started', detail: completed ? fmtDay(s.completion.confirmedAt) : undefined },
        ...(seller && completed ? [{ label: 'Balance to the client', status: paidTo('client') ? 'approved' : 'not_started' }] : []),
      ],
      actions: s.stage === 'pre_completion' && !completed ? <>
        {needsRequest && firm.length === 0 && !s.completion.fundsReceivedAt && <span className="ep-block" style={{ display: 'inline-block', marginRight: 6 }}>Firm client-account details not verified.</span>}
        {needsRequest && firm.length > 0 && !s.completion.fundsReceivedAt && pickAccount('firm_client_account', firm)}
        {p.fundsFrom.includes('lender') && firm.length > 0 && s.hasLender && !openWaits.some((w) => w.key === 'funds' && w.subject === 'lender') && !s.completion.fundsReceivedAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'funds_requested', fromRole: 'lender', bankDetailsId: payFrom.firm_client_account ?? firm[0].id })}>Request {remo ? 'the advance' : 'lender funds'}</button>}
        {p.fundsFrom.includes('client') && firm.length > 0 && !openWaits.some((w) => w.key === 'funds' && w.subject === 'client') && !s.completion.fundsReceivedAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'funds_requested', fromRole: 'client', bankDetailsId: payFrom.firm_client_account ?? firm[0].id })}>Request client funds</button>}
        {openWaits.filter((w) => w.key === 'funds').map((w) => <button key={w.subject} className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'funds_received', fromRole: w.subject })}>{pretty(w.subject)} funds received</button>)}
        {p.fundsFrom.includes('buyer_solicitor') && !s.completion.fundsReceivedAt && <button className="ep-btn primary" disabled={busy} onClick={() => { const amt = ask('Amount received (£):'); if (amt !== null) void cmd({ type: 'funds_received', fromRole: 'buyer_solicitor', amountPennies: Math.round(Number(amt) * 100) || undefined }); }}>Completion monies received from the buyer&apos;s solicitor</button>}
        {p.fundsFrom.includes('incoming_owner') && (s.considerationPennies ?? 0) > 0 && !s.completion.fundsReceivedAt && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'funds_received', fromRole: 'incoming_owner', amountPennies: s.considerationPennies })}>Consideration received</button>}
        {buyer && !paidTo('seller_solicitor', 'completion_monies') && authorise('seller_solicitor', 'completion_monies', 'Authorise completion payment')}
        <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'completion_confirmed' })}>Completion confirmed</button>
      </> : seller && completed && !paidTo('client') ? authorise('client', 'other', 'Authorise balance to the client') : null });
  }

  lane({ id: 'registration', title: p.registration === 'ap1' ? 'Registration' : 'Discharge & close', state: closed ? 'done' : atLeast('completed') ? 'open' : 'idle', note: p.registration === 'ap1' ? 'SDLT within 14 days; AP1 within the priority period' : "the buyer's solicitor registers; we see the charge discharged and close",
    tiles: [
      ...(p.registration === 'ap1' && (buyer || toe) ? [{ label: 'SDLT', status: s.postCompletion.sdltSubmittedAt ? 'sent' : s.sdltNotRequiredAt ? 'not_required' : 'not_started' }] : []),
      ...(p.registration === 'ap1' ? [{ label: 'AP1', status: s.postCompletion.ap1ConfirmedAt ? 'done' : s.postCompletion.ap1SubmittedAt ? 'requested' : 'not_started', detail: s.postCompletion.ap1ConfirmedAt ? `registered ${fmtDay(s.postCompletion.ap1ConfirmedAt)}` : undefined }] : []),
      ...(redemptionApplies ? [{ label: 'Discharge (DS1 / e-DS1)', status: red.status === 'discharged' ? 'discharged' : red.status === 'redeemed' ? 'awaiting' : 'not_started' }] : []),
      { label: 'File', status: closed ? 'done' : 'not_started', detail: closed ? `closed ${fmtDay(s.closedAt)}` : undefined },
    ],
    actions: atLeast('completed') && !closed ? <>
      {p.registration === 'ap1' && !s.postCompletion.sdltSubmittedAt && !s.sdltNotRequiredAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'sdlt_submitted' })}>SDLT submitted</button>}
      {p.registration === 'ap1' && !s.postCompletion.sdltSubmittedAt && !s.sdltNotRequiredAt && <button className="ep-btn" disabled={busy} onClick={() => { const r = ask('Why is no SDLT return due? (recorded as your determination)'); if (r) void cmd({ type: 'sdlt_not_required', reason: r }); }}>No SDLT return due</button>}
      {p.registration === 'ap1' && !s.postCompletion.ap1SubmittedAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'ap1_submitted' })}>AP1 submitted</button>}
      {p.registration === 'ap1' && s.postCompletion.ap1SubmittedAt && !s.postCompletion.ap1ConfirmedAt && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'ap1_confirmed' })}>Registration confirmed</button>}
      {redemptionApplies && red.status === 'redeemed' && <button className="ep-btn primary" disabled={busy} onClick={() => { const ref = ask('Lender reference (optional):', '') ?? ''; void cmd({ type: 'discharge_confirmed', reference: ref || undefined }); }}>Discharge confirmed</button>}
      {s.stage === 'post_completion' && <button className="ep-btn" disabled={busy} onClick={() => { if (window.confirm('Close the file? Nothing further can be recorded except corrections.')) void cmd({ type: 'close_matter' }); }}>Close file</button>}
    </> : null });

  const isOpen = (l: LaneDef) => openLanes[l.id] ?? (l.state === 'open' || l.state === 'blocked');
  const toggle = (l: LaneDef) => setOpenLanes((o) => ({ ...o, [l.id]: !isOpen(l) }));

  return (
    <div className="ep" onClickCapture={(e) => { const l = (e.target as HTMLElement).closest('[data-lane]'); if (l) setActiveLane(l.getAttribute('data-lane')); }}>
      <style>{WORK_CSS}</style>
      <div className="ep-steps">
        {p.stages.map((st, i) => (
          <span key={st} className={`ep-step${i < stageIdx ? ' done' : i === stageIdx ? ' now' : ''}`} title={s.stageHistory.find((h) => h.stage === st) ? `entered ${fmtWhen(s.stageHistory.find((h) => h.stage === st)!.at)}` : ''}>{stageLabel(st, p)}</span>
        ))}
        {closed && <span className="ep-step done">Closed</span>}
      </div>
      {s.manualHandling.required && <div className="ep-err">Manual handling required: {pretty(s.manualHandling.reason ?? '')}. Automation is paused on this case.</div>}
      {view.blockers.length > 0 && <div className="ep-block"><b>Before the next phase:</b> {view.blockers.join(' · ')}</div>}

      {openWaits.length > 0 && (
        <>
          <div className="ep-sec">Waiting on others</div>
          <div className="ep-grid">
            {openWaits.map((w) => (
              <div key={`${w.key}:${w.subject}`} className="ep-tile">
                <b>{pretty(w.key)}{w.subject ? ` · ${w.subject}` : ''}</b>
                <span className="d">since {fmtDay(w.openedAt)} ({daysAgo(w.openedAt)}d) · chased {w.chasesSentAt.length}× {w.escalations.some((e) => !e.resolvedAt) ? '· escalated' : ''}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="ep-sec">Decisions waiting on you ({view.pendingDecisions.length})</div>
      <DecisionFeed api={api} matterId={matterId} compact onResolved={onChanged} />

      <div className="ep-sec">Work by workstream · {p.label}{p.counterparty ? ` · other side: ${p.counterparty}` : ''}</div>
      <div className="ep-over">
        {lanes.map((l) => (
          <button key={l.id} type="button" className={isOpen(l) ? 'on' : ''} onClick={() => { toggle(l); document.getElementById(`lane-${l.id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }}>
            <b>{l.title}</b>
            <span className="st ep-pill" style={{ background: LANE_STATE[l.state].bg, color: LANE_STATE[l.state].fg }}>{l.state}</span>
            <div className="n">{l.tiles.filter((t) => ['cleared', 'reviewed', 'done', 'sent', 'received', 'discharged', 'redeemed', 'replied', 'verified', 'approved'].includes(t.status)).length} of {l.tiles.length} sub-blocks done</div>
          </button>
        ))}
      </div>
      {lanes.map((l) => <Lane key={l.id} lane={l} open={isOpen(l)} onToggle={() => toggle(l)} notice={noticeFor(l.id)} />)}

      {/* ── Money: payee bank details ── */}
      <div className="ep-sec">Money · payee bank details (versioned · every change is a hard stop)</div>
      <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }} data-lane="money">
        {Object.values(s.bankDetails).length === 0 && <div className="ep-note">No bank details on file.</div>}
        {Object.values(s.bankDetails).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).map((b) => (
          <div key={b.id} className="ep-row">
            <b style={{ minWidth: 150 }}>{pretty(b.payeeKind)}{b.payeeRef ? ` · ${b.payeeRef}` : ''}</b>
            <span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{b.details.sortCode.replace(/(\d{2})(\d{2})(\d{2})/, '$1-$2-$3')} ····{b.details.accountNumber.slice(-4)}</span>
            <span>{b.details.accountName}</span>
            <Pill s={b.status === 'unverified' ? 'unverified' : b.status} />
            <span className="ep-note">via {b.sourceChannel} {fmtDay(b.recordedAt)}{b.verificationMethod ? ` · verified by ${pretty(b.verificationMethod)}${b.verificationRef ? ` (${b.verificationRef})` : ''}` : ''}</span>
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
        <NoticeBox n={noticeFor('money')} />
        {s.payments.length > 0 && <div style={{ marginTop: 8, fontSize: 12.5 }}><b>Payments authorised:</b> {s.payments.map((x) => `${pretty(x.purpose)} → ${pretty(x.payeeKind)}${x.amountPennies ? ` ${gbp(x.amountPennies)}` : ''} (${fmtDay(x.at)})`).join(' · ')}</div>}
      </div>

      <div className="ep-sec">Case</div>
      <div data-lane="case">
        {!s.manualHandling.required && !closed && <button className="ep-btn" disabled={busy} onClick={() => { const reason = ask('Why does this case need manual handling?'); if (reason) void cmd({ type: 'mark_manual_handling', reason }); }}>Take over manually</button>}
        {!completed && !s.abandoned && <button className="ep-btn" disabled={busy} onClick={() => { const reason = ask('Abandonment reason (client_withdrew, seller_withdrew, chain_collapsed, gazumped, survey, finance_failed, conflict, other):', 'client_withdrew'); if (reason) { const detail = ask('Detail (optional):', '') ?? ''; void cmd({ type: 'abandon_matter', reason, detail: detail || null }); } }}>Abandon case</button>}
      </div>
      <NoticeBox n={noticeFor('case')} />
      {err && !activeLane && <div className="ep-err">{err}</div>}
    </div>
  );
}

export { Pill as WorkPill };
export type { EngineState as WorkState };
