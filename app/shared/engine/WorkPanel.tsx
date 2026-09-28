'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DecisionFeed } from './DecisionFeed';
import { TRANSACTION_LABEL, TRANSACTION_TYPES, fmtDay, fmtWhen, pretty, stageLabel, type Api, type CaseDocument, type CompletionContract, type EngineState, type EngineView, type ProfileView, type TaskContextView, type TransactionType } from './types';
import { CompletionSheet } from './CompletionSheet';
import { ClientDecisionSheet } from './ClientDecisionSheet';
import { AlertTriangle, Check, CheckCircle, Circle, Clock, FileText, Lock, User, Zap } from '@/app/shared/icons';

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
.ep-shapes{display:flex;flex-wrap:wrap;gap:6px 14px;grid-column:1 / -1}
.ep-shape{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:#0f172a;cursor:pointer}
.ep-shape input{width:15px;height:15px;margin:0;accent-color:#5A27E0}
.ep-step{padding:5px 9px;border-radius:999px;font-size:11.5px;font-weight:700;border:1px solid #e2e8f0;color:#94a3b8;background:#fff}
.ep-step.done{background:#f0fdf4;border-color:#86efac;color:#14532d}
.ep-step.now{background:#0f172a;border-color:#0f172a;color:#fff}
.ep-sec{font-size:13px;font-weight:800;color:#0f172a;margin:14px 0 6px;line-height:1.3}
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
.ep-flow{position:relative;border:1px solid #eef1f5;border-radius:16px;overflow:hidden;background:#fff}
.ep-flow > svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1}
.ep-tier{position:relative;padding:26px 18px 34px;background:#fff}
.ep-tier:nth-child(even){background:#f8fafc}
.ep-tier + .ep-tier{border-top:1px solid #eef1f5}
.ep-tier-l{position:absolute;z-index:6;right:14px;bottom:9px;display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#94a3b8;white-space:nowrap;background:#fff;border:1px solid #e6e8ee;border-radius:999px;padding:3px 10px}
.ep-tier-l i{width:7px;height:7px;border-radius:99px;display:inline-block}
.ep-tier-l.done{color:#15803d}
.ep-tier-l.blocked{color:#b91c1c}
.ep-tier-l.open{color:#b45309}
.ep-tier-b{position:relative;z-index:2;display:flex;flex-wrap:nowrap;justify-content:center;gap:14px;align-items:flex-start}
.ep-tier-b .ep-box{flex:1 1 200px;min-width:0;max-width:220px}
.ep-tier-b .ep-box.on{flex:1.6 1 300px;max-width:340px}
.ep-box{position:relative;border:1px solid #e6e8ee;border-left-width:4px;border-radius:12px;background:#fff;min-width:0;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.ep-box.done{border-left-color:#16a34a}
.ep-box.open{border-left-color:#f59e0b}
.ep-box.blocked{border-left-color:#dc2626}
.ep-box.idle{border-left-color:#cbd5e1;background:#fcfcfd}
.ep-box.idle .ep-box-t{color:#64748b}
.ep-box.on{border-color:#5A27E0;border-left-color:#5A27E0;box-shadow:0 0 0 3px #ede9fe,0 6px 20px rgba(15,23,42,.08)}
.ep-box-h{display:grid;gap:8px;padding:11px 12px 11px 11px;cursor:pointer;border:0;background:none;width:100%;text-align:left;font-family:inherit;color:inherit;border-radius:12px}
.ep-box-h:hover{background:#fafafa}
.ep-box-t{display:flex;align-items:flex-start;gap:8px;font-size:13px;font-weight:700;line-height:1.3;color:#0f172a}
.ep-box-t .ic{flex-shrink:0;display:flex;margin-top:1px}
.ep-legend{display:flex;justify-content:flex-end;align-items:center;gap:12px;margin:4px 2px 0;font-size:10.5px;color:#94a3b8;white-space:nowrap;overflow:hidden}
.ep-legend span{display:inline-flex;align-items:center;gap:4px}
.ep-legend .ep-who{width:16px;height:16px;margin:0;pointer-events:none}
.ep-box-m{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;font-weight:600;white-space:nowrap}
.ep-box-m .n{color:#64748b;font-variant-numeric:tabular-nums;font-weight:600}
.ep-bar{height:4px;border-radius:99px;background:#eef1f5;overflow:hidden}
.ep-bar i{display:block;height:100%;border-radius:99px}
.ep-box-b{border-top:1px solid #f1f5f9;padding:6px 12px 12px 11px}
.ep-sub{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;align-items:center;padding:7px 0;border-top:1px solid #f8fafc;font-size:12.5px}
.ep-sub:first-child{border-top:0}
.ep-sub b{font-weight:600;font-size:12.5px;min-width:0}
.ep-sub .ep-pill{margin-top:0;justify-self:end;max-width:100%;white-space:normal;text-align:right}
.ep-sub b{overflow-wrap:anywhere}
.ep-sub .d{grid-column:1 / -1;font-size:11.5px;color:#64748b;line-height:1.4}
.ep-sub .a{grid-column:1 / -1;display:flex;gap:6px;align-items:center;margin-top:4px}
.ep-sub .a .ep-btn{margin:0;padding:3px 10px;font-size:12px}
.ep-sub-a{color:#5A27E0;text-decoration:none}
.ep-sub-a:hover{text-decoration:underline}
.ep-i{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:99px;border:1px solid #cbd5e1;color:#94a3b8;font-size:9.5px;font-weight:800;font-style:normal;margin-left:6px;vertical-align:1px;cursor:help}
.ep-i:hover,.ep-i:focus{border-color:#5A27E0;color:#5A27E0;outline:none}
.ep-tip{position:fixed;width:264px;background:#0f172a;color:#fff;font-size:11.5px;font-weight:500;line-height:1.45;padding:8px 10px;border-radius:8px;box-shadow:0 8px 24px rgba(15,23,42,.25);z-index:1000;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.ep-seq{position:relative;padding-left:22px;margin-top:2px}
.ep-seq::before{content:'';position:absolute;left:8px;top:10px;bottom:16px;width:2px;background:#e2e8f0}
.ep-seq .ep-sub{padding:7px 0 7px 4px}
.ep-seq .ep-sub::before{display:none}
.ep-n{position:absolute;left:-22px;top:9px;width:18px;height:18px;border-radius:99px;background:#fff;border:2px solid #cbd5e1;color:#64748b;font-size:10px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}
.ep-sub.done .ep-n{border-color:#16a34a;background:#16a34a;color:#fff}
.ep-sub.gate{margin-top:6px;padding-top:9px;border-top:1px dashed #ddd6fe;background:linear-gradient(90deg,#faf8ff,transparent);border-radius:6px}
.ep-sub.gate > b{color:#4c1d95;font-weight:800}
.ep-sub.gate .ep-n{border-color:#5A27E0;color:#5A27E0}
.ep-sub.gate.done .ep-n{background:#5A27E0;color:#fff}
.ep-who{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:99px;background:#ede9fe;color:#5A27E0;margin-left:6px;vertical-align:-3px;cursor:help}
.ep-who:hover,.ep-who:focus{background:#5A27E0;color:#fff;outline:none}
.ep-who.doc{background:#e0e7ff;color:#3730a3}
.ep-who.doc:hover,.ep-who.doc:focus{background:#3730a3;color:#fff}
.ep-tip .k{display:inline-block;min-width:44px;font-weight:800;color:#c4b5fd;margin-right:4px}
.ep-junction{position:absolute;z-index:2;transform:translate(-50%,-50%);display:flex}
.ep-junction .ep-who{margin:0;width:22px;height:22px;background:#fff;border:2px solid #5A27E0;color:#5A27E0;box-shadow:0 1px 3px rgba(15,23,42,.12)}
.ep-junction.auto .ep-who{border-color:#94a3b8;color:#64748b}
.ep-junction .ep-who:hover,.ep-junction .ep-who:focus{background:#5A27E0;color:#fff}
.ep-junction.auto .ep-who:hover,.ep-junction.auto .ep-who:focus{background:#64748b;border-color:#64748b;color:#fff}
.ep-tree{position:relative;padding-left:14px;margin-top:2px}
.ep-tree::before{content:'';position:absolute;left:4px;top:6px;bottom:14px;width:1px;background:#e2e8f0}
.ep-sub{position:relative}
.ep-sub::before{content:'';position:absolute;left:-10px;top:15px;width:8px;height:1px;background:#e2e8f0}
.ep-sub.d1{margin-left:18px}
.ep-sub.d1::before{left:-14px;width:12px}
.ep-sub.d1 b{font-weight:500;color:#334155}
.ep-box-b .acts{display:grid;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid #f1f5f9}
.ep-box-b .acts .ep-btn{margin:0;width:100%;text-align:center}
.ep-box-b .acts > span{display:contents}
.ep-veil{position:fixed;inset:0;background:rgba(15,23,42,.38);z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:64px 16px 16px;overflow-y:auto}
.ep-veil .cs{margin:0;width:100%;max-width:680px;background:#fff;border-color:#e6e8ee;border-radius:14px;padding:18px 22px;box-shadow:0 24px 64px rgba(15,23,42,.24)}
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
  awaiting_sign_off: { bg: '#e0e7ff', fg: '#3730a3' },
  awaiting: { bg: '#f1f5f9', fg: '#475569' },
  returned: { bg: '#e0e7ff', fg: '#3730a3' },
  extracted: { bg: '#e0e7ff', fg: '#3730a3' },
  replied: { bg: '#e0e7ff', fg: '#3730a3' },
  received: { bg: '#e0e7ff', fg: '#3730a3' },
  drafted: { bg: '#fef3c7', fg: '#78350f' },
  approved: { bg: '#e0e7ff', fg: '#3730a3' },
  sent: { bg: '#dcfce7', fg: '#14532d' },
  read: { bg: '#dcfce7', fg: '#14532d' },
  partly_read: { bg: '#fef3c7', fg: '#78350f' },
  not_read: { bg: '#f1f5f9', fg: '#94a3b8' },
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
const cap = (s: string) => { const w = pretty(s); return w.charAt(0).toUpperCase() + w.slice(1); };
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'we', 'with']);
/** "Source of funds" → "Source of Funds"; words already carrying capitals or digits (ID, TA6, LPE1) are left alone. */
export const titleCase = (s: string) => s.split(' ').map((w, i) => (i > 0 && SMALL.has(w) ? w : /[A-Z0-9]/.test(w.slice(1)) ? w : w.replace(/^([^A-Za-z]*)([a-z])/, (_m, a: string, b: string) => a + b.toUpperCase()))).join(' ');
const Pill = ({ s }: { s: string }) => <span className="ep-pill" style={{ background: PILL[s]?.bg ?? '#f1f5f9', color: PILL[s]?.fg ?? '#475569' }}>{cap(s)}</span>;
const RAG: Record<string, { dot: string; fg: string; label: string }> = { done: { dot: '#16a34a', fg: '#14532d', label: 'Done' }, open: { dot: '#f59e0b', fg: '#78350f', label: 'In Progress' }, blocked: { dot: '#dc2626', fg: '#7f1d1d', label: 'Needs You' }, idle: { dot: '#cbd5e1', fg: '#64748b', label: 'Not Started' } };
const DONE_STATUSES = new Set(['cleared', 'reviewed', 'done', 'sent', 'received', 'discharged', 'redeemed', 'replied', 'verified', 'approved', 'not_required', 'not_applicable', 'read']);
const SEARCH_NAME: Record<string, string> = { LLC1: 'Local Land Charges (LLC1)', CON29: 'Local Authority (CON29)', DRAINAGE_WATER: 'Drainage & Water', ENVIRONMENTAL: 'Environmental', CHANCEL: 'Chancel Repair', MINING: 'Coal Mining (CON29M)', FLOOD: 'Flood Risk', HIGHWAYS: 'Highways', PLANNING: 'Planning History' };
const daysAgo = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
const gbp = (p: number | null | undefined) => (p == null ? '' : `£${(p / 100).toLocaleString('en-GB')}`);

export interface Tile { label: string; status: string; detail?: string; /** a control that belongs to this step (e.g. Read Again on a report's findings) */ action?: ReactNode; /** what this sub-block is, for the ⓘ; keyed into ABOUT when set */ key?: string; href?: string; /** the document behind it, for the Documents link */ documentId?: string | null; /** the subject its events carry, for the Timeline link */ focus?: string; /** 1 = nested under the sub-block above */ depth?: 0 | 1 }
/** When each sub-block starts, when it is done, and what it talks to. Written for the conveyancer, not the client. */
interface About { starts: string; done: string; note?: string; via?: string; /** the document this step produces, from the firm's Doc Packs */ creates?: string }
const ABOUT: Record<string, About> = {
  'ID / AML check': { creates: 'Client care letter (.docx)', starts: 'On enrolment, for every client.', done: 'Provider result clear. A referred result goes to a conveyancer with the report; a fail halts the case.', via: 'InfoTrack ID (or the mock until InfoTrack is connected). At Propose you approve the request first.' },
  'Proof of funds': { starts: 'On enrolment on a purchase, when firm policy requires it. The form link goes to the client.', done: 'A conveyancer signs off the declaration and statements. Exchange is held until then.', note: 'The rules read the statements, draft queries on large or unexplained credits and rate the risk; sign-off is never automated.', via: 'Client comms (email / WhatsApp). At Propose you approve the send first.' },
  'Queries to the client': { starts: 'Drafted by the rules from the submission, or added by you.', done: 'Each query answered through the form or withdrawn with a reason. Sign-off is refused while any is open.' },
  'Official copies': { starts: 'When the register and plan are filed under Documents, however they arrive.', done: 'Read by the rules: a clean title clears; restrictions, charges, covenants and a short lease go to a conveyancer.', via: 'Extraction of the official copy. HMLR ordering through InfoTrack is planned, not live.' },
  'Report on title': { starts: 'Drafted once title, searches and enquiries are resolved.', done: 'A conveyancer approves the draft; it is then sent to the client and recorded as sent.', via: 'AI drafts from the file; a person approves; client comms sends.', creates: 'Report on title (.docx, from the Report on title doc pack)' },
  'search:LLC1': { starts: 'Ordered when the case reaches pre-contract.', done: 'Result read by the rules; clear, or flagged to a conveyancer on financial charges, listing, conservation area or TPOs.', via: 'InfoTrack order and webhook result. At Propose you approve the order first.' },
  'search:CON29': { starts: 'Ordered when the case reaches pre-contract.', done: 'Clear, or flagged on enforcement, contravention, unadopted road, proposed schemes, contaminated land or radon.', via: 'InfoTrack order and webhook result. At Propose you approve the order first.' },
  'search:DRAINAGE_WATER': { starts: 'Ordered when the case reaches pre-contract.', done: 'Clear, or flagged on no public sewer connection, a sewer within 3m or under the building without a build-over agreement.', via: 'InfoTrack order and webhook result.' },
  'search:ENVIRONMENTAL': { starts: 'Ordered when the case reaches pre-contract.', done: 'Clear, or flagged on flood risk, contaminated land, subsidence, mining or landfill, or a further-action recommendation.', via: 'InfoTrack order and webhook result.' },
  'search:CHANCEL': { starts: 'Ordered when the case reaches pre-contract, where on the list.', done: 'Clear, or flagged where liability is registered; an indemnity is the usual answer.', via: 'InfoTrack order and webhook result.' },
  Enquiry: { starts: "Raised by you or from an issue; sent to the seller's solicitor and chased on the SLA.", done: 'The reply is read by the rules: an answer that fully addresses it clears; a partial or evasive one goes to a conveyancer.', via: 'Chaser emails the other side; the reply is filed by email match or upload.' },
  Offer: { starts: 'When the offer is filed.', done: 'Standard conditions clear by rule. Special conditions, a retention, a down-valuation or an expiry within 28 days of target exchange go to a conveyancer.' },
  'Mortgage deed': { starts: 'Sent for signature after the report on title.', done: 'Every borrower has signed, witnessed; held undated until completion.' },
  'Certificate of title': { starts: 'After exchange, once the deed is held and the offer conditions are met.', done: 'Sent to the lender with the completion date; the advance is requested for the working day before.' },
  Deposit: { creates: 'Deposit request letter (.docx)', starts: 'Requested from the client once the contract is approved.', done: 'Cleared funds on client account, matching the contract, from a source covered by the proof of funds.', note: 'A deposit received before proof of funds is signed off raises an AML issue.' },
  'Contract approved / signed': { starts: 'When the contract pack arrives from the other side.', done: 'Approved by a conveyancer, then signed by the client and held ready for exchange.' },
  "Client's authority to exchange": { starts: 'Asked for once the report on title has gone and the deposit is held.', done: "The client's instruction to exchange, in writing, recorded on the case." },
  Exchange: { creates: 'Exchange confirmation letter (.docx)', starts: 'Only when every item above is done: contract signed, deposit held, source of funds signed off, report sent, offer valid, and the client has authorised it.', done: 'Contracts exchanged with the other side and the completion date fixed. The client and agent are told.', note: 'Exchange is the gate. The engine will not record it while anything above is open; a conveyancer records it with the completion date.' },
  'Contract pack': { starts: 'Assembled once the property forms and official copies are in.', done: "Draft contract, official copies, plan and forms sent to the buyer's solicitor.", creates: 'Contract pack covering letter (.docx)' },
  'Completion statement': { starts: 'Drafted from the file from pre-exchange: price, deposit, advance or redemption, and the leasehold apportionments, each cited to its document and page; fees, SDLT and disbursements left for you to fill.', done: 'Figures reconciled and the statement produced; funds are requested against it.', via: 'The engine computes; nothing is estimated. Every figure is checked against the register like a report on title.', creates: 'Completion statement draft under Documents, with its sources.' },
  Completion: { creates: 'Completion letter (.docx)', starts: 'On the completion date, once funds are received.', done: 'Completion monies sent to verified details and receipt confirmed; keys released. Starts the SDLT and AP1 clocks.' },
  'Balance to the client': { starts: 'After completion on a sale.', done: "Paid to the client's verified account, authorised by a person." },
  'Payment to the lender': { starts: 'On completion where there is a charge to redeem.', done: "Redemption sent to the lender's verified details, authorised by a person; the lender's confirmation received." },
  'Redemption statement': { starts: 'Requested from the existing lender once a completion date is in view; chased on the SLA.', done: 'Figure, daily rate and validity date on file.', via: 'Chaser emails the lender.' },
  Redeemed: { starts: 'On completion.', done: "Redemption paid; the lender's confirmation received." },
  'Discharge (DS1 / e-DS1)': { starts: 'After redemption.', done: 'The release lodged and the charge removed from the register.' },
  Consent: { starts: 'Requested from the existing lender on enrolment of a transfer.', done: 'Consent received covering this transfer and these parties, with any conditions noted.' },
  'Transfer deed': { starts: 'Sent for signature with the contract.', done: 'The TR1 signed by every party and witnessed.' },
  'Declaration of trust': { starts: 'When the clients hold as tenants in common.', done: 'Signed by every co-owner, witnessed, shares as instructed.' },
  'How they hold': { starts: 'Asked of the clients where there is more than one.', done: 'Joint tenants or tenants in common, recorded from their instruction.' },
  'Lease': { starts: 'The lease is filed under Documents on a leasehold case, before or after the official copy.', done: 'Read into the review table: term, ground rent and its review, service charge proportion, repairs, assignment, alterations, use, insurance, notices and fees, forfeiture, every clause quoted with its page.', note: 'A short term, an escalating rent or an absolute bar on assignment raises the title decision; the lease and the official copy are one review.', via: 'Claude reads the lease; the rules test the term and the rent.', creates: 'A title decision when anything needs a person; otherwise the lease facts on the case.' },
  case_counted: { starts: 'The moment the ID / AML check comes back resolved: cleared by the rules or reviewed by a person. Enrolment and triage never count.', done: 'The case is counted once. A firm on a paid plan is billed £100 for it that month; a trial or comped firm sees the count and no bill.', via: 'Stripe Billing Meter, one event per case; a failed report is retried.', creates: 'A line on the Billing page.' },
  'Document review': { starts: 'The moment a document is filed into a sub-block: Claude reads every page and returns a fact for each thing it relies on, with the page and a quote.', done: 'Every page attested (read, nothing on it, or unreadable), every quote found on its page, cross-checks run against the other documents and the case record.', note: 'A page that could not be read, or a quote that is not on the page, shows here as partly read; the review table under Documents says which.', via: 'Claude reads; the engine verifies against the page text (OCR for scans).', creates: 'The review table under Documents.' },
  donor_id: { starts: 'The moment a gift is declared on the proof-of-funds form: the donor is a source of funds, so their identity and AML are checked as the client\'s are.', done: 'Cleared by the rules, or reviewed by a person. Sign-off on the proof of funds waits for it.', via: 'The same ID provider as the client\'s check. At Propose you approve the request first.', creates: 'A decision when the check refers or fails.' },
  'Management pack (LPE1)': { starts: 'Requested from the freeholder or agent on a leasehold; chased on the SLA.', done: 'Read by the rules: service charge, ground rent, arrears, major works and insurance; anything off goes to a conveyancer.' },
  'Notice of assignment': { starts: 'After completion on a leasehold.', done: 'Served on the landlord with the fee; notice of charge where there is a lender.' },
  SDLT: { starts: 'On completion.', done: 'Return filed and paid within 14 days; UTRN on file.', note: 'The deadline is tracked and escalated.' },
  AP1: { starts: 'On completion, with the SDLT5.', done: 'Lodged within the priority period; registration confirmed by HMLR; requisitions answered.' },
  File: { starts: 'Once registration is confirmed.', done: 'Client sent the completed register; the file closed.' },
  Forms: { starts: 'Sent to the client on enrolment of a sale.', done: 'TA6, TA10 (and TA7) completed and returned; chased on the SLA.', via: 'Client comms.' },
};
const aboutFor = (x: Tile): About | null => ABOUT[x.key ?? ''] ?? ABOUT[x.label.replace(/\s·.*$/, '')] ?? ABOUT[x.label.split(' ')[0]] ?? null;
/** Who has to sign a sub-block off, by its label. Nothing listed means the rules can clear it. */
const PERSON: Array<[RegExp, 'conveyancer' | 'client']> = [[/^Contract approved/, 'conveyancer'], [/^Client's authority/, 'client'], [/^Exchange$/, 'conveyancer'], [/^Report on title/, 'conveyancer'], [/^Proof of funds/, 'conveyancer'], [/^Mortgage deed/, 'client'], [/^Certificate of title/, 'conveyancer'], [/^Completion payment/, 'conveyancer'], [/^Balance to the client/, 'conveyancer'], [/^Payment to the lender/, 'conveyancer'], [/^AP1/, 'conveyancer'], [/^SDLT/, 'conveyancer'], [/^Transfer deed/, 'client'], [/^Declaration of trust/, 'client'], [/^How they hold/, 'client'], [/^Forms/, 'client'], [/^Completion$/, 'conveyancer']];
const personFor = (label: string) => PERSON.find(([re]) => re.test(label))?.[1] ?? null;
export interface LaneDef { id: string; title: string; state: 'done' | 'open' | 'blocked' | 'idle'; note?: string; tiles: Tile[]; actions?: ReactNode; extra?: ReactNode; /** a map, not a case: no state label, no progress bar, no status pills */ plain?: boolean; /** the gate this box holds when it is not the exit of its own band, e.g. 'Holds Exchange' */ holds?: string; /** sequence: the sub-blocks happen in this order and the last is the gate; parallel (default): they run side by side */ order?: 'sequence' | 'parallel' }
export type Notice = { kind: 'ok' | 'warn' | 'err'; text: string; at: number } | null;
const NoticeBox = ({ n }: { n: Notice }) => (n ? <div className={n.kind === 'ok' ? 'ep-ok' : n.kind === 'warn' ? 'ep-warn' : 'ep-err'} role={n.kind === 'err' ? 'alert' : 'status'}>{n.text}</div> : null);

const STATE_ICON: Record<LaneDef['state'], { Icon: typeof Circle; colour: string }> = { done: { Icon: CheckCircle, colour: '#16a34a' }, open: { Icon: Clock, colour: '#f59e0b' }, blocked: { Icon: AlertTriangle, colour: '#dc2626' }, idle: { Icon: Circle, colour: '#cbd5e1' } };

/** The ⓘ: a description rendered on the top layer, so no box or band can sit over it. */
function Tip({ text, label, icon, href }: { text: ReactNode; label: string; icon?: ReactNode; href?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const show = () => { const r = ref.current?.getBoundingClientRect(); if (r) setPos({ x: Math.min(r.left, window.innerWidth - 280), y: r.bottom + 6 }); };
  return (
    <>
      {href ? <a ref={ref as never} href={href} className={`ep-who${href ? ' doc' : ''}`} aria-label={label} onMouseEnter={show} onMouseLeave={() => setPos(null)} onFocus={show} onBlur={() => setPos(null)}>{icon}</a> : <span ref={ref} className={icon ? 'ep-who' : 'ep-i'} tabIndex={0} aria-label={label} onMouseEnter={show} onMouseLeave={() => setPos(null)} onFocus={show} onBlur={() => setPos(null)}>{icon ?? 'i'}</span>}
      {pos && createPortal(<div className="ep-tip" role="tooltip" style={{ left: pos.x, top: pos.y }}>{text}</div>, document.body)}
    </>
  );
}

/** One workstream as a box: state on the edge and the icon, progress as a bar. Open, it grows in place to show the sub-blocks and what a person may record now. */
function Box({ lane, open, onToggle, notice, unfed }: { lane: LaneDef; open: boolean; onToggle: () => void; notice?: Notice; unfed?: boolean }) {
  const r = RAG[lane.state];
  const { Icon, colour } = STATE_ICON[lane.state];
  const steps = lane.tiles.filter((x) => !x.depth);
  const done = steps.filter((x) => DONE_STATUSES.has(x.status)).length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : lane.state === 'done' ? 100 : 0;
  return (
    <div className={`ep-box ${lane.state}${open ? ' on' : ''}`} id={`lane-${lane.id}`} data-lane={lane.id} data-unfed={unfed ? '' : undefined}>
      <button type="button" className="ep-box-h" onClick={onToggle} aria-expanded={open}>
        <span className="ep-box-t">{!lane.plain && <span className="ic" style={{ color: colour }}><Icon size={16} /></span>}{titleCase(lane.title)}{lane.holds && <Tip label={lane.holds} icon={<Lock size={11} />} text={<><span className="k">{lane.holds}</span> The rest of this band carries on without it; {lane.holds.replace(/^Holds /, '').toLowerCase()} cannot happen until this box is done.</>} />}</span>
        {!lane.plain && <span className="ep-box-m"><span style={{ color: r.fg }}>{r.label}</span><span className="n">{done}/{steps.length}</span></span>}
        {!lane.plain && <span className="ep-bar"><i style={{ width: `${pct}%`, background: colour }} /></span>}
      </button>
      {open && (
        <div className="ep-box-b">
          {lane.note && <div className="ep-note" style={{ padding: '4px 0 6px' }}>{lane.note}</div>}
          <div className={lane.order === 'sequence' ? 'ep-seq' : 'ep-tree'}>
          {lane.tiles.map((x, n) => {
            const about = aboutFor(x);
            const who = personFor(x.label);
            const done = DONE_STATUSES.has(x.status);
            const last = lane.order === 'sequence' && !x.depth && steps[steps.length - 1] === x;
            const stepNo = steps.indexOf(x) + 1;
            const name = x.href ? <a href={x.href} className="ep-sub-a">{titleCase(x.label)}</a> : titleCase(x.label);
            return (
              <div key={`${x.label}-${n}`} className={`ep-sub${x.depth ? ' d1' : ''}${last ? ' gate' : ''}${done ? ' done' : ''}`}>
                {lane.order === 'sequence' && !x.depth && <span className="ep-n">{done ? <Check size={10} /> : stepNo}</span>}
                <b>
                  {name}
                  {who && <Tip label={who === 'client' ? "The client's decision" : "A conveyancer's sign-off"} icon={<User size={11} />} text={who === 'client' ? "The client decides this; it is recorded from their instruction, never assumed." : 'A conveyancer signs this off. The rules can prepare it but never complete it.'} />}
                  {about?.creates && <Tip label={`Creates ${about.creates}`} icon={<FileText size={11} />} href={`/conveyi/admin?tab=docpacks&doc=${encodeURIComponent(about.creates.replace(/\s*\(.*$/, ''))}`} text={<><span className="k">Creates</span> {about.creates}. Filled from the case and filed under Documents. Click to open the document under Doc Packs.</>} />}
                  {about && <Tip label={`About ${x.label}`} text={<><span className="k">Starts</span> {about.starts}<br /><span className="k">Done</span> {about.done}{about.note && <><br /><span className="k">Note</span> {about.note}</>}{about.via && <><br /><span className="k">Via</span> {about.via}</>}{about.creates && <><br /><span className="k">Creates</span> {about.creates}</>}</>} />}
                </b>
                {!lane.plain && <Pill s={x.status} />}
                {x.detail && <span className="d">{x.detail}</span>}
                {x.action && <span className="a">{x.action}</span>}
              </div>
            );
          })}
          </div>
          {lane.extra}
          {lane.actions && <div className="acts">{lane.actions}</div>}
          <NoticeBox n={notice ?? null} />
        </div>
      )}
    </div>
  );
}

/** What sits between two phases: an automatic hand-off, or a person who has to sign. */
const JUNCTION: Record<string, { kind: 'auto' | 'person'; label: string; text: string }> = {
  'instruction->investigation': { kind: 'auto', label: 'Automatic', text: 'Once the ID check clears the case moves to pre-contract and every search on its list is ordered from InfoTrack. At Propose each order is put to you first.' },
  'investigation->contract': { kind: 'person', label: 'Conveyancer', text: 'Nothing exchanges until each strand above is cleared by the rules or accepted by a conveyancer, the report on title has gone and source of funds is signed off.' },
  'contract->completion': { kind: 'person', label: 'Conveyancer and client', text: 'Exchange. The client authorises it in writing; a conveyancer exchanges with the signed contract and deposit held, and records the completion date.' },
  'completion->registration': { kind: 'person', label: 'Conveyancer', text: 'Completion. Every payment out is authorised by a person against bank details verified out of band; the rules never move money.' },
};

/** The flowchart: tiers top to bottom, every box in a tier joined by a bus to every box in the next, so fan-out and fan-in read as concurrency. */
export function Flow({ tiers, current, toggle, noticeFor }: { tiers: Array<{ id: string; label: string; items: LaneDef[]; unfed?: Set<string> }>; current: string | null; toggle: (l: LaneDef) => void; noticeFor: (id: string) => Notice }) {
  const ref = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ bus: string[]; drops: string[]; arrows: string[]; junctions: Array<{ x: number; y: number; from: string; to: string }> }>({ bus: [], drops: [], arrows: [], junctions: [] });
  const measure = useCallback(() => {
    const root = ref.current;
    if (!root) return;
    const rr = root.getBoundingClientRect();
    const tierEls = Array.from(root.querySelectorAll<HTMLElement>('[data-tier]'));
    const bus: string[] = []; const drops: string[] = []; const arrows: string[] = []; const junctions: Array<{ x: number; y: number; from: string; to: string }> = [];
    const mid = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return { x: r.left - rr.left + r.width / 2, top: r.top - rr.top, bottom: r.bottom - rr.top }; };
    for (let i = 0; i < tierEls.length - 1; i++) {
      const a = Array.from(tierEls[i].querySelectorAll<HTMLElement>('.ep-box')).map(mid);
      const b = Array.from(tierEls[i + 1].querySelectorAll<HTMLElement>('.ep-box:not([data-unfed])')).map(mid);
      if (!a.length || !b.length) continue;
      const y = (Math.max(...a.map((p) => p.bottom)) + Math.min(...b.map((p) => p.top))) / 2;
      const from = tierEls[i].dataset.tier ?? ''; const to = tierEls[i + 1].dataset.tier ?? '';
      if (a.length === 1 && b.length === 1 && Math.abs(a[0].x - b[0].x) < 2) {
        arrows.push(`M${a[0].x},${a[0].bottom} V${b[0].top - 1}`);
        junctions.push({ x: a[0].x, y: (a[0].bottom + b[0].top) / 2, from, to });
        continue;
      }
      const xs = [...a, ...b].map((p) => p.x);
      bus.push(`M${Math.min(...xs)},${y} H${Math.max(...xs)}`);
      junctions.push({ x: (Math.min(...xs) + Math.max(...xs)) / 2, y, from, to });
      for (const p of a) drops.push(`M${p.x},${p.bottom} V${y}`);
      for (const p of b) arrows.push(`M${p.x},${y} V${p.top - 1}`);
    }
    setLines({ bus, drops, arrows, junctions });
  }, []);
  useLayoutEffect(() => {
    measure();
    const root = ref.current;
    if (!root) return;
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('.ep-box'))) ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [measure, current, tiers]);
  return (
    <div className="ep-flow" ref={ref}>
      <svg aria-hidden="true">
        <defs><marker id="ep-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8" /></marker></defs>
        {lines.bus.map((d, i) => <path key={`b${i}`} d={d} stroke="#cbd5e1" strokeWidth={2} fill="none" strokeLinecap="round" />)}
        {lines.drops.map((d, i) => <path key={`d${i}`} d={d} stroke="#cbd5e1" strokeWidth={2} fill="none" />)}
        {lines.arrows.map((d, i) => <path key={`a${i}`} d={d} stroke="#cbd5e1" strokeWidth={2} fill="none" markerEnd="url(#ep-arrow)" />)}
      </svg>
      {lines.junctions.map((j) => {
        const g = JUNCTION[`${j.from}->${j.to}`];
        if (!g) return null;
        return (
          <div key={`${j.from}-${j.to}`} className={`ep-junction ${g.kind}`} style={{ left: j.x, top: j.y }}>
            <Tip label={g.label} icon={g.kind === 'person' ? <User size={12} /> : <Zap size={12} />} text={<><span className="k">{g.label}</span> {g.text}</>} />
          </div>
        );
      })}
      {tiers.map((tier) => {
        const ps = phaseState(tier.items);
        return (
          <div key={tier.id} className="ep-tier" data-tier={tier.id}>
            <div className="ep-tier-b">
              {tier.items.map((l) => <Box key={l.id} lane={l} open={current === l.id} onToggle={() => toggle(l)} notice={noticeFor(l.id)} unfed={tier.unfed?.has(l.id)} />)}
            </div>
            <span className={`ep-tier-l ${ps}`}><i style={{ background: RAG[ps].dot }} />{tier.label}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Who a wait is chased with, as a conveyancer would say it. */
const WAIT_PARTY: Record<string, string> = { client: 'the client', seller_solicitor: "the seller's solicitor", buyer_solicitor: "the buyer's solicitor", other_side: 'the other side', lender: 'the lender', search_provider: 'the search provider', estate_agent: 'the estate agent', freeholder: 'the freeholder / managing agent', hmlr: 'HM Land Registry' };

/** Instruction first, the investigation strands in parallel, then contract, completion and registration. */
/** `unfed` lanes sit in the tier's row but nothing is drawn into them: they start when something arrives from someone else (the contract pack asked for at enrolment, the offer, the survey), not when the tier before is done. */
const PHASES: ReadonlyArray<{ id: string; label: string; lanes: string[]; unfed?: string[] }> = [
  { id: 'instruction', label: 'Instruction', lanes: ['id_aml', 'source_of_funds', 'co_ownership', 'property_forms'] },
  { id: 'investigation', label: 'Investigation', lanes: ['title', 'searches', 'enquiries', 'mortgage', 'survey', 'leasehold', 'redemption', 'lender_consent'], unfed: ['title', 'mortgage', 'survey'] },
  { id: 'contract', label: 'Contract & Exchange', lanes: ['exchange', 'transfer_deed'] },
  { id: 'completion', label: 'Completion', lanes: ['pre_completion_checks', 'completion'] },
  { id: 'registration', label: 'Registration', lanes: ['registration'] },
];
const phaseState = (ls: LaneDef[]): LaneDef['state'] => (ls.some((l) => l.state === 'blocked') ? 'blocked' : ls.some((l) => l.state === 'open') ? 'open' : ls.length && ls.every((l) => l.state === 'done') ? 'done' : 'idle');

type Cmd = (body: Record<string, unknown>) => Promise<void>;

/** Case shapes a case can be enrolled with (mirrors lib/server/engine/shapes.ts). */
const SHAPES: Array<{ id: string; label: string; sides: string[]; summary: string }> = [
  { id: 'company_buyer', label: 'Company Buyer', sides: ['buyer'], summary: 'Companies House, directors and PSCs, authority to buy, the company\'s funds.' },
  { id: 'buy_to_let', label: 'Buy To Let', sides: ['buyer'], summary: 'Buy-to-let offer conditions, any sitting tenancy, licensing, higher-rate SDLT.' },
  { id: 'new_build', label: 'New Build', sides: ['buyer'], summary: 'Developer\'s pack, warranty, planning and roads, exchange deadline, completion on notice.' },
  { id: 'auction', label: 'Auction', sides: ['buyer', 'seller'], summary: 'Legal pack before the auction; the hammer is the exchange; completion to the conditions.' },
  { id: 'lifetime_isa', label: 'Lifetime ISA', sides: ['buyer'], summary: 'Declarations, eligibility limits, the bonus paid to us by the ISA manager.' },
  { id: 'help_to_buy_isa', label: 'Help To Buy ISA', sides: ['buyer'], summary: 'Closing statement, the bonus claim, the bonus paid to us before completion.' },
  { id: 'second_charge', label: 'Second Charge / Equity Loan', sides: ['buyer'], summary: 'Both lenders\' consents, the deed of postponement, the second deed before completion.' },
  { id: 'shared_ownership', label: 'Shared Ownership', sides: ['buyer'], summary: 'Model lease with the mortgagee protection clause, provider approval, rent and staircasing.' },
  { id: 'unrepresented_counterparty', label: 'Unrepresented Other Side', sides: ['buyer', 'seller'], summary: 'No undertakings, identity against the title, the lender told.' },
  { id: 'court_order_transfer', label: 'Transfer Under A Court Order', sides: ['owner'], summary: 'The sealed order, the lender\'s release of the outgoing owner, the SDLT exemption.' },
  { id: 'right_to_buy', label: 'Right To Buy', sides: ['buyer', 'seller'], summary: 'Discount repayment charge for five years, right of first refusal for ten.' },
  { id: 'flying_freehold', label: 'Flying Freehold', sides: ['buyer'], summary: 'The lender\'s limit, rights of support and access, an indemnity policy.' },
  { id: 'commonhold', label: 'Commonhold', sides: ['buyer', 'seller'], summary: 'The community statement and the association in place of the lease and the pack.' },
];

/** Enrolment: the transaction type decides everything that follows. */
function EnrolForm({ busy, cmd, err }: { busy: boolean; cmd: Cmd; err: string | null }) {
  const [type, setType] = useState<TransactionType>('freehold_purchase');
  const [hasLender, setHasLender] = useState(true);
  const [hasExistingMortgage, setHasExistingMortgage] = useState(true);
  const [parties, setParties] = useState(1);
  const [consideration, setConsideration] = useState('');
  const [searches, setSearches] = useState('');
  const [shapes, setShapes] = useState<string[]>([]);
  const [names, setNames] = useState('');
  const [attorneys, setAttorneys] = useState('');
  const [officers, setOfficers] = useState('');
  const [executors, setExecutors] = useState('');
  const [occupiers, setOccupiers] = useState('');
  const [ftb, setFtb] = useState(false);
  const [additional, setAdditional] = useState(false);
  const [nonRes, setNonRes] = useState(false);
  const [mixedUse, setMixedUse] = useState(false);
  const [linked, setLinked] = useState('');
  const buyer = type === 'freehold_purchase' || type === 'leasehold_purchase';
  const seller = type === 'freehold_sale' || type === 'leasehold_sale';
  const remo = type === 'remortgage';
  const toe = type === 'transfer_of_equity';
  return (
    <div className="ep">
      <style>{WORK_CSS}</style>
      <div className="ep-enrol">
        <label>Transaction type
          <select value={type} onChange={(e) => setType(e.target.value as TransactionType)}>{TRANSACTION_TYPES.map((t) => <option key={t} value={t}>{TRANSACTION_LABEL[t]}</option>)}</select>
        </label>
        {(buyer || remo) && <label>{remo ? 'New lender' : 'Buyer has a mortgage lender'}<select value={hasLender ? 'yes' : 'no'} onChange={(e) => setHasLender(e.target.value === 'yes')}><option value="yes">Yes — lender-funded</option><option value="no">No — cash</option></select></label>}
        {(seller || remo || toe) && <label>Existing mortgage on the property<select value={hasExistingMortgage ? 'yes' : 'no'} onChange={(e) => setHasExistingMortgage(e.target.value === 'yes')}><option value="yes">Yes — charge to redeem / consent needed</option><option value="no">No — unencumbered</option></select></label>}
        {(buyer || toe) && <label>Clients (co-owners after completion)<input type="number" min={1} max={4} value={parties} onChange={(e) => setParties(Math.max(1, Number(e.target.value) || 1))} /></label>}
        {parties > 1 && <label>Client names (comma-separated; each is identified in their own right)<input value={names} onChange={(e) => setNames(e.target.value)} placeholder="Tomasz Nowak, Ewa Nowak" /></label>}
        {toe && <label>Consideration (£, 0 for none)<input type="number" min={0} value={consideration} onChange={(e) => setConsideration(e.target.value)} placeholder="0" /></label>}
        <label>Attorneys acting for a client (comma-separated)<input value={attorneys} onChange={(e) => setAttorneys(e.target.value)} placeholder="blank if none" /></label>
        {buyer && shapes.includes('company_buyer') && <label>Directors and PSCs of the company (comma-separated)<input value={officers} onChange={(e) => setOfficers(e.target.value)} /></label>}
        <label>Executors / trustees acting (comma-separated)<input value={executors} onChange={(e) => setExecutors(e.target.value)} placeholder="blank if none" /></label>
        {buyer && <label>Adult occupiers who are not buying (comma-separated)<input value={occupiers} onChange={(e) => setOccupiers(e.target.value)} placeholder="blank if none" /></label>}
        {buyer && (
          <div className="ep-shapes">
            <label className="ep-shape"><input type="checkbox" checked={ftb} onChange={(e) => setFtb(e.target.checked)} />SDLT: first-time buyer relief</label>
            <label className="ep-shape"><input type="checkbox" checked={additional} onChange={(e) => setAdditional(e.target.checked)} />SDLT: additional property</label>
            <label className="ep-shape"><input type="checkbox" checked={nonRes} onChange={(e) => setNonRes(e.target.checked)} />SDLT: non-UK resident</label>
            <label className="ep-shape"><input type="checkbox" checked={mixedUse} onChange={(e) => setMixedUse(e.target.checked)} />SDLT: mixed use</label>
            <label className="ep-shape">SDLT: linked consideration £<input type="number" min={0} value={linked} onChange={(e) => setLinked(e.target.value)} style={{ width: 110 }} /></label>
          </div>
        )}
        {(buyer || seller || toe) && (
          <div className="ep-shapes">
            {SHAPES.filter((sh) => sh.sides.includes(buyer ? 'buyer' : seller ? 'seller' : 'owner')).map((sh) => (
              <label key={sh.id} className="ep-shape" title={sh.summary}>
                <input type="checkbox" checked={shapes.includes(sh.id)} onChange={(e) => setShapes((cur) => (e.target.checked ? [...cur, sh.id] : cur.filter((x) => x !== sh.id)))} />
                {sh.label}
              </label>
            ))}
          </div>
        )}
        {(buyer || remo) && <label>Searches (comma-separated; blank = the type's defaults)<input value={searches} onChange={(e) => setSearches(e.target.value)} placeholder={buyer ? 'LLC1, CON29, DRAINAGE_WATER, ENVIRONMENTAL' : 'none by default'} /></label>}
      </div>
      <button className="ep-btn primary" disabled={busy} onClick={() => {
        const body: Record<string, unknown> = { type: 'enrol', transactionType: type, hasLender: buyer || remo ? hasLender : false, hasExistingMortgage: seller || remo || toe ? hasExistingMortgage : false, parties: buyer || toe ? parties : 1 };
        if (toe) body.considerationPennies = Math.round((Number(consideration) || 0) * 100);
        if (shapes.length && (buyer || seller || toe)) body.shapes = shapes;
        const partyNames = names.split(',').map((x) => x.trim()).filter(Boolean);
        if (partyNames.length) body.partyNames = partyNames;
        const split = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
        if (split(attorneys).length) body.attorneys = split(attorneys);
        if (buyer && shapes.includes('company_buyer') && split(officers).length) body.officers = split(officers);
        if (split(executors).length) body.executors = split(executors);
        if (buyer && split(occupiers).length) body.occupiers = split(occupiers);
        if (buyer && (ftb || additional || nonRes || mixedUse || Number(linked) > 0)) body.sdlt = { firstTimeBuyer: ftb, additionalProperty: additional, nonUkResident: nonRes, mixedUse, linkedConsiderationPennies: Number(linked) > 0 ? Math.round(Number(linked) * 100) : null };
        const list = searches.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
        if (list.length) body.requiredSearches = list;
        void cmd(body);
      }}>Enrol as {TRANSACTION_LABEL[type].toLowerCase()}</button>
      {err && <div className="ep-err">{err}</div>}
    </div>
  );
}

export function WorkPanel({ matterId, api, view, busy, err, cmd, onChanged, notice, section = 'flow' }: { matterId: string; api: Api; view: EngineView; busy: boolean; err: string | null; cmd: Cmd; onChanged?: () => void; notice?: Notice; section?: 'flow' | 'tasks' }) {
  const [pofNote, setPofNote] = useState('');
  const [pofQuestion, setPofQuestion] = useState('');
  const [enquiry, setEnquiry] = useState({ id: '', subject: '' });
  const [inbound, setInbound] = useState('');
  const [replySel, setReplySel] = useState<Record<string, boolean>>({});
  const [completionDate, setCompletionDate] = useState('');
  const [bd, setBd] = useState({ payeeKind: 'seller_solicitor', payeeRef: '', accountName: '', sortCode: '', accountNumber: '', firmName: '', sourceChannel: 'email' });
  const [payFrom, setPayFrom] = useState<Record<string, string>>({});
  const [openLane, setOpenLane] = useState<string | null | undefined>(undefined);
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
  // A contracted milestone opens its completion sheet in the lane; the sheet gathers the
  // evidence the contract asks for and records the command with it.
  const contracts = view.contracts ?? {};
  const [sheet, setSheet] = useState<{ laneId: string; type: string; extra: Record<string, unknown> } | null>(null);
  const [docs, setDocs] = useState<CaseDocument[] | null>(null);
  // The documents (with what the engine read of each) feed the Document Review steps and the completion sheets; refreshed whenever the log moves.
  useEffect(() => {
    let live = true;
    api<{ documents: CaseDocument[] }>(`/matters/${matterId}/engine/documents`).then((r) => { if (live) setDocs(r.documents); }).catch(() => { if (live) setDocs([]); });
    return () => { live = false; };
  }, [api, matterId, view.state.stage, view.pendingDecisions.length, view.blockers.length]);
  const openSheet = (laneId: string, type: string, extra: Record<string, unknown>) => setSheet({ laneId, type, extra });
  const act = (laneId: string, type: string, label: string, extra: Record<string, unknown> = {}, opts: { primary?: boolean; disabled?: boolean; title?: string } = {}) => {
    const c: CompletionContract | undefined = contracts[type];
    return (
      <button className={`ep-btn${opts.primary ? ' primary' : ''}`} disabled={busy || opts.disabled} title={opts.title ?? c?.effect} onClick={() => (c ? openSheet(laneId, type, extra) : void cmd({ type, ...extra }))}>
        {label}
      </button>
    );
  };
  // Read a filed report again from scratch (new questions, or a bad first read).
  const [rereading, setRereading] = useState<string | null>(null);
  const [rereadNote, setRereadNote] = useState<string | null>(null);
  /** A report being read again: its document, the reading it had before, and when it started. Cleared when a new reading lands. */
  const [readingNow, setReadingNow] = useState<{ documentId: string; before: string | null; since: number } | null>(null);
  const readAgain = async (documentId: string, before: string | null) => {
    setRereading(documentId); setRereadNote(null);
    try {
      await api(`/documents/${documentId}/read-again`, { method: 'POST', body: '{}' });
      setReadingNow({ documentId, before, since: Date.now() });
      // A long report takes a minute or two: look again until the new reading lands.
      for (const ms of [20_000, 40_000, 60_000, 90_000, 120_000, 180_000, 240_000]) setTimeout(() => onChanged?.(), ms);
    } catch (e: unknown) { setRereadNote(e instanceof Error ? e.message : 'Could not read it again.'); }
    finally { setRereading(null); }
  };
  const [packBusy, setPackBusy] = useState(false);
  const [packNote, setPackNote] = useState<string | null>(null);
  const sendPack = async () => {
    setPackBusy(true); setPackNote(null);
    try { await api(`/matters/${matterId}/signing/pack`, { method: 'POST', body: '{}' }); setPackNote('Sent'); onChanged?.(); }
    catch (e: unknown) { setPackNote(e instanceof Error ? e.message : 'Could not send the pack.'); }
    finally { setPackBusy(false); }
  };
  const [sheetContext, setSheetContext] = useState<TaskContextView | null>(null);
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) setSheet(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet, busy]);
  useEffect(() => {
    setSheetContext(null);
    if (!sheet) return;
    let live = true;
    const subject = typeof sheet.extra?.subject === 'string' ? sheet.extra.subject : typeof sheet.extra?.searchType === 'string' ? sheet.extra.searchType : null;
    api<{ context: TaskContextView }>(`/matters/${matterId}/engine/context?command=${encodeURIComponent(sheet.type)}${subject ? `&subject=${encodeURIComponent(subject)}` : ''}`)
      .then((r) => { if (live) setSheetContext(r.context); })
      .catch(() => {});
    return () => { live = false; };
  }, [sheet, api, matterId]);
  const sheetDialog = sheet && sheet.type === 'client_decision_recorded' ? (
    <div className="ep-veil" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setSheet(null); }}>
      <ClientDecisionSheet
        matterId={matterId}
        api={api}
        subject={String(sheet.extra.subject ?? '')}
        decision={String(sheet.extra.decision ?? '')}
        about={typeof sheet.extra.scopeLabel === 'string' ? sheet.extra.scopeLabel : null}
        docs={docs}
        busy={busy}
        onCancel={() => setSheet(null)}
        onSubmit={async (body) => {
          const { scopeLabel: _l, ...extra } = sheet.extra as Record<string, unknown>;
          await cmd({ type: sheet.type, ...extra, ...body });
          setSheet(null);
        }}
      />
    </div>
  ) : sheet && contracts[sheet.type] ? (
    <div className="ep-veil" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setSheet(null); }}>
      <CompletionSheet
        upload={/_deed_executed$|deed_of_trust_executed/.test(sheet.type) ? async (file) => {
          const base64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(new Error('Could not read the file.')); r.readAsDataURL(file); });
          const r = await api<{ document: CaseDocument }>(`/matters/${matterId}/documents/upload-scan`, { method: 'POST', body: JSON.stringify({ fileName: file.name, mimeType: file.type || 'application/pdf', base64, docType: 'SIGNED_DEED' }) });
          return r.document;
        } : undefined}
        contract={contracts[sheet.type]}
        docs={docs}
        context={sheetContext}
        busy={busy}
        onCancel={() => setSheet(null)}
        onSubmit={async (body) => {
          await cmd({ type: sheet.type, ...sheet.extra, ...body });
          setSheet(null);
        }}
      />
    </div>
  ) : null;
  const inboundOpen = Object.values(s.inboundEnquiries ?? {}).filter((q) => !q.repliedAt);
  const inboundAll = Object.values(s.inboundEnquiries ?? {}).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const red = s.redemption ?? { status: 'not_applicable' as const, lender: null, redemptionPennies: null, validUntil: null, dailyInterestPennies: null, requestedAt: null, receivedAt: null, redeemedAt: null, dischargedAt: null };
  const redemptionApplies = !!s.hasExistingMortgage && (seller || remo);
  const consent = s.lenderConsent ?? { status: 'not_applicable' as const, lender: null, conditions: null, requestedAt: null, receivedAt: null };
  const forms = s.propertyForms ?? { status: 'not_applicable' as const, forms: [], requestedAt: null, receivedAt: null, facts: null };

  const resolved = (st: string) => st === 'cleared' || st === 'reviewed';
  const lanes: LaneDef[] = [];
  const reviewOf = (id: string | null | undefined) => (id ? docs?.find((d) => d.id === id)?.review ?? null : null);
  /** Reading a document is a step of its own: under every tile that has a document, what the engine read and verified. */
  const withReview = (tiles: Tile[]): Tile[] => tiles.flatMap((t) => {
    if (!t.documentId || t.depth) return [t];
    const r = reviewOf(t.documentId);
    if (!r) return [t]; // nothing was page-reviewed (a survey is read for its findings): no empty "not read" line
    const status = !r ? 'not_read' : r.complete && r.unreadable === 0 ? 'read' : 'partly_read';
    const detail = r ? `${r.read}/${r.pages} pages · ${r.verified}/${r.facts} facts verified${r.unreadable ? ` · ${r.unreadable} unreadable` : ''}` : docs ? 'no review on file' : undefined;
    return [t, { label: 'Document review', key: 'Document review', status, detail, documentId: t.documentId, depth: 1 as const }];
  });
  const lane = (l: LaneDef | null | false) => { if (l) lanes.push({ ...l, tiles: withReview(l.tiles) }); };

  const clientChecks = Object.values(s.partyChecks ?? {}).filter((pc) => pc.role !== 'donor');
  const donorChecks = Object.values(s.partyChecks ?? {}).filter((pc) => pc.role === 'donor');
  const idStatuses = [s.idCheck.status, ...clientChecks.map((pc) => pc.status)];
  lane({ id: 'id_aml', title: 'ID / AML', state: idStatuses.every((x) => resolved(x)) ? 'done' : idStatuses.some((x) => x === 'flagged') ? 'blocked' : idStatuses.some((x) => x === 'requested') ? 'open' : 'idle', note: parties > 1 ? `${parties} clients — every party is identified` : undefined,
    tiles: [
      { label: s.shapes?.includes('company_buyer') ? 'ID / AML check (company, directors and PSCs)' : clientChecks.length ? 'ID / AML check · first client' : 'ID / AML check', status: s.idCheck.status, documentId: s.idCheck.documentId, focus: 'id_check' },
      ...clientChecks.map((pc) => ({ label: `ID / AML check · ${pc.label}`, status: pc.status, documentId: pc.documentId, focus: 'id_check' })),
      { label: 'Case counted for billing', key: 'case_counted', status: view.matter?.charge ? 'done' : 'not_started', detail: view.matter?.charge ? `${fmtDay(view.matter.charge.chargedAt)} · ${view.matter.charge.billed ? `£${Math.round(view.matter.charge.amountPennies / 100)} billed` : view.matter.charge.reason === 'TRIAL' ? 'free on trial' : view.matter.charge.reason === 'COMP' || view.matter.charge.reason === 'PILOT' ? 'not billed (comped)' : view.matter.charge.reason === 'ERROR' ? 'billing retry pending' : 'no subscription'}` : undefined },
    ],
    actions: <>
      {s.stage === 'instruction' && s.idCheck.status === 'not_started' && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'request_id_check' })}>Request ID / AML check</button>}
      {!completed && <button className="ep-btn" disabled={busy} onClick={() => { const name = ask('Name of the person to identify:'); if (!name) return; const role = ask('Their role: buyer, seller, owner, donor, attorney, director or executor', buyer ? 'buyer' : seller ? 'seller' : 'owner'); if (role) void cmd({ type: 'add_party', name, role }); }}>Add Party</button>}
      {!completed && <button className="ep-btn" disabled={busy} onClick={() => { const from = ask('Name as it appears on the older document:'); if (!from) return; const to = ask('Name now:'); if (!to) return; const reason = ask('Evidence of the change (marriage certificate, deed poll, decree absolute):'); if (reason) void cmd({ type: 'name_change_evidenced', from, to, reason }); }}>Name Change Evidenced</button>}
      {!exchanged && (buyer || seller) && !s.relatedMatter && <button className="ep-btn" disabled={busy} onClick={() => { const id = ask(`Matter id of the client's linked ${buyer ? 'sale' : 'purchase'}:`); if (id) void cmd({ type: 'link_related_matter', relatedMatterId: id.trim(), relation: buyer ? 'sale' : 'purchase' }); }}>Link Related {buyer ? 'Sale' : 'Purchase'}</button>}
    </> });

  if (has('source_of_funds')) {
    const pof = s.proofOfFunds;
    const st = pof?.status === 'reviewed' ? (pof.resolution === 'approve' ? 'done' : 'blocked') : pof?.status === 'submitted' ? 'blocked' : pof?.status === 'requested' ? 'open' : 'idle';
    const qs = Object.values(pof?.queries ?? {}).sort((a, b) => a.raisedAt.localeCompare(b.raisedAt) || (a.id > b.id ? 1 : -1));
    const open = qs.filter((q) => q.status === 'draft' || q.status === 'sent');
    const QCHIP: Record<string, { bg: string; fg: string }> = { draft: { bg: '#fef3c7', fg: '#78350f' }, sent: { bg: '#e0e7ff', fg: '#3730a3' }, answered: { bg: '#dcfce7', fg: '#14532d' }, withdrawn: { bg: '#f1f5f9', fg: '#94a3b8' } };
    lane({ id: 'source_of_funds', title: 'Source of funds', holds: s.requireProofOfFunds ? 'Holds Exchange' : undefined, state: st, note: pof?.risk ? `risk ${pof.risk}${pof.approvedAt ? ` · signed off ${fmtDay(pof.approvedAt)}` : ''}` : s.requireProofOfFunds ? 'firm policy: signed off before exchange' : undefined,
      tiles: [
        { label: `Proof of funds${pof?.rounds ? ` · round ${pof.rounds}` : ''}`, documentId: pof?.documentId, focus: 'proof_of_funds', status: pof?.status === 'reviewed' ? (pof.resolution === 'approve' ? 'reviewed' : pof.resolution === 'reject' ? 'rejected' : 'reviewed') : pof?.status === 'submitted' ? 'awaiting_sign_off' : pof?.status === 'requested' ? 'requested' : 'not_started', detail: pof?.facts ? `declared ${gbp(pof.facts.totalDeclaredPennies)}${pof.facts.requiredPennies != null ? ` of ${gbp(pof.facts.requiredPennies)} needed` : ''}${pof.facts.giftedPennies ? ' · includes a gift' : ''}` : pof?.status === 'requested' ? `form with the client since ${fmtDay(pof.requestedAt)}` : undefined },
        ...donorChecks.map((pc) => ({ label: `ID / AML check · ${pc.label}`, status: pc.status, documentId: pc.documentId, focus: 'id_check', key: 'donor_id' })),
        ...(qs.length ? [{ label: 'Queries to the client', depth: 1 as const, focus: 'proof_of_funds_query', status: open.length ? 'raised' : 'replied', detail: `${qs.length} raised · ${open.length} open` }] : []),
      ],
      extra: pof && pof.status !== 'not_started' ? (
        <div style={{ marginTop: 8 }}>
          {pof.channel === 'unsent' && pof.formUrl && (
            <div className="ep-warn" style={{ marginTop: 0, marginBottom: 8 }}>
              Not sent{pof.sendError ? ` — ${pof.sendError}` : '.'} Send the client this link: <a href={pof.formUrl} target="_blank" rel="noreferrer">{pof.formUrl}</a>
            </div>
          )}
          {pof.status === 'requested' && pof.formUrl && !exchanged && (
            <div className="acts" style={{ marginBottom: 8 }}>
              <button className="ep-btn" style={{ margin: 0, padding: '3px 9px', fontSize: 11.5 }} disabled={busy} onClick={() => cmd({ type: 'resend_proof_of_funds' })}>{pof.channel === 'unsent' ? 'Try Sending Again' : 'Resend the Form'}</button>
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
      actions: <>
        {!completed && <button className="ep-btn" disabled={busy} onClick={() => { const r = ask('Name on the sending account (as the bank shows it):'); if (!r) return; const p = ask('What for: fees, deposit, completion or other', 'fees'); if (!p) return; const a = ask('Amount in £ (blank if unknown):', ''); if (a === null) return; void cmd({ type: 'client_account_receipt', remitter: r, purpose: /^(fees|deposit|completion|other)$/.test(p.trim()) ? p.trim() : 'other', amountPennies: a.trim() ? Math.round(Number(a) * 100) : null }); }}>Receipt on Client Account</button>}
        {!exchanged && (pof?.status === 'not_started' || (pof?.status === 'reviewed' && pof.resolution !== 'approve')) ? (
        <span><input className="ep-input" placeholder="Note to the client (optional)" value={pofNote} onChange={(e) => setPofNote(e.target.value)} style={{ width: 260 }} /><button className="ep-btn primary" disabled={busy} onClick={() => { void cmd({ type: 'request_proof_of_funds', noteToClient: pofNote.trim() || null }); setPofNote(''); }}>Send Proof-of-Funds Form</button></span>
      ) : null}
      </> });
  }

  if (has('property_forms')) lane({ id: 'property_forms', order: 'sequence', title: 'Property forms (TA6 / TA10 / TA7)', state: forms.status === 'received' ? 'done' : forms.status === 'requested' ? 'open' : 'idle', 
    tiles: [{ label: `Forms${forms.forms.length ? ` · ${forms.forms.join(', ')}` : ''}`, status: forms.status, detail: forms.requestedAt && !forms.receivedAt ? `requested ${fmtDay(forms.requestedAt)} · the client is chased on the SLA` : forms.receivedAt ? `received ${fmtDay(forms.receivedAt)}` : undefined }],
    actions: <>
      {forms.status === 'not_started' && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'request_property_forms' })}>Send the forms to the client</button>}
      {forms.status !== 'received' && forms.status !== 'not_applicable' && act('property_forms', 'property_forms_received', 'Forms Received', { forms: leasehold ? ['TA6', 'TA10', 'TA7'] : ['TA6', 'TA10'] })}
    </> });

  lane({ id: 'title', order: 'sequence', title: 'Title', state: resolved(s.title.status) ? (has('report_on_title') && s.reportOnTitle.status !== 'sent' ? 'open' : 'done') : s.title.status === 'flagged' ? 'blocked' : buyer && s.contractPack?.requestedAt && !s.title.documentId ? 'open' : 'idle', note: p.tenure === 'any' ? 'freehold or leasehold' : `expected ${p.tenure}`,
    tiles: [
      { label: `Official copies${s.title.facts?.titleNumber ? ` · ${s.title.facts.titleNumber}` : ''}`, documentId: s.title.documentId, focus: 'title', status: s.title.status, detail: s.title.facts?.tenure ?? (buyer && s.contractPack?.requestedAt && !s.title.documentId ? `contract pack asked of the seller's solicitor ${fmtDay(s.contractPack.requestedAt)} · chased on the SLA` : undefined) },
      ...(buyer ? [{ label: "Seller's forms (TA6 / TA7 / TA10)", documentId: s.sellerForms?.documentId ?? undefined, status: s.sellerForms?.receivedAt ? 'read' : 'not_started', detail: s.sellerForms?.receivedAt ? `${s.sellerForms.forms.join(', ')} read ${fmtDay(s.sellerForms.receivedAt)}; answers that matter are issues` : 'arrive with the contract pack; upload under Documents' }] : []),
      ...(has('report_on_title') ? [{ label: 'Report on title', focus: 'report_on_title', status: s.reportOnTitle.status, detail: s.reportOnTitle.sentAt ? `sent ${fmtDay(s.reportOnTitle.sentAt)}` : undefined }] : []),
    ],
    actions: has('report_on_title') ? <>
      {s.stage === 'contract_review' && ['not_started', 'rejected'].includes(s.reportOnTitle.status) && resolved(s.title.status) && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'draft_report_on_title' })}>Draft report on title (AI, needs your approval)</button>}
      {s.reportOnTitle.status === 'approved' && <button className="ep-btn primary" disabled={busy} onClick={() => cmd({ type: 'send_report_on_title' })}>Send approved report to client</button>}
    </> : null });

  if (has('searches') && s.requiredSearches.length > 0) lane({ id: 'searches', title: 'Searches', state: s.requiredSearches.every((t) => resolved(s.searches[t]?.status ?? '')) ? 'done' : s.requiredSearches.some((t) => s.searches[t]?.status === 'flagged') ? 'blocked' : 'open', 
    tiles: s.requiredSearches.map((t) => ({ key: `search:${t}`, label: SEARCH_NAME[t] ?? t, documentId: s.searches[t]?.documentId, focus: t, status: s.searches[t]?.status ?? 'not_started', detail: s.searches[t]?.flags.length ? s.searches[t].flags.map((f) => cap(f.code.toLowerCase())).join(', ') : undefined })) });

  if (has('enquiries') && buyer) lane({ id: 'enquiries', title: 'Our Enquiries', state: Object.values(s.enquiries).length === 0 ? 'idle' : Object.values(s.enquiries).every((q) => ['cleared', 'reviewed', 'withdrawn'].includes(q.status)) ? 'done' : Object.values(s.enquiries).some((q) => q.status === 'flagged') ? 'blocked' : 'open', note: Object.values(s.enquiries).length === 0 ? 'None raised yet — the engine raises them from search and title flags, or you add them below' : `${Object.values(s.enquiries).filter((q) => ['cleared', 'reviewed', 'withdrawn'].includes(q.status)).length} of ${Object.values(s.enquiries).length} resolved`,
    tiles: Object.values(s.enquiries).map((q) => ({ label: `Enquiry ${q.enquiryId}`, documentId: q.documentId, focus: q.enquiryId, status: q.status, detail: q.subject })),
    actions: (s.stage === 'pre_contract' || s.stage === 'contract_review') ? <><input className="ep-input" placeholder="Enquiry id (E3)" value={enquiry.id} onChange={(e) => setEnquiry({ ...enquiry, id: e.target.value })} style={{ width: 110 }} /><input className="ep-input" placeholder="Subject" value={enquiry.subject} onChange={(e) => setEnquiry({ ...enquiry, subject: e.target.value })} style={{ width: 220 }} /><button className="ep-btn" disabled={busy || !enquiry.id || !enquiry.subject} onClick={() => { void cmd({ type: 'raise_enquiry', enquiryId: enquiry.id.trim(), subject: enquiry.subject.trim() }); setEnquiry({ id: '', subject: '' }); }}>Raise enquiry</button></> : null });

  if (has('enquiries') && seller) lane({ id: 'enquiries', title: "Buyer's Enquiries", state: inboundAll.length === 0 ? (s.contractPack?.sentAt ? 'open' : 'idle') : inboundOpen.length ? 'blocked' : 'done', note: inboundAll.length ? `${inboundAll.length} received · ${inboundOpen.length} awaiting our reply` : s.contractPack?.sentAt ? "pack out — awaiting the buyer's enquiries" : 'arrive once the pack is out',
    tiles: inboundAll.map((q) => ({ label: q.id, status: q.repliedAt ? 'replied' : 'raised', detail: `round ${q.round} · ${fmtDay(q.receivedAt)}${q.repliedAt ? ` · replied ${fmtDay(q.repliedAt)}` : ''}` })),
    extra: inboundAll.length ? <div style={{ marginTop: 8 }}>{inboundAll.map((q) => (
      <div key={q.id} className="ep-row">
        {!q.repliedAt && <input type="checkbox" checked={!!replySel[q.id]} onChange={(e) => setReplySel({ ...replySel, [q.id]: e.target.checked })} />}
        <b>{q.id}</b><span style={{ flex: 1 }}>{q.question}</span><Pill s={q.repliedAt ? 'replied' : 'raised'} />
      </div>
    ))}</div> : null,
    actions: <>
      {s.contractPack?.sentAt && !exchanged && <span><input className="ep-input" placeholder="Enquiries received, one per line" value={inbound} onChange={(e) => setInbound(e.target.value)} style={{ width: 360, maxWidth: '100%' }} /><button className="ep-btn" disabled={busy || !inbound.trim()} onClick={() => { const qs = inbound.split(/\n|;/).map((x) => x.trim()).filter(Boolean).map((question) => ({ question })); void cmd({ type: 'buyer_enquiries_received', enquiries: qs }); setInbound(''); }}>Record buyer&apos;s enquiries</button></span>}
      {inboundOpen.length > 0 && act('enquiries', 'enquiry_replies_sent', `Replies Sent (${Object.values(replySel).filter(Boolean).length})`, { enquiryIds: Object.keys(replySel).filter((k) => replySel[k]) }, { primary: true, disabled: !Object.values(replySel).some(Boolean) })}
    </> });

  if (has('mortgage') && s.hasLender) lane({ id: 'mortgage', order: 'sequence', title: remo ? 'New mortgage' : 'Mortgage', state: resolved(s.mortgage.status) ? (deeds.mortgageDeedAt && deeds.certificateOfTitleAt ? 'done' : 'open') : s.mortgage.status === 'flagged' ? 'blocked' : 'open', note: s.mortgage.facts?.lender ?? undefined,
    tiles: [
      { label: 'Offer', status: s.mortgage.status, documentId: s.mortgage.documentId, focus: 'mortgage' },
      { label: 'Mortgage deed', status: deeds.mortgageDeedAt ? 'done' : 'not_started', detail: deeds.mortgageDeedAt ? `executed ${fmtDay(deeds.mortgageDeedAt)} (witnessed)` : undefined },
      { label: 'Certificate of title', status: deeds.certificateOfTitleAt ? 'sent' : 'not_started', detail: deeds.certificateOfTitleAt ? `sent ${fmtDay(deeds.certificateOfTitleAt)}` : undefined },
    ],
    actions: <>
      {!completed && <button className="ep-btn" disabled={busy} onClick={() => { const y = ask("Lender's minimum unexpired lease term in years (blank if none):", s.lenderRequirements?.minUnexpiredYears?.toString() ?? ''); if (y === null) return; const m = ask("Maximum age of searches at exchange, in months (blank if none):", s.lenderRequirements?.maxSearchAgeMonths?.toString() ?? ''); if (m === null) return; const g = ask('Accepts a gifted deposit from outside the family? yes / no / blank', s.lenderRequirements?.acceptsNonFamilyGift == null ? '' : s.lenderRequirements.acceptsNonFamilyGift ? 'yes' : 'no'); if (g === null) return; void cmd({ type: 'record_lender_requirements', minUnexpiredYears: y.trim() ? Number(y) : null, maxSearchAgeMonths: m.trim() ? Number(m) : null, acceptsNonFamilyGift: g.trim() ? /^y/i.test(g) : null }); }}>Lender Requirements</button>}
      {!deeds.certificateOfTitleAt && resolved(s.mortgage.status) && act('mortgage', 'certificate_of_title_sent', 'Certificate of Title Sent')}
      {['pre_contract', 'contract_review', 'pre_exchange'].includes(s.stage) && resolved(s.mortgage.status) && buyer && <button className="ep-btn" disabled={busy} onClick={() => { const r = ask('Why was the offer withdrawn / lapsed?'); if (r) void cmd({ type: 'mortgage_offer_withdrawn', reason: r }); }}>Offer withdrawn</button>}
    </> });

  if (has('redemption') && redemptionApplies) lane({ id: 'redemption', order: 'sequence', title: 'Redemption of the existing mortgage', state: red.status === 'redeemed' || red.status === 'discharged' ? 'done' : red.status === 'received' ? (completed ? 'open' : 'done') : red.status === 'requested' ? 'open' : 'blocked', note: red.lender ?? undefined,
    tiles: [
      { label: 'Redemption statement', status: red.status, detail: red.redemptionPennies != null ? `${gbp(red.redemptionPennies)}${red.validUntil ? ` · valid to ${red.validUntil}` : ''}${red.dailyInterestPennies ? ` · ${gbp(red.dailyInterestPennies)}/day` : ''}` : undefined },
      { label: 'Payment to the lender', status: paidTo('lender') ? 'approved' : 'not_started' },
      { label: 'Redeemed', status: red.status === 'redeemed' || red.status === 'discharged' ? 'redeemed' : 'not_started', detail: red.redeemedAt ? fmtDay(red.redeemedAt) : undefined },
    ],
    actions: <>
      {red.status === 'not_started' && <button className="ep-btn primary" disabled={busy} onClick={() => { const l = ask('Lender?', red.lender ?? ''); if (l !== null) void cmd({ type: 'request_redemption_statement', lender: l || undefined }); }}>Request redemption statement</button>}
      {(red.status === 'not_started' || red.status === 'requested') && act('redemption', 'redemption_statement_received', 'Statement Received')}
      {red.status === 'received' && atLeast('pre_completion') && !paidTo('lender') && authorise('lender', 'other', 'Authorise redemption payment', red.redemptionPennies)}
      {red.status === 'received' && completed && paidTo('lender') && act('redemption', 'mortgage_redeemed', 'Mortgage Redeemed', {}, { primary: true })}
    </> });

  if (has('lender_consent') && s.hasExistingMortgage) lane({ id: 'lender_consent', order: 'sequence', title: "Lender's consent to the transfer", state: consent.status === 'received' ? 'done' : consent.status === 'requested' ? 'open' : 'blocked', note: consent.lender ?? undefined,
    tiles: [{ label: 'Consent', status: consent.status, detail: consent.conditions ?? undefined }],
    actions: <>
      {consent.status === 'not_started' && <button className="ep-btn primary" disabled={busy} onClick={() => { const l = ask('Lender?'); if (l !== null) void cmd({ type: 'request_lender_consent', lender: l || undefined }); }}>Request consent</button>}
      {consent.status !== 'received' && consent.status !== 'not_applicable' && act('lender_consent', 'lender_consent_received', 'Consent Received')}
    </> });

  if (has('co_ownership') && parties > 1) lane({ id: 'co_ownership', title: `Co-ownership · ${parties} clients`, holds: toe ? 'Holds Execution' : 'Holds Completion', state: !s.clientDecisions?.ownership_basis ? 'blocked' : tic && !deeds.deedOfTrustAt ? 'open' : 'done', note: "the clients' decision, advised separately where their interests differ",
    tiles: [
      { label: 'How they hold', status: s.clientDecisions?.ownership_basis ? 'done' : 'not_started', detail: s.clientDecisions?.ownership_basis ? `${pretty(s.clientDecisions.ownership_basis.decision)} · ${fmtDay(s.clientDecisions.ownership_basis.at)}${s.clientDecisions.ownership_basis.note ? ` · ${s.clientDecisions.ownership_basis.note}` : ''}` : undefined },
      ...(tic ? [{ label: 'Declaration of trust', status: deeds.deedOfTrustAt ? 'done' : 'not_started', detail: deeds.deedOfTrustAt ? `executed ${fmtDay(deeds.deedOfTrustAt)}` : undefined }] : []),
    ],
    actions: <>
      {!completed && ['joint_tenants', 'tenants_in_common_equal', 'tenants_in_common_unequal'].map((d) => (
        <span key={d}>{act('co_ownership', 'client_decision_recorded', pretty(d), { subject: 'ownership_basis', decision: d }, { primary: !s.clientDecisions?.ownership_basis, disabled: s.clientDecisions?.ownership_basis?.decision === d })}</span>
      ))}
    </> });

  if (has('survey') && s.survey) {
    const fi = s.clientDecisions?.further_investigation?.decision ?? null;
    const pc = s.clientDecisions?.physical_condition?.decision ?? null;
    const lastReport = s.survey.reports.filter((r) => !r.forIssueId).slice(-1)[0];
    const clientView = pc ?? (fi === 'pursue' ? 'investigating' : fi === 'evidence' ? 'asking_for_evidence' : fi === 'waive' ? 'waived_investigation' : s.survey.status === 'not_started' ? 'not_started' : 'awaiting_client');
    const current = (on: boolean) => (on ? ' ✓' : '');
    // The surveyor's investigations, one row each: the client says what to do about each one, not all at once.
    const fiIssues = Object.values(s.issues ?? {}).filter((i) => i.kind === 'survey_further_investigation' && i.status !== 'withdrawn');
    const investigations: Tile[] = fiIssues.map((i) => {
      const live = i.status === 'open' || i.status === 'negotiating';
      const route = i.status === 'resolved' && i.resolution === 'accepted_as_is' ? 'waive' : i.route ?? null;
      const name = i.title.replace(/^Further investigation:\s*/, '').replace(/ report recommended:.*$/, '');
      const pick = (decision: 'evidence' | 'pursue' | 'waive', label: string) => act('survey', 'client_decision_recorded', `${label}${current(route === decision)}`, { subject: 'further_investigation', decision, scope: [i.id], scopeLabel: name }, { disabled: route === decision || exchanged });
      return {
        label: name,
        depth: 1,
        status: i.status === 'resolved' ? (i.resolution === 'accepted_as_is' ? 'left' : 'cleared') : route === 'evidence' ? 'asking_seller' : route === 'pursue' ? 'arranging_access' : 'client_to_decide',
        detail: i.enquiryIds.length ? `asked of the seller's solicitor (${i.enquiryIds.join(', ')})` : undefined,
        action: live || route === 'waive' ? <>{pick('evidence', 'Evidence')}{pick('pursue', 'Access')}{pick('waive', 'Leave It')}</> : undefined,
      };
    });
    const readingThis = !!readingNow && readingNow.documentId === lastReport?.documentId && (lastReport?.receivedAt ?? null) === readingNow.before;
    const stuck = readingThis && Date.now() - (readingNow?.since ?? 0) > 5 * 60_000;
    const found = lastReport && !lastReport.unread ? [
      lastReport.urgent ? `${lastReport.urgent} urgent` : null,
      lastReport.toInvestigate ? `${lastReport.toInvestigate} to investigate` : null,
      lastReport.legalPoints ? `${lastReport.legalPoints} legal point${lastReport.legalPoints === 1 ? '' : 's'} for us` : null,
    ].filter(Boolean).join(' · ') : '';
    const findings: Tile | null = lastReport ? {
      label: 'Findings',
      depth: 1,
      status: readingThis ? (stuck ? 'stuck' : 'reading') : lastReport.unread ? 'not_read' : 'read',
      detail: readingThis
        ? (stuck ? 'Still reading after five minutes; the Timeline will say if it failed.' : 'Reading the report again; this updates by itself.')
        : lastReport.unread ? 'The report could not be read. Read it again, or record the findings by hand.'
        : found || (lastReport.urgent === undefined ? 'Read before the legal points were asked for; read it again to get them.' : 'Nothing in it needs action.'),
      action: lastReport.documentId ? <button className="ep-btn" disabled={busy || rereading === lastReport.documentId || (readingThis && !stuck)} onClick={() => void readAgain(lastReport.documentId!, lastReport.receivedAt)}>{readingThis && !stuck ? 'Reading…' : 'Read Again'}</button> : undefined,
    } : null;
    lane({ id: 'survey', title: 'Survey', holds: 'Holds Exchange', state: s.survey.status === 'client_satisfied' ? 'done' : s.survey.status === 'not_started' ? 'idle' : s.survey.status === 'further_investigation' || s.survey.status === 'client_renegotiating' ? 'blocked' : 'open', note: s.survey.status === 'not_started' ? 'the client commissions this; it is read when it arrives' : `${s.survey.reports.length} report${s.survey.reports.length === 1 ? '' : 's'} on file`,
      tiles: [...([{ label: 'Report', status: s.survey.reports.length ? 'on_file' : 'not_started', href: lastReport?.documentId ? `/api/v1/documents/${lastReport.documentId}/raw` : undefined }, ...(findings ? [findings] : [])] as Tile[]), ...investigations, { label: "Client's view", status: clientView }],
      // The client can change their mind until exchange: every option stays, the one on record is ticked.
      actions: !exchanged && s.survey.status !== 'not_started' ? <>
        {act('survey', 'client_decision_recorded', `Satisfied${current(pc === 'satisfied')}`, { subject: 'physical_condition', decision: 'satisfied' }, { primary: s.survey.status === 'awaiting_client', disabled: pc === 'satisfied' || s.survey.status === 'further_investigation', title: s.survey.status === 'further_investigation' ? 'Waiting on the further investigation, or the client waiving it' : undefined })}
        {act('survey', 'client_decision_recorded', `Renegotiate${current(pc === 'renegotiate')}`, { subject: 'physical_condition', decision: 'renegotiate' }, { disabled: pc === 'renegotiate' })}
        {act('survey', 'client_decision_recorded', `Withdraw${current(pc === 'withdraw')}`, { subject: 'physical_condition', decision: 'withdraw' }, { disabled: pc === 'withdraw' })}
        {rereadNote && <span className="ep-note">{rereadNote}</span>}
      </> : null });
  }

  if (has('leasehold')) lane({ id: 'leasehold', order: 'sequence', title: 'Leasehold', state: resolved(s.managementPack?.status ?? '') ? (buyer && completed && !s.postCompletion.noticeOfAssignmentAt ? 'open' : 'done') : s.managementPack?.status === 'flagged' ? 'blocked' : s.managementPack?.status === 'requested' ? 'open' : 'idle', note: seller ? 'the pack is obtained from the freeholder / agent for the buyer' : 'LPE1 reviewed as client-advice points',
    tiles: [
      { label: 'Lease', status: s.title?.lease ? 'read' : 'not_started', detail: s.title?.lease ? [s.title.lease.unexpiredYears != null ? `${s.title.lease.unexpiredYears} years left` : null, s.title.lease.groundRentPenniesPa != null ? `ground rent £${(s.title.lease.groundRentPenniesPa / 100).toLocaleString('en-GB')} a year` : null].filter(Boolean).join(' · ') || undefined : undefined, documentId: s.title?.leaseDocumentId ?? undefined, focus: 'title' },
      { label: 'Management pack (LPE1)', status: s.managementPack?.status ?? 'not_started', documentId: s.managementPack?.documentId, focus: 'management_pack' },
      ...(buyer ? [{ label: 'Notice of assignment', status: s.postCompletion.noticeOfAssignmentAt ? 'sent' : 'not_started' }] : []),
    ],
    actions: <>
      {['pre_contract', 'contract_review', 'pre_exchange'].includes(s.stage) && s.managementPack?.status === 'not_started' && <button className="ep-btn primary" disabled={busy} onClick={() => { const from = ask('Requested from?', seller ? 'Freeholder / managing agent' : "Seller's solicitor"); if (from) void cmd({ type: 'management_pack_requested', from }); }}>Management pack requested</button>}
      {buyer && completed && !s.postCompletion.noticeOfAssignmentAt && act('leasehold', 'notice_of_assignment_served', 'Notice of Assignment Served')}
    </> });

  if (p.hasExchange) lane({ id: 'exchange', order: 'sequence', title: seller ? 'Contract pack & exchange' : 'Contract & exchange', state: exchanged ? 'done' : s.stage === 'pre_exchange' ? (s.exchange.conditionsMet ? 'open' : 'blocked') : 'idle', note: exchanged ? `exchanged ${fmtDay(s.exchange.exchangedAt)} · completion ${s.exchange.completionDate}` : s.targetExchangeDate ? `target exchange ${fmtDay(s.targetExchangeDate)}` : undefined,
    tiles: [
      ...(seller ? [{ label: 'Contract pack', status: s.contractPack?.sentAt ? 'sent' : 'not_started', detail: s.contractPack?.sentAt ? `sent ${fmtDay(s.contractPack.sentAt)}` : undefined }] : []),
      { label: 'Contract approved / signed', status: s.readiness.signedContractHeldAt ? 'done' : s.readiness.contractApprovedAt ? 'approved' : 'not_started' },
      ...(buyer ? [{ label: 'Deposit', status: s.deposit.received ? 'received' : 'awaiting' }] : []),
      ...(s.requireExchangeAuthority ? [{ label: "Client's authority to exchange", status: s.clientDecisions?.exchange_authority?.decision === 'authorised' ? 'done' : 'not_started' }] : []),
      { label: 'Exchange', status: exchanged ? 'done' : s.exchange.conditionsMet ? 'approved' : 'awaiting', detail: exchanged ? undefined : s.exchange.conditionsMet ? 'everything is in place; exchange when the client instructs' : 'waits on every item above and the client\'s go-ahead' },
      ...(exchanged ? [{ label: 'Completion statement', status: s.completion.statementGeneratedAt ? 'done' : 'not_started' }] : []),
    ],
    actions: <>
      {seller && !s.contractPack?.sentAt && atLeast('pre_contract') && act('exchange', 'contract_pack_sent', 'Contract Pack Sent', {}, { primary: true, disabled: forms.status !== 'received' || s.title.status === 'awaiting', title: forms.status !== 'received' ? 'The property forms are not in' : s.title.status === 'awaiting' ? 'Official copies are not on file' : undefined })}
      {['contract_review', 'pre_exchange'].includes(s.stage) && !s.readiness.contractApprovedAt && act('exchange', 'contract_approved', 'Contract Approved')}
      {['contract_review', 'pre_exchange'].includes(s.stage) && !s.readiness.signedContractHeldAt && act('exchange', 'signed_contract_held', 'Signed Contract Held')}
      {buyer && ['contract_review', 'pre_exchange'].includes(s.stage) && !s.deposit.received && act('exchange', 'deposit_received', 'Deposit Received')}
      {!exchanged && s.requireExchangeAuthority && s.clientDecisions?.exchange_authority?.decision !== 'authorised' && ['contract_review', 'pre_exchange'].includes(s.stage) && act('exchange', 'client_decision_recorded', 'Client Authorises Exchange', { subject: 'exchange_authority', decision: 'authorised' }, { primary: true })}
      {s.stage === 'pre_exchange' && s.exchange.conditionsMet && !exchanged && act('exchange', 'contracts_exchanged', 'Contracts Exchanged', {}, { primary: true })}
      {['pre_exchange', 'exchanged'].includes(s.stage) && !s.completion.statementGeneratedAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'draft_completion_statement' })}>Draft Completion Statement</button>}
      {s.stage === 'exchanged' && act('exchange', 'completion_statement_generated', 'Completion Statement Produced', {}, { primary: true })}
      {exchanged && !completed && <button className="ep-btn" disabled={busy} onClick={() => { const d = ask('New contractual completion date (YYYY-MM-DD):', s.exchange.completionDate ?? ''); if (d) { const r = ask('Reason?'); if (r) void cmd({ type: 'change_completion_date', completionDate: d, reason: r }); } }}>Change completion date</button>}
    </> });

  // Signing: every deed the client signs, wet ink or electronic, with the signed copy as the gate.
  {
    const sg = s.signing ?? { packSentAt: null, documents: [], methods: {}, envelopes: {} };
    const toSign: Array<'transfer' | 'mortgage_deed' | 'deed_of_trust'> = [];
    if (seller || toe || (buyer && parties >= 2)) toSign.push('transfer');
    if (s.hasLender && (buyer || remo)) toSign.push('mortgage_deed');
    if (tic) toSign.push('deed_of_trust');
    const LABEL = { transfer: 'Transfer (TR1)', mortgage_deed: 'Mortgage deed', deed_of_trust: 'Declaration of trust' } as const;
    const CMD = { transfer: 'transfer_deed_executed', mortgage_deed: 'mortgage_deed_executed', deed_of_trust: 'deed_of_trust_executed' } as const;
    const done = (d: keyof typeof LABEL) => (d === 'transfer' ? deeds.transferDeedAt : d === 'mortgage_deed' ? deeds.mortgageDeedAt : deeds.deedOfTrustAt);
    const extra = (d: keyof typeof LABEL): Record<string, unknown> => (d === 'transfer' ? { witnessed: true, parties: s.partyNames?.length ? s.partyNames : undefined } : d === 'mortgage_deed' ? { witnessed: true } : { parties: s.partyNames });
    if (toSign.length) lane({
      id: 'signing', title: 'Signing', holds: 'Holds Completion', order: 'parallel',
      state: toSign.every((d) => done(d)) ? 'done' : sg.packSentAt ? 'open' : 'idle',
      note: toSign.every((d) => done(d)) ? 'every deed signed and on file' : sg.packSentAt ? `pack sent ${fmtDay(sg.packSentAt)}` : 'sent once the contract is approved',
      tiles: toSign.map((d) => {
        const method = sg.methods[d] ?? 'wet';
        const env = sg.envelopes[d];
        const signed = done(d);
        return {
          label: LABEL[d],
          status: signed ? 'signed' : env ? 'out_for_e_signature' : sg.packSentAt ? 'with_client' : 'not_sent',
          detail: signed ? `signed copy on file ${fmtDay(signed)}` : method === 'electronic' ? `electronic${env ? ` via ${env.provider}` : ''}` : 'wet ink · original posted back to us',
          action: signed || completed ? undefined : <>
            {act('signing', CMD[d], 'Record Signed Copy', extra(d), { primary: !!sg.packSentAt })}
            {!env && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'set_signing_method', document: d, method: method === 'wet' ? 'electronic' : 'wet' })}>{method === 'wet' ? 'Sign Electronically' : 'Wet Ink Instead'}</button>}
          </>,
        };
      }),
      actions: !completed && toSign.some((d) => !done(d)) ? <>
        <button className="ep-btn primary" disabled={busy || packBusy} onClick={() => void sendPack()}>{packBusy ? 'Sending…' : sg.packSentAt ? 'Send the Pack Again' : 'Send Signing Pack'}</button>
        {packNote && <span className="ep-note">{packNote}</span>}
      </> : null,
    });
  }

  if (buyer || remo) {
    const pc = s.preCompletion ?? { insuranceConfirmedAt: null, insurer: null, prioritySearchAt: null, prioritySearchExpiresAt: null, bankruptcySearchAt: null };
    const all = !!(pc.bankruptcySearchAt && pc.prioritySearchAt && pc.insuranceConfirmedAt);
    const os1Expired = !!(pc.prioritySearchExpiresAt && Date.parse(pc.prioritySearchExpiresAt) < Date.now() && !completed);
    lane({ id: 'pre_completion_checks', title: "Lender's pre-completion checks", holds: buyer && s.hasLender ? 'Holds Completion' : undefined, state: all && !os1Expired ? 'done' : s.stage === 'pre_completion' ? (buyer && s.hasLender ? 'blocked' : 'open') : 'idle', note: buyer && s.hasLender ? undefined : 'good practice; not a gate without a lender',
      tiles: [
        { label: 'Bankruptcy search (K16)', status: pc.bankruptcySearchAt ? 'done' : 'not_started', detail: pc.bankruptcySearchAt ? `clear ${fmtDay(pc.bankruptcySearchAt)}` : undefined },
        { label: 'Priority search (OS1)', status: pc.prioritySearchAt ? (os1Expired ? 'expired' : 'done') : 'not_started', detail: pc.prioritySearchExpiresAt ? `priority to ${pc.prioritySearchExpiresAt}` : undefined },
        { label: 'Buildings insurance', status: pc.insuranceConfirmedAt ? 'done' : 'not_started', detail: pc.insurer ?? undefined },
      ],
      actions: !completed && atLeast('pre_exchange') ? <>
        {!pc.bankruptcySearchAt && act('pre_completion_checks', 'bankruptcy_search_clear', 'Bankruptcy Search Clear', {})}
        {(!pc.prioritySearchAt || os1Expired) && <button className="ep-btn" disabled={busy} onClick={() => { const d = ask('Priority period expires on (YYYY-MM-DD):'); if (d) void cmd({ type: 'priority_search_made', expiresAt: d }); }}>Priority Search Made</button>}
        {!pc.insuranceConfirmedAt && <button className="ep-btn" disabled={busy} onClick={() => { const i = ask('Insurer (as on the policy):'); if (i !== null) void cmd({ type: 'buildings_insurance_confirmed', insurer: i || null }); }}>Buildings Insurance Confirmed</button>}
      </> : null });
  }

  {
    const firm = verified('firm_client_account');
    const needsRequest = p.fundsFrom.includes('lender') || p.fundsFrom.includes('client');
    lane({ id: 'completion', order: 'sequence', title: 'Completion & money', state: completed ? (seller && !paidTo('client') ? 'open' : 'done') : s.stage === 'pre_completion' ? 'open' : 'idle', note: completed ? `completed ${fmtDay(s.completion.confirmedAt)}` : p.fundsFrom.length ? `money from: ${p.fundsFrom.map((f) => pretty(f)).join(', ')}` : undefined,
      tiles: [
        ...(p.fundsFrom.includes('lender') ? [{ label: remo ? 'Advance from the new lender' : 'Lender funds', status: s.completion.fundsReceivedAt ? 'received' : openWaits.some((w) => w.key === 'funds' && w.subject === 'lender') ? 'requested' : 'not_started' }] : []),
        ...(p.fundsFrom.includes('client') ? [{ label: "Client's balance", status: s.completion.fundsReceivedAt ? 'received' : openWaits.some((w) => w.key === 'funds' && w.subject === 'client') ? 'requested' : 'not_started' }] : []),
        ...(p.fundsFrom.includes('buyer_solicitor') ? [{ label: "Completion monies from the buyer's solicitor", status: s.completion.fundsReceivedAt ? 'received' : 'awaiting' }] : []),
        ...(p.fundsFrom.includes('incoming_owner') && (s.considerationPennies ?? 0) > 0 ? [{ label: `Consideration from the incoming owner · ${gbp(s.considerationPennies)}`, status: s.completion.fundsReceivedAt ? 'received' : 'awaiting' }] : []),
        ...(buyer ? [{ label: "Completion payment to the seller's solicitor", status: paidTo('seller_solicitor', 'completion_monies') ? 'approved' : 'not_started' }] : []),
        { label: 'Completion', status: completed ? 'done' : 'not_started', detail: completed ? fmtDay(s.completion.confirmedAt) : undefined },
        ...(seller && completed ? [{ label: 'Balance to the client', status: paidTo('client') ? 'approved' : 'not_started' }] : []),
      ],
      actions: s.stage === 'pre_completion' && !completed ? <>
        {needsRequest && firm.length === 0 && !s.completion.fundsReceivedAt && <span className="ep-block" style={{ display: 'inline-block', marginRight: 6 }}>Firm client-account details not verified.</span>}
        {needsRequest && firm.length > 0 && !s.completion.fundsReceivedAt && pickAccount('firm_client_account', firm)}
        {p.fundsFrom.includes('lender') && firm.length > 0 && s.hasLender && !openWaits.some((w) => w.key === 'funds' && w.subject === 'lender') && !s.completion.fundsReceivedAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'funds_requested', fromRole: 'lender', bankDetailsId: payFrom.firm_client_account ?? firm[0].id })}>Request {remo ? 'the advance' : 'lender funds'}</button>}
        {p.fundsFrom.includes('client') && firm.length > 0 && !openWaits.some((w) => w.key === 'funds' && w.subject === 'client') && !s.completion.fundsReceivedAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'funds_requested', fromRole: 'client', bankDetailsId: payFrom.firm_client_account ?? firm[0].id })}>Request client funds</button>}
        {p.fundsFrom.includes('isa_provider') && firm.length > 0 && !openWaits.some((w) => w.key === 'funds' && w.subject === 'isa_provider') && !s.completion.fundsReceivedAt && <button className="ep-btn" disabled={busy} onClick={() => cmd({ type: 'funds_requested', fromRole: 'isa_provider', bankDetailsId: payFrom.firm_client_account ?? firm[0].id })}>Request The ISA Bonus</button>}
        {openWaits.filter((w) => w.key === 'funds').map((w) => <span key={w.subject}>{act('completion', 'funds_received', `${pretty(w.subject)} Funds Received`, { fromRole: w.subject })}</span>)}
        {p.fundsFrom.includes('buyer_solicitor') && !s.completion.fundsReceivedAt && act('completion', 'funds_received', "Completion Monies Received from the Buyer's Solicitor", { fromRole: 'buyer_solicitor' }, { primary: true })}
        {p.fundsFrom.includes('incoming_owner') && (s.considerationPennies ?? 0) > 0 && !s.completion.fundsReceivedAt && act('completion', 'funds_received', 'Consideration Received', { fromRole: 'incoming_owner' }, { primary: true })}
        {buyer && !paidTo('seller_solicitor', 'completion_monies') && authorise('seller_solicitor', 'completion_monies', 'Authorise completion payment')}
        {act('completion', 'completion_confirmed', 'Completion Confirmed', {}, { primary: true })}
      </> : seller && completed && !paidTo('client') ? authorise('client', 'other', 'Authorise balance to the client') : null });
  }

  lane({ id: 'registration', order: 'sequence', title: p.registration === 'ap1' ? 'Registration' : 'Discharge & close', state: closed ? 'done' : atLeast('completed') ? 'open' : 'idle', note: p.registration === 'ap1' ? 'SDLT within 14 days; AP1 within the priority period' : "the buyer's solicitor registers; we see the charge discharged and close",
    tiles: [
      ...(p.registration === 'ap1' && (buyer || toe) ? [{ label: 'SDLT', status: s.postCompletion.sdltSubmittedAt ? 'sent' : s.sdltNotRequiredAt ? 'not_required' : 'not_started', detail: view.sdlt ? `estimate ${gbp(view.sdlt.estimatePennies)} · ${view.sdlt.basis}${view.sdlt.declared ? '' : ' (no basis declared)'}` : undefined }] : []),
      ...(p.registration === 'ap1' ? [{ label: 'AP1', status: s.postCompletion.ap1ConfirmedAt ? 'done' : s.postCompletion.ap1SubmittedAt ? 'requested' : 'not_started', detail: s.postCompletion.ap1ConfirmedAt ? `registered ${fmtDay(s.postCompletion.ap1ConfirmedAt)}` : undefined }] : []),
      ...(redemptionApplies ? [{ label: 'Discharge (DS1 / e-DS1)', status: red.status === 'discharged' ? 'discharged' : red.status === 'redeemed' ? 'awaiting' : 'not_started' }] : []),
      { label: 'File', status: closed ? 'done' : 'not_started', detail: closed ? `closed ${fmtDay(s.closedAt)}` : undefined },
    ],
    actions: atLeast('completed') && !closed ? <>
      {p.registration === 'ap1' && !s.postCompletion.sdltSubmittedAt && !s.sdltNotRequiredAt && act('registration', 'sdlt_submitted', 'SDLT Return Filed')}
      {p.registration === 'ap1' && !s.postCompletion.sdltSubmittedAt && !s.sdltNotRequiredAt && <button className="ep-btn" disabled={busy} onClick={() => { const r = ask('Why is no SDLT return due? (recorded as your determination)'); if (r) void cmd({ type: 'sdlt_not_required', reason: r }); }}>No SDLT return due</button>}
      {p.registration === 'ap1' && !s.postCompletion.ap1SubmittedAt && act('registration', 'ap1_submitted', 'AP1 Lodged')}
      {p.registration === 'ap1' && s.postCompletion.ap1SubmittedAt && !s.postCompletion.ap1ConfirmedAt && act('registration', 'ap1_confirmed', 'Registration Confirmed', {}, { primary: true })}
      {redemptionApplies && red.status === 'redeemed' && act('registration', 'discharge_confirmed', 'Discharge Confirmed', {}, { primary: true })}
      {s.stage === 'post_completion' && <button className="ep-btn" disabled={busy} onClick={() => { if (window.confirm('Close the file? Nothing further can be recorded except corrections.')) void cmd({ type: 'close_matter' }); }}>Close file</button>}
    </> : null });

  // A sub-block with a decision waiting on it links straight to that decision.
  const linkFor = (x: Tile): string | undefined => {
    const subj = x.key?.startsWith('search:') ? x.key.slice(7) : /^Enquiry (\S+)/.exec(x.label)?.[1] ?? null;
    const kind = x.key?.startsWith('search:') ? 'search' : x.label.startsWith('Enquiry ') ? 'enquiry' : x.label.startsWith('ID / AML') ? 'id_check' : x.label.startsWith('Offer') ? 'mortgage' : x.label.startsWith('Official copies') ? 'title' : x.label.startsWith('Report on title') ? 'report_on_title' : x.label.startsWith('Proof of funds') ? 'proof_of_funds' : x.label.startsWith('Management pack') ? 'management_pack' : null;
    const d = kind ? view.pendingDecisions.find((dd) => dd.kind === kind && (!subj || (dd.subject ?? '').split(':').pop() === subj)) : null;
    return d ? `/conveyi/decisions/${d.eventId}` : undefined;
  };
  for (const l of lanes) for (const x of l.tiles) if (!x.href) x.href = linkFor(x);
  const current = openLane === undefined ? (lanes.find((l) => l.state === 'blocked') ?? lanes.find((l) => l.state === 'open'))?.id ?? null : openLane;
  const toggle = (l: LaneDef) => setOpenLane(current === l.id ? null : l.id);

  return (
    <div className="ep" onClickCapture={(e) => { const l = (e.target as HTMLElement).closest('[data-lane]'); if (l) setActiveLane(l.getAttribute('data-lane')); }}>
      <style>{WORK_CSS}</style>
      {s.manualHandling.required && <div className="ep-err">Manual handling required: {pretty(s.manualHandling.reason ?? '')}. Automation is paused on this case.</div>}

      {section === 'flow' && <Flow tiers={PHASES.map((ph) => ({ id: ph.id, label: ph.label, items: ph.lanes.map((id) => lanes.find((l) => l.id === id)).filter((l): l is LaneDef => !!l), unfed: new Set(ph.unfed ?? []) })).filter((c) => c.items.length)} current={current} toggle={toggle} noticeFor={noticeFor} />}
      {section === 'flow' && (
        <div className="ep-legend" aria-label="Legend">
          <span><i className="ep-who"><User size={10} /></i>Sign-off</span>
          <span><i className="ep-who"><Zap size={10} /></i>Automatic</span>
          <span><i className="ep-who doc"><FileText size={10} /></i>Creates a document</span>
          <span><i className="ep-who"><Lock size={10} /></i>Holds a later gate</span>
        </div>
      )}

      {sheetDialog}

      {section === 'tasks' && (<>
      <div className="ep-sec">To Do ({view.pendingDecisions.length})</div>
      <DecisionFeed api={api} matterId={matterId} onResolved={onChanged} />

      {openWaits.length > 0 && (
        <>
          <div className="ep-sec">Waiting On Others ({openWaits.length})</div>
          <div className="ep-grid">
            {openWaits.map((w) => {
              const who = w.chase ? (WAIT_PARTY[w.chase.recipientRole] ?? w.chase.recipientRole.replace(/_/g, ' ')) : null;
              const proposes = (view.levels?.chase ?? 'propose') === 'propose';
              const chased = w.chasesSentAt.length;
              return (
                <div key={`${w.key}:${w.subject}`} className="ep-tile">
                  <b>{cap(w.key)}{w.subject && !/^[0-9a-f-]{20,}$/i.test(w.subject) ? ` · ${w.subject}` : ''}{who ? <span style={{ fontWeight: 500, color: '#64748b' }}> from {who}</span> : null}</b>
                  <span className="d" style={{ display: 'block' }}>Asked {fmtDay(w.openedAt)}{chased ? ` · chased ${chased === 1 ? 'once' : `${chased} times`}` : ''}{w.escalations.some((e) => !e.resolvedAt) ? ' · escalated' : ''}</span>
                  {w.chase ? (
                    <span className="d" style={{ display: 'block', color: w.chase.dueInWorkingDays <= 0 ? '#b45309' : undefined }}>
                      {w.chase.dueInWorkingDays > 0
                        ? `${proposes ? 'A chase is proposed to you' : 'The system chases them'} on ${fmtDay(w.chase.dueDate)} (${w.chase.dueInWorkingDays} working day${w.chase.dueInWorkingDays === 1 ? '' : 's'})`
                        : proposes ? 'Chase due: it is proposed to you on the next sweep' : 'Chase due: it goes on the next sweep'}
                    </span>
                  ) : <span className="d" style={{ display: 'block' }}>No further chase scheduled</span>}
                  <div className="acts" style={{ marginTop: 4 }}><button className="ep-btn" style={{ margin: 0, padding: '3px 9px', fontSize: 11.5 }} disabled={busy || !w.chase} onClick={() => cmd({ type: 'chase_now', waitKey: w.key, subject: w.subject || null })}>Chase Now Instead</button></div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Money: payee bank details ── */}
      <div className="ep-sec">Bank Details</div>
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
      </>)}
      {err && !activeLane && <div className="ep-err">{err}</div>}
    </div>
  );
}

export { Pill as WorkPill };
export type { EngineState as WorkState };
