'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PasswordInput } from './PasswordInput';
import { BusyButton } from './BusyButton';
import { FilePick } from './FilePick';
import { LenderPicker } from './LenderPicker';
import { AddressAndSend, addressFor } from './AddressAndSend';
import { uploadCaseFile } from './uploadCaseFile';
import { Mail, Calendar, Check, Upload, CheckCircle, CreditCard, User, Shield, Building, Users, Ban, Hand, Search } from '@/app/shared/icons';
import { SEVERITIES, SEVERITY_CSS, SEVERITY_LABEL, type Severity } from './severity';
import { fmtDay, pretty, type Api, type CaseDocument, type EngineState, type IssueCatalogue, type IssueRow, type IssueStepView, type ResolutionField } from './types';

/**
 * Issues on a case: what has gone wrong, what it stops, and when it should be sorted by.
 * One row each: the problem, one plain line under it, and its action (Resolve; Try Again or
 * the password for the kinds closed by their own act). Resolving asks for what that outcome
 * needs: an indemnity its insurer and premium, an extension its new expiry, evidence its
 * document (picked from the case or uploaded there and then). Everything else is under More,
 * each an inline form. Context (who is running late) sits apart: it holds nothing and makes
 * no task. The catalogue comes from /engine/spec, so the panel never offers what the machine refuses.
 */
/** A step's icon: what kind of thing it does, not always an envelope. */
const STEP_ICON: Record<string, typeof Mail> = { mail: Mail, calendar: Calendar, doc: Upload, check: CheckCircle, money: CreditCard, refer: User, shield: Shield, case: Building, people: Users, stop: Ban, pause: Hand, search: Search };
const gbp = (p: number) => `£${(p / 100).toLocaleString('en-GB')}`;
const pennies = (v: string) => Math.round(Number(v.replace(/[^0-9.]/g, '')) * 100);
const clean = (s: string | null | undefined) => (s ?? '').replace(/\n?\[(proposal|retry):[^\]]*\]/g, '').replace(/\s*\[[a-z-]+:[^\]]*\]/g, '').trim();
/** Title Case for labels the catalogue gives in sentence case ("title defect / discrepancy" → "Title Defect / Discrepancy"). */
const tc = (s: string) => s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const todayIso = () => new Date().toISOString().slice(0, 10);
/** Weekdays from today: the default resolve-by the raise form suggests (the engine applies bank holidays and the target dates). */
const inWorkingDays = (n: number) => { const d = new Date(); let left = n; while (left > 0) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) left -= 1; } return d.toISOString().slice(0, 10); };
const daysBetween = (from: string, to: string) => Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000);
const PAYERS: Array<[string, string]> = [['buyer', 'Buyer'], ['seller', 'Seller'], ['shared', 'Shared'], ['lender', 'Lender'], ['other', 'Other']];

const CSS = `
.is{display:grid;gap:10px}
.is-h{display:flex;align-items:center;gap:10px}
.is-h h3{margin:0;font-size:13px;font-weight:800;color:#0f172a;letter-spacing:.02em;text-transform:uppercase}
.is-h .n{font-size:12px;color:#64748b}
.is-h .sp{margin-left:auto}
.is-list{background:#fff;border:1px solid #e6e8ee;border-radius:12px;max-height:min(640px,70vh);overflow-y:auto;overscroll-behavior:contain}
.is-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:11px 14px;border-top:1px solid #f1f5f9;align-items:start}
.is-row:first-child{border-top:0}
.is-t{font-size:13.5px;font-weight:700;color:#0f172a;line-height:1.35}
.is-s{font-size:12px;color:#64748b;margin-top:3px;display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px}
.is-s i.sev{font-style:normal}
.is-s span:not(:last-child)::after{content:'·';margin-left:6px;color:#cbd5e1;font-weight:400}
.is-s .late{color:#b91c1c;font-weight:700}
.is-s .soon{color:#b45309;font-weight:700}
.is-s .stops{color:#334155;font-weight:600}
.is-d{font-size:12.5px;color:#475569;margin-top:5px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-line}
.is-d.open{display:block}
.is-more-d{border:0;background:none;padding:0;font:inherit;font-size:11.5px;font-weight:700;color:#5A27E0;cursor:pointer}
.is-acts{display:flex;gap:6px;align-items:center}
.is-menu{background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 12px 32px rgba(15,23,42,.14);padding:4px;min-width:220px;display:grid}
.is-menu button{text-align:left;border:0;background:none;padding:7px 10px;border-radius:7px;font:inherit;font-size:13px;color:#0f172a;cursor:pointer}
.is-menu button:hover{background:#f5f3ff}
.is-menu button.bad{color:#b91c1c}
.is-menu hr{border:0;border-top:1px solid #f1f5f9;margin:3px 0}
.is-form{grid-column:1 / -1;display:grid;gap:10px;background:#f8fafc;border:1px solid #e6e8ee;border-radius:10px;padding:12px;margin-top:6px}
.is-form .g{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.is-form label,.is-form .is-field{display:grid;gap:4px;font-size:11.5px;font-weight:700;color:#475569}
.is-form label > select{justify-self:start}
.is-form label.chk{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#0f172a}
.is-form .ep-input{width:100%;box-sizing:border-box;margin:0}
.is-form textarea.ep-input{resize:vertical;font:inherit;font-size:13px}
.is-form .doc{display:flex;gap:6px;align-items:center}
.is-form .doc select{flex:1;min-width:0}
.is-form .f{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
.is-form .fx{font-size:12px;color:#64748b;margin-right:auto}
.is-form .bad{font-size:12.5px;color:#b91c1c;font-weight:600}
.is-ctx .is-t{font-weight:600;color:#334155}
.is-sec{font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.04em}
.is-steps{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.is-steps .ep-btn{margin:0;display:inline-flex;align-items:center;gap:6px}
.is-steps .ep-btn.on{border-color:#5A27E0;color:#5A27E0;background:#f5f3ff}
.is-steps .ep-btn.sent{color:#166534;border-color:#bbf7d0;background:#f0fdf4}
.is-steps .ep-btn.bad{color:#b91c1c;border-color:#fecaca;margin-left:auto}
.is-comp{display:grid;gap:8px;background:#fff;border:1px solid #e6e8ee;border-radius:10px;padding:10px 12px}
.is-comp .to{font-size:12px;color:#475569;font-weight:600}
.is-comp textarea.ep-input{min-height:170px}
.is-comp textarea.ep-input.short{min-height:0}
.is-comp label{display:grid;gap:4px;font-size:11.5px;font-weight:700;color:#475569}
.is-comp .warn{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:8px;padding:8px 10px;font-size:12.5px;line-height:1.45}
.is-comp .f{display:flex;gap:8px;justify-content:flex-end}
.ep-btn.primary.is-red{background:#dc2626;border-color:#dc2626;color:#fff}
.is-comp .wait{font-size:12.5px;color:#64748b;padding:8px 0}
.is-log{display:grid;gap:3px;font-size:12px;color:#475569}
.is-log div{display:flex;gap:8px}
.is-log time{color:#94a3b8;flex:none;min-width:48px}
.is-hr{border:0;border-top:1px solid #e6e8ee;margin:2px 0}
.is-out{padding:10px 14px;border-radius:10px;font-size:13px;font-weight:600;background:#dcfce7;color:#166534;border:1px solid #bbf7d0}
.is-out.warn{background:#fef3c7;color:#92400e;border-color:#fde68a}
.is-empty{padding:12px 14px;font-size:12.5px;color:#64748b}
.is-closed{font-size:12px;color:#64748b}
.is-closed > button{border:0;background:none;padding:0;font:inherit;font-size:12px;font-weight:700;color:#475569;cursor:pointer}
.is-closed div{padding:5px 0;border-top:1px solid #f1f5f9}
.is-veil{position:fixed;inset:0;background:rgba(15,23,42,.38);z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:80px 16px 16px}
.is-dlg{background:#fff;border-radius:14px;width:100%;max-width:540px;box-shadow:0 24px 64px rgba(15,23,42,.24);padding:18px 20px;display:grid;gap:10px}
.is-dlg h2{margin:0;font-size:16px;font-weight:800}
.is-dlg label{display:grid;gap:4px;font-size:12px;font-weight:700;color:#475569}
.is-dlg .ep-input{width:100%;box-sizing:border-box;margin:0}
.is-dlg textarea.ep-input{resize:vertical;font:inherit;font-size:13px}
.is-dlg .two{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
@media (max-width:560px){.is-dlg .two{grid-template-columns:1fr}}
.is-dlg .f{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
` + SEVERITY_CSS;

/** The More menu's actions: each one an inline form (a note, a date, a reason) and one command. */
/** Most severe first. */
const SEV_RANK: Record<string, number> = { critical: 2, warning: 1, info: 0 };
type SmallMode = 'note' | 'negotiating' | 'date' | 'ask' | 'release' | 'hold' | 'severity' | 'delete' | 'fatal';
type FormMode = 'resolve' | 'password' | SmallMode;
const FORM: Record<SmallMode, { field: string; button: string; done: string; required: boolean }> = {
  note: { field: 'Note', button: 'Add Note', done: 'Added', required: true },
  negotiating: { field: "What's Happening", button: 'Mark Negotiating', done: 'Updated', required: true },
  date: { field: 'Resolve By', button: 'Save Date', done: 'Saved', required: true },
  ask: { field: 'Question For The Other Side', button: 'Raise Enquiry', done: 'Raised', required: true },
  release: { field: 'Why It No Longer Holds The Case', button: 'Release', done: 'Released', required: true },
  hold: { field: 'Why It Holds Exchange', button: 'Hold Exchange', done: 'Holding', required: true },
  severity: { field: 'Why', button: 'Change Severity', done: 'Changed', required: true },
  delete: { field: 'Why (Optional)', button: 'Delete Issue', done: 'Deleted', required: false },
  fatal: { field: 'Why The Transaction Cannot Go On', button: 'Abandon The Case', done: 'Abandoned', required: true },
};

export function IssuesPanel({ api, state, busy, cmd, onChanged, only, onCancel, err = null, raiseOnly = false }: {
  api: Api; state: EngineState; busy: boolean; cmd: (body: Record<string, unknown>) => Promise<unknown>; onChanged?: () => void;
  /** The case's last command error: shown on the form whose command it was. */
  err?: string | null;
  /** Just this issue, opened straight onto its resolve form (the Tasks list shows it in place); `onCancel` closes it there. */
  only?: string; onCancel?: () => void;
  /** Just the Raise Issue dialog, open (a task's header opens it); `onCancel` when it closes. */
  raiseOnly?: boolean;
}) {
  const [cat, setCat] = useState<IssueCatalogue | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [unfold, setUnfold] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<{ id: string; mode: FormMode } | null>(null);
  const [text, setText] = useState('');
  const [confirmFatal, setConfirmFatal] = useState(false);
  // The resolve form: the outcome, its fields, the note.
  const [resolution, setResolution] = useState('other');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [formErr, setFormErr] = useState<string | null>(null);
  const [docs, setDocs] = useState<CaseDocument[] | null>(null);
  const [raising, setRaising] = useState(raiseOnly);
  useEffect(() => { if (raiseOnly && !raising) onCancel?.(); }, [raiseOnly, raising, onCancel]);
  const [draft, setDraft] = useState({ kind: '', title: '', detail: '', gate: 'default' as 'default' | 'exchange' | 'completion' | 'none', resolveBy: '', severity: 'default' as 'default' | Severity });
  const [sev, setSev] = useState<Severity>('critical');
  const [newValue, setNewValue] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [pw, setPw] = useState('');
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  // A next step open on the form: a message being drafted and edited, or new dates.
  const [step, setStep] = useState<{ id: string; kind: 'message' | 'dates' | 'action'; to?: string; subject: string; body: string; loading: boolean } | null>(null);
  const [sentSteps, setSentSteps] = useState<Set<string>>(new Set());
  /** The outcome step last picked (it set the outcome below). */
  const [pickedOutcome, setPickedOutcome] = useState<string | null>(null);
  useEffect(() => { if (!outcome) return; const t = setTimeout(() => setOutcome(null), 8000); return () => clearTimeout(t); }, [outcome]);

  const menuRef = useRef<HTMLDivElement | null>(null);
  // The menu is drawn over the page (not inside the scrolling list, which would clip it), under its button, or above it near the bottom of the window.
  const popRef = useRef<HTMLDivElement | null>(null);
  const [menuAt, setMenuAt] = useState<{ right: number; top: number; bottom: number } | null>(null);
  const openMenu = (id: string, btn: HTMLElement) => {
    if (menu === id) { setMenu(null); return; }
    const r = btn.getBoundingClientRect();
    setMenuAt({ right: window.innerWidth - r.right, top: r.bottom + 4, bottom: window.innerHeight - r.top + 4 });
    setMenu(id);
  };
  useEffect(() => { api<{ issues: IssueCatalogue }>('/engine/spec').then((s) => setCat(s.issues)).catch(() => setCat(null)); }, [api]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { const t = e.target as Node; if (menuRef.current && !menuRef.current.contains(t) && !popRef.current?.contains(t)) setMenu(null); };
    const gone = (e: Event) => { if (!popRef.current?.contains(e.target as Node)) setMenu(null); };
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', gone, true);
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('scroll', gone, true); };
  }, [menu]);

  const kinds = useMemo(() => cat?.kinds ?? [], [cat]);
  const byKind = useMemo(() => Object.fromEntries(kinds.map((k) => [k.kind, k])), [kinds]);
  const resById = useMemo(() => Object.fromEntries((cat?.resolutions ?? []).map((r) => [r.id, r])), [cat]);
  const formless = useMemo(() => new Set(cat?.formless ?? ['send_failed', 'file_locked']), [cat]);
  const fields: ResolutionField[] = resById[resolution]?.fields ?? [];
  // A document field needs the case's files to pick from; they are read when a form first needs them.
  const wantsDocs = form?.mode === 'resolve' && fields.some((f) => f.type === 'document');
  useEffect(() => {
    if (!wantsDocs || docs) return;
    api<{ documents: CaseDocument[] }>(`/matters/${state.matterId}/engine/documents`).then((r) => setDocs(r.documents)).catch(() => setDocs([]));
  }, [wantsDocs, docs, api, state.matterId]);

  // On the Tasks list the issue opens on its resolve form: the row's button already said Resolve.
  const opened = useRef(false);
  useEffect(() => {
    if (!only || opened.current || !cat) return;
    const i = (Object.values(state.issues ?? {}) as IssueRow[]).find((x) => x.id === only);
    if (!i || cat.formless?.includes(i.kind)) return;
    opened.current = true;
    setResolution(byKind[i.kind]?.resolutions[0] ?? 'other'); setVals({}); setNote('');
    setForm({ id: i.id, mode: 'resolve' });
  }, [only, cat, byKind, state.issues]);
  const isContext = (i: IssueRow) => !!byKind[i.kind]?.context || ['seller_delay', 'buyer_delay'].includes(i.kind);
  const all = Object.values(state.issues ?? {}) as IssueRow[];
  // Soonest due first; then newest.
  const live = all.filter((i) => i.status === 'open' || i.status === 'negotiating').sort((a, b) => SEV_RANK[b.severity ?? 'warning'] - SEV_RANK[a.severity ?? 'warning'] || (a.resolveBy ?? '9').localeCompare(b.resolveBy ?? '9') || b.raisedAt.localeCompare(a.raisedAt));
  const open = live.filter((i) => !isContext(i));
  const context = live.filter(isContext);
  const closed = all.filter((i) => i.status === 'resolved' || i.status === 'fatal').sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));
  const exchanged = !!state.exchange.exchangedAt;
  const done = !!state.completion.confirmedAt || !!state.abandoned;
  const lockedDoc = (i: IssueRow): string | null => (i.kind === 'file_locked' && i.status === 'open' ? /\[doc:([0-9a-f-]{36})\]/.exec(i.detail ?? '')?.[1] ?? null : null);
  const retryable = (i: IssueRow) => i.kind === 'send_failed' && /\[(proposal|retry):/.test(i.detail ?? '');
  const resTitle = (r: string) => resById[r]?.title ?? tc(resById[r]?.label ?? pretty(r));
  const chip = (i: IssueRow) => cat?.chips?.[i.kind] ?? tc(byKind[i.kind]?.label ?? pretty(i.kind));

  /** Run a command: false (or a throw) when it was refused, with the reason on the form. */
  const run = async (body: Record<string, unknown>): Promise<boolean> => {
    setFormErr(null);
    try {
      const r = await cmd(body);
      if (r === false) { setFormErr('It did not save.'); return false; }
      return true;
    } catch (e: unknown) { setFormErr(e instanceof Error ? e.message : 'It did not save.'); return false; }
  };
  const openForm = (i: IssueRow, mode: FormMode) => {
    setMenu(null); setFormErr(null); setText(''); setConfirmFatal(false); setPw('');
    if (mode === 'date') setText(i.resolveBy ?? '');
    if (mode === 'severity') setSev(i.severity === 'critical' ? 'warning' : 'critical');
    if (mode === 'resolve') { setResolution(byKind[i.kind]?.resolutions[0] ?? 'other'); setVals({}); setNote(''); }
    setForm({ id: i.id, mode });
  };
  // On the Tasks list a side form (a note, a date) goes back to the resolve form; closing that closes the task.
  const closeForm = () => {
    setFormErr(null);
    if (only && form && form.mode !== 'resolve' && !formless.has((state.issues as Record<string, IssueRow>)[form.id]?.kind ?? '')) { setForm({ id: form.id, mode: 'resolve' }); return; }
    setForm(null);
    if (only && onCancel) onCancel();
  };
  // Done: say so. On the Tasks list a resolved issue stays on its confirmation until the list takes it away.
  const finished = (text: string, resolved = false) => { setOutcome({ ok: true, text }); if (!(only && resolved)) setTimeout(closeForm, 1200); onChanged?.(); };

  const submitSmall = async (i: IssueRow, mode: SmallMode): Promise<boolean> => {
    const t = text.trim();
    const body: Record<string, unknown> =
      mode === 'note' ? { type: 'update_issue', issueId: i.id, status: i.status, note: t }
      : mode === 'negotiating' ? { type: 'update_issue', issueId: i.id, status: 'negotiating', note: t }
      : mode === 'date' ? { type: 'update_issue', issueId: i.id, status: i.status, resolveBy: t }
      : mode === 'ask' ? { type: 'raise_enquiry', subject: t, origin: { issueId: i.id } }
      : mode === 'release' ? { type: 'update_issue', issueId: i.id, status: i.status, gate: 'none', note: t }
      : mode === 'hold' ? { type: 'update_issue', issueId: i.id, status: i.status, gate: 'exchange', note: t }
      : mode === 'severity' ? { type: 'set_issue_severity', issueId: i.id, severity: sev, reason: t }
      : mode === 'delete' ? { type: 'withdraw_issue', issueId: i.id, reason: t || 'Deleted: not an issue.' }
      : { type: 'mark_issue_fatal', issueId: i.id, reason: t };
    const ok = await run(body);
    if (ok) finished(`${FORM[mode].done}: ${clean(i.title)}`, mode === 'delete' || mode === 'fatal');
    return ok;
  };

  const resolveReady = () => {
    const res = resById[resolution];
    if (!res) return false;
    if (res.noteRequired && !note.trim()) return false;
    for (const f of res.fields ?? []) if (f.required && !(vals[f.key] ?? '').trim()) return false;
    if (resolution === 'dates_replanned' && !vals.targetExchangeDate && !vals.targetCompletionDate) return false;
    // A cost someone paid needs who paid it.
    if (vals.cost && pennies(vals.cost) > 0 && (res.fields ?? []).some((f) => f.key === 'paidBy') && !vals.paidBy) return false;
    return true;
  };
  const submitResolve = async (i: IssueRow): Promise<boolean> => {
    const res = resById[resolution];
    const body: Record<string, unknown> = { type: 'resolve_issue', issueId: i.id, resolution, note: note.trim() || null };
    const details: Record<string, string | number | boolean> = {};
    for (const f of res?.fields ?? []) {
      const v = (vals[f.key] ?? '').trim();
      if (!v) continue;
      if (f.key === 'newPrice') body.newPricePennies = pennies(v);
      else if (f.key === 'cost') body.costPennies = pennies(v);
      else if (f.key === 'paidBy') body.paidBy = v;
      else if (f.key === 'documentId') body.documentId = v;
      else if (f.type === 'money') details[f.key] = pennies(v);
      else if (f.type === 'confirm') details[f.key] = v === 'yes';
      else details[f.key] = v;
    }
    if (Object.keys(details).length) body.details = details;
    const ok = await run(body);
    if (ok) finished(`Resolved (${resTitle(resolution)}): ${clean(i.title)}`, true);
    return ok;
  };
  const unlock = async (docId: string): Promise<boolean> => {
    setFormErr(null);
    try {
      const r = await api<{ note: string | null; warning: string | null }>(`/documents/${docId}/unlock`, { method: 'POST', body: JSON.stringify({ password: pw, from: 'task' }) });
      setOutcome({ ok: !r.warning, text: r.warning ?? r.note ?? 'Unlocked.' });
      setTimeout(closeForm, 1200);
      onChanged?.();
      return true;
    } catch (e: unknown) { setFormErr(e instanceof Error ? e.message : 'That password does not open the file.'); return false; }
  };

  /** The line under the title: its kind, what it stops, where it stands, and when it is due. */
  const statusLine = (i: IssueRow, ctx: boolean) => {
    const parts: Array<{ text: string; cls?: string }> = [{ text: chip(i) }];
    if (!ctx && i.gate !== 'none') parts.push({ text: `Stops ${i.gate}`, cls: 'stops' });
    if (i.status === 'negotiating') parts.push({ text: 'In negotiation' });
    if (i.party) parts.push({ text: `Re ${i.party}` });
    if (!ctx && i.resolveBy) {
      const d = daysBetween(todayIso(), i.resolveBy);
      parts.push(d < 0 ? { text: `${-d} day${d === -1 ? '' : 's'} overdue`, cls: 'late' } : d === 0 ? { text: 'Due today', cls: 'soon' } : { text: `Resolve by ${fmtDay(i.resolveBy)}`, cls: d <= 2 ? 'soon' : undefined });
    }
    if (i.enquiryIds?.length) parts.push({ text: `Enquiry ${i.enquiryIds.join(', ')}` });
    return <div className="is-s">{!ctx && i.severity && <i className={`sev ${i.severity}`} title="Severity">{SEVERITY_LABEL[i.severity]}</i>}{parts.map((p, n) => <span key={n} className={p.cls}>{p.text}</span>)}</div>;
  };

  const fieldInput = (f: ResolutionField) => {
    const v = vals[f.key] ?? '';
    const set = (x: string) => setVals((cur) => ({ ...cur, [f.key]: x }));
    const label = `${f.label}${f.required ? '' : ' (Optional)'}`;
    switch (f.type) {
      case 'money': return <label key={f.key}>{label}<input className="ep-input" inputMode="decimal" placeholder="£" value={v} onChange={(e) => set(e.target.value)} /></label>;
      case 'date': return <label key={f.key}>{label}<input className="ep-input" type="date" value={v} onChange={(e) => set(e.target.value)} /></label>;
      case 'lender': return <label key={f.key}>{label}<LenderPicker api={api} value={v} onChange={set} className="ep-input" /></label>;
      case 'channel': return <label key={f.key}>{label}<select className="ep-input" value={v} onChange={(e) => set(e.target.value)}><option value="">Choose…</option>{[['post', 'By Post'], ['by_hand', 'By Hand'], ['own_email', 'From My Own Email'], ['other', 'Another Way']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>;
      case 'payer': return <label key={f.key}>{label}<select className="ep-input" value={v} onChange={(e) => set(e.target.value)}><option value="">Choose…</option>{PAYERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>;
      case 'confirm': return <label key={f.key} className="chk" style={{ gridColumn: '1 / -1' }}><input type="checkbox" checked={v === 'yes'} onChange={(e) => set(e.target.checked ? 'yes' : '')} />{f.label}</label>;
      case 'document': return (
        // A div, not a label: a label would pass the drop zone's click on to its own controls (or swallow the file input's).
        <div key={f.key} className="is-field" style={{ gridColumn: '1 / -1' }}>{label}
          <FilePick docs={docs} value={v} onChange={set} since={form ? (state.issues as Record<string, IssueRow>)[form.id]?.raisedAt ?? null : null} upload={async (file) => {
            const r = await uploadCaseFile<{ documentId: string }>(api, state.matterId, file, { role: 'evidence' });
            return { id: r.documentId, fileName: file.name, docType: null, webUrl: null, createdAt: new Date().toISOString() };
          }} />
        </div>
      );
      default: return <label key={f.key}>{label}<input className="ep-input" value={v} onChange={(e) => set(e.target.value)} /></label>;
    }
  };

  const TO_LABEL: Record<string, string> = { client: 'The Client', seller_solicitor: "The Other Side's Solicitor", estate_agent: 'The Estate Agent', lender: 'The Lender Or Broker' };
  const openStep = async (i: IssueRow, x: IssueStepView) => {
    setFormErr(null);
    if (step?.id === x.id) { setStep(null); return; }
    // Recording what settles it: the outcome below, with what it asks for (the grant, the consent).
    if (x.kind === 'outcome') { setStep(null); if (form?.mode !== 'resolve' || form.id !== i.id) openForm(i, 'resolve'); setResolution(x.resolution); setVals({}); setPickedOutcome(`${i.id}:${x.id}`); return; }
    if (x.kind === 'action') {
      const init: Record<string, string> = {};
      for (const f of x.fields ?? []) init[`act:${f.key}`] = f.type === 'date' && f.inWorkingDays ? inWorkingDays(f.inWorkingDays) : '';
      setVals((v) => ({ ...v, ...init }));
      setStep({ id: x.id, kind: 'action', subject: '', body: '', loading: false });
      return;
    }
    if (x.kind === 'negotiating') { setStep(null); openForm(i, 'negotiating'); return; }
    if (x.kind === 'fatal') { setStep(null); openForm(i, 'fatal'); return; }
    if (x.kind === 'dates') { setVals((v) => ({ ...v, stepExchange: state.targetExchangeDate?.slice(0, 10) ?? '', stepCompletion: state.targetCompletionDate?.slice(0, 10) ?? '' })); setStep({ id: x.id, kind: 'dates', subject: '', body: '', loading: false }); return; }
    if (x.kind !== 'message') return;
    setStep({ id: x.id, kind: 'message', to: x.to, subject: '', body: '', loading: true });
    try {
      const d = await api<{ to: string; subject: string; body: string }>(`/matters/${state.matterId}/issues/${encodeURIComponent(i.id)}/message?step=${encodeURIComponent(x.id)}`);
      setStep((cur) => (cur?.id === x.id ? { ...cur, to: d.to, subject: d.subject, body: d.body, loading: false } : cur));
    } catch (e: unknown) {
      setStep((cur) => (cur?.id === x.id ? { ...cur, loading: false } : cur));
      setFormErr(e instanceof Error ? e.message : 'The draft could not be written; write it yourself.');
    }
  };
  const sendStep = async (i: IssueRow): Promise<boolean> => {
    if (!step || step.kind !== 'message') return false;
    setFormErr(null);
    try {
      await api(`/matters/${state.matterId}/issues/${encodeURIComponent(i.id)}/message`, { method: 'POST', body: JSON.stringify({ to: step.to, subject: step.subject, body: step.body }) });
      const id = step.id;
      setSentSteps((cur) => new Set(cur).add(`${i.id}:${id}`));
      setTimeout(() => setStep((cur) => (cur?.id === id ? null : cur)), 900);
      onChanged?.();
      return true;
    } catch (e: unknown) { setFormErr(e instanceof Error ? e.message : 'It did not send.'); return false; }
  };
  const saveDates = async (i: IssueRow): Promise<boolean> => {
    const ex = vals.stepExchange || null, co = vals.stepCompletion || null;
    const ok = await run({ type: 'set_target_dates', targetExchangeDate: ex, targetCompletionDate: co, reason: clean(i.title).slice(0, 400) });
    if (!ok) return false;
    await run({ type: 'update_issue', issueId: i.id, status: i.status, note: `New dates agreed${ex ? `: exchange ${fmtDay(ex)}` : ''}${co ? `${ex ? ',' : ':'} completion ${fmtDay(co)}` : ''}` });
    setSentSteps((cur) => new Set(cur).add(`${i.id}:dates`));
    setTimeout(() => setStep(null), 900);
    onChanged?.();
    return true;
  };
  /** An action step: its command, with the issue's id and party and what the form asked for. */
  const runAction = async (i: IssueRow, x: Extract<IssueStepView, { kind: 'action' }>): Promise<boolean> => {
    const fill = (v: unknown): unknown => (v === '$issue' ? i.id : v === '$party' ? (i.party ?? null) : v === '$partyCheck' ? (i.party && state.partyChecks?.[i.party] ? i.party : null) : v === '$status' ? (i.status === 'negotiating' ? 'negotiating' : 'open') : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, w]) => [k, fill(w)])) : v);
    const body: Record<string, unknown> = { type: x.command, ...(fill(x.args ?? {}) as Record<string, unknown>) };
    for (const f of x.fields ?? []) {
      const v = (vals[`act:${f.key}`] ?? '').trim();
      if (!v) continue;
      body[f.key] = f.type === 'money' ? pennies(v) : f.type === 'names' ? v.split(',').map((n) => n.trim()).filter(Boolean) : v;
    }
    const ok = await run(body);
    if (!ok) return false;
    const still = x.command !== 'abandon_matter';
    if (still && x.log) await run({ type: 'update_issue', issueId: i.id, status: i.status === 'negotiating' ? 'negotiating' : 'open', note: x.log });
    if (still && x.resolves) await run({ type: 'resolve_issue', issueId: i.id, resolution: x.resolves, note: x.log ?? x.label });
    setSentSteps((cur) => new Set(cur).add(`${i.id}:${x.id}`));
    setTimeout(() => setStep((cur) => (cur?.id === x.id ? null : cur)), 900);
    onChanged?.();
    return true;
  };
  const actionReady = (x: Extract<IssueStepView, { kind: 'action' }>) => (x.fields ?? []).every((f) => !f.required || !!(vals[`act:${f.key}`] ?? '').trim());
  /** What to do about it: write to someone (drafted from the case), agree new dates, mark it negotiating, or say it has fallen through. */
  const nextSteps = (i: IssueRow) => {
    const all = ((/_sale$/.test(state.transactionType ?? '') ? cat?.sellerSteps : cat?.steps)?.[i.kind] ?? []).filter((x) => !(x.kind === 'negotiating' && i.status === 'negotiating'));
    if (!all.length) return null;
    const log = (i.history ?? []).slice(1).slice(-4);
    return (
      <>
        <div className="is-sec">Next Steps</div>
        <div className="is-steps">
          {all.map((x) => {
            const sent = sentSteps.has(`${i.id}:${x.id}`);
            const Icon = sent ? Check : x.kind === 'message' ? Mail : x.kind === 'dates' ? Calendar : x.kind === 'outcome' || x.kind === 'action' ? STEP_ICON[x.icon] ?? null : null;
            const on = step?.id === x.id || (x.kind === 'outcome' && pickedOutcome === `${i.id}:${x.id}` && resolution === x.resolution);
            return <button key={x.id} type="button" className={`ep-btn${x.kind === 'fatal' || (x.kind === 'action' && x.danger) ? ' bad' : ''}${on ? ' on' : ''}${sent ? ' sent' : ''}`} disabled={busy} onClick={() => void openStep(i, x)}>{Icon && <Icon size={16} />}{x.label}</button>;
          })}
        </div>
        {step?.kind === 'action' && (() => {
          const x = all.find((y) => y.id === step.id);
          if (!x || x.kind !== 'action') return null;
          return (
            <div className="is-comp">
              {(x.fields ?? []).map((f) => {
                const k = `act:${f.key}`;
                const set = (v: string) => setVals((cur) => ({ ...cur, [k]: v }));
                const label = `${f.label}${f.required ? '' : ' (Optional)'}`;
                return f.type === 'note'
                  ? <label key={f.key}>{label}<textarea className="ep-input short" rows={2} value={vals[k] ?? ''} onChange={(e) => set(e.target.value)} /></label>
                  : <label key={f.key}>{label}<input className="ep-input" type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'money' ? 'decimal' : undefined} value={vals[k] ?? ''} onChange={(e) => set(e.target.value)} /></label>;
              })}
              {x.confirm && <div className="warn">{x.confirm}</div>}
              <div className="f">
                <button type="button" className="ep-btn" style={{ margin: 0 }} onClick={() => setStep(null)}>Cancel</button>
                <BusyButton className={x.danger ? 'ep-btn primary is-red' : undefined} disabled={busy || !actionReady(x)} busyLabel="Working…" doneLabel="Done" onClick={() => runAction(i, x)}>{x.label}</BusyButton>
              </div>
            </div>
          );
        })()}
        {step?.kind === 'message' && (
          <div className="is-comp">
            <div className="to">To {TO_LABEL[step.to ?? ''] ?? 'Them'}</div>
            {step.loading ? <div className="wait">Drafting from the case…</div> : (
              <>
                <input className="ep-input" value={step.subject} onChange={(e) => setStep({ ...step, subject: e.target.value })} aria-label="Subject" />
                <textarea className="ep-input" rows={8} value={step.body} onChange={(e) => setStep({ ...step, body: e.target.value })} aria-label="Message" />
                <div className="f">
                  <button type="button" className="ep-btn" style={{ margin: 0 }} onClick={() => setStep(null)}>Cancel</button>
                  <BusyButton disabled={busy || !step.subject.trim() || !step.body.trim()} busyLabel="Sending…" doneLabel="Sent" onClick={() => sendStep(i)}>Send</BusyButton>
                </div>
              </>
            )}
          </div>
        )}
        {step?.kind === 'dates' && (
          <div className="is-comp">
            <div className="g">
              {!exchanged && <label>Target Exchange<input className="ep-input" type="date" value={vals.stepExchange ?? ''} onChange={(e) => setVals((v) => ({ ...v, stepExchange: e.target.value }))} /></label>}
              <label>Target Completion<input className="ep-input" type="date" value={vals.stepCompletion ?? ''} onChange={(e) => setVals((v) => ({ ...v, stepCompletion: e.target.value }))} /></label>
            </div>
            <div className="f">
              <button type="button" className="ep-btn" style={{ margin: 0 }} onClick={() => setStep(null)}>Cancel</button>
              <BusyButton disabled={busy || (!vals.stepExchange && !vals.stepCompletion)} busyLabel="Saving…" doneLabel="Saved" onClick={() => saveDates(i)}>Save Dates</BusyButton>
            </div>
          </div>
        )}
        {log.length > 0 && <div className="is-log">{log.map((h, n) => <div key={n}><time>{fmtDay(h.at)}</time><span>{h.what.replace(/^(open|negotiating): /, '')}</span></div>)}</div>}
        <hr className="is-hr" />
      </>
    );
  };

  const resolveForm = (i: IssueRow, bare = false) => {
    const res = resById[resolution];
    const options = byKind[i.kind]?.resolutions ?? ['other'];
    return (
      <div className="is-form">
        {nextSteps(i)}
        <div className="g">
          <label>Outcome<select className="ep-input" value={resolution} onChange={(e) => { setResolution(e.target.value); setVals({}); setFormErr(null); }}>{options.map((r) => <option key={r} value={r}>{resTitle(r)}</option>)}</select></label>
          {fields.map(fieldInput)}
        </div>
        <label>{res?.noteRequired ? (resolution === 'accepted_as_is' ? 'The Advice Given' : 'How It Was Resolved') : 'Note (Optional)'}<textarea className="ep-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {formErr && <div className="bad">{formErr === 'It did not save.' && err ? err : formErr}</div>}
        <div className="f">
          {bare && <span ref={menu === i.id ? menuRef : undefined} style={{ display: 'inline-flex', marginRight: 'auto' }}>{moreButton(i, isContext(i))}</span>}
          {res?.effect && (state.hasLender || !/lender/i.test(res.effect)) && <span className="fx">{res.effect}</span>}
          <button type="button" className="ep-btn" style={{ margin: 0 }} onClick={closeForm}>Cancel</button>
          <BusyButton disabled={busy || !resolveReady()} busyLabel="Resolving…" doneLabel="Resolved" onClick={() => submitResolve(i)}>Resolve</BusyButton>
        </div>
      </div>
    );
  };

  const smallForm = (i: IssueRow, mode: SmallMode) => {
    const spec = FORM[mode];
    const ready = (!spec.required || !!text.trim()) && (mode !== 'fatal' || confirmFatal) && (mode !== 'date' || text !== (i.resolveBy ?? '')) && (mode !== 'severity' || sev !== i.severity);
    return (
      <div className="is-form">
        {mode === 'severity' && <label>Severity<select className="ep-input" value={sev} onChange={(e) => setSev(e.target.value as Severity)} style={{ maxWidth: 220 }}>{SEVERITIES.map((x) => <option key={x} value={x}>{SEVERITY_LABEL[x]}{x === i.severity ? ' (Now)' : ''}</option>)}</select></label>}
        <label>{spec.field}{mode === 'date'
          ? <input className="ep-input" type="date" value={text} onChange={(e) => setText(e.target.value)} style={{ maxWidth: 220 }} autoFocus />
          : <textarea className="ep-input" rows={2} value={text} onChange={(e) => setText(e.target.value)} autoFocus />}
        </label>
        {mode === 'fatal' && <label className="chk"><input type="checkbox" checked={confirmFatal} onChange={(e) => setConfirmFatal(e.target.checked)} />This ends the transaction and abandons the case</label>}
        {formErr && <div className="bad">{formErr === 'It did not save.' && err ? err : formErr}</div>}
        <div className="f">
          <button type="button" className="ep-btn" style={{ margin: 0 }} onClick={closeForm}>Cancel</button>
          <BusyButton className={`ep-btn${mode === 'fatal' || mode === 'delete' ? '' : ' primary'}`} style={mode === 'fatal' ? { color: '#b91c1c', borderColor: '#fecaca' } : undefined} disabled={busy || !ready} doneLabel={spec.done} onClick={() => submitSmall(i, mode)}>{spec.button}</BusyButton>
        </div>
      </div>
    );
  };

  /** `bare`: the Tasks list already shows the title, so the row opens straight onto its line and actions. */
  const moreButton = (i: IssueRow, ctx: boolean) => (
    <>
      <button type="button" className="ep-btn" style={{ margin: 0 }} disabled={busy} aria-haspopup="menu" aria-expanded={menu === i.id} onClick={(e) => openMenu(i.id, e.currentTarget)}>More</button>
      {menu === i.id && menuAt && createPortal(
        <div className="is-menu" role="menu" ref={popRef} style={{ position: 'fixed', zIndex: 1000, right: menuAt.right, ...(menuAt.top + 340 > window.innerHeight ? { bottom: menuAt.bottom, top: 'auto' } : { top: menuAt.top }) }}>
          <style>{CSS}</style>
          <button role="menuitem" onClick={() => openForm(i, 'note')}>Add Note</button>
          {!ctx && <button role="menuitem" onClick={() => openForm(i, 'date')}>Change Resolve-By Date</button>}
          {!ctx && i.status === 'open' && <button role="menuitem" onClick={() => openForm(i, 'negotiating')}>Mark Negotiating</button>}
          {!ctx && !exchanged && <button role="menuitem" onClick={() => openForm(i, 'ask')}>Ask The Other Side</button>}
          {!ctx && i.gate !== 'none' && <button role="menuitem" onClick={() => openForm(i, 'release')}>Release The Hold</button>}
          {!ctx && i.gate === 'none' && !exchanged && <button role="menuitem" onClick={() => openForm(i, 'hold')}>Hold Exchange</button>}
          {!ctx && <button role="menuitem" onClick={() => openForm(i, 'severity')}>Change Severity</button>}
          <hr />
          <button role="menuitem" onClick={() => openForm(i, 'delete')}>Delete</button>
          {!ctx && <button role="menuitem" className="bad" onClick={() => openForm(i, 'fatal')}>Abandon The Case</button>}
        </div>,
        document.body
      )}
    </>
  );
  const row = (i: IssueRow, ctx: boolean, bare = false) => {
    const detail = clean(i.detail);
    const folded = !unfold.has(i.id);
    const f = form?.id === i.id ? form.mode : null;
    const doc = lockedDoc(i);
    return (
      <div key={i.id} className={`is-row${ctx ? ' is-ctx' : ''}`}>
        <div style={{ minWidth: 0 }}>
          {!bare && <div className="is-t">{clean(i.title)}</div>}
          {!bare && statusLine(i, ctx)}
          {detail && <div className={`is-d${folded ? '' : ' open'}`}>{detail}</div>}
          {detail.length > 180 && <button type="button" className="is-more-d" onClick={() => setUnfold((cur) => { const n = new Set(cur); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); return n; })}>{folded ? 'Read More' : 'Show Less'}</button>}
        </div>
        {!done && !(bare && f) && (
          <div className="is-acts" ref={menu === i.id ? menuRef : undefined}>
            {!ctx && retryable(i) && /no email address/i.test(i.detail ?? '') && addressFor(i.title) && <AddressAndSend api={api} matterId={state.matterId} issueId={i.id} need={addressFor(i.title)!} onError={(t) => setOutcome({ ok: false, text: t })} onDone={() => { setOutcome({ ok: true, text: `Sent: ${clean(i.title)}` }); onChanged?.(); }} />}
            {!ctx && retryable(i) && !(/no email address/i.test(i.detail ?? '') && addressFor(i.title)) && <BusyButton disabled={busy} busyLabel="Sending…" doneLabel="Sent" onClick={async () => { const ok = await run({ type: 'retry_issue', issueId: i.id }); if (ok) onChanged?.(); return ok; }}>Try Again</BusyButton>}
            {!ctx && doc && <button type="button" className={`ep-btn${f === 'password' ? '' : ' primary'}`} style={{ margin: 0 }} disabled={busy} onClick={() => (f === 'password' ? closeForm() : openForm(i, 'password'))}>{f === 'password' ? 'Cancel' : 'Enter Password'}</button>}
            {!ctx && !bare && !formless.has(i.kind) && <button type="button" className={`ep-btn${f === 'resolve' ? '' : ' primary'}`} style={{ margin: 0 }} disabled={busy} onClick={() => (f === 'resolve' ? closeForm() : openForm(i, 'resolve'))}>{f === 'resolve' ? 'Cancel' : i.kind === 'send_failed' ? 'Sent Another Way' : 'Resolve'}</button>}
            {ctx && <BusyButton className="ep-btn" disabled={busy} doneLabel="Cleared" onClick={() => run({ type: 'resolve_issue', issueId: i.id, resolution: byKind[i.kind]?.resolutions[0] ?? 'other', note: 'No longer the case.' })}>Clear</BusyButton>}
            {!(bare && f) && moreButton(i, ctx)}
          </div>
        )}
        {f === 'resolve' && resolveForm(i, bare)}
        {f === 'password' && doc && (
          <div className="is-form">
            <label>Password<PasswordInput className="ep-input" autoFocus value={pw} onChange={setPw} onEnter={() => void unlock(doc)} onEscape={closeForm} /></label>
            {formErr && <div className="bad">{formErr === 'It did not save.' && err ? err : formErr}</div>}
            <div className="f">
              <button type="button" className="ep-btn" style={{ margin: 0 }} onClick={closeForm}>Cancel</button>
              <BusyButton disabled={!pw} busyLabel="Unlocking…" doneLabel="Unlocked" onClick={() => unlock(doc)}>Unlock</BusyButton>
            </div>
          </div>
        )}
        {f && f !== 'resolve' && f !== 'password' && smallForm(i, f)}
      </div>
    );
  };

  const sel = byKind[draft.kind];
  // The lender withdrawing (or the offer lapsing) resets the mortgage: its own command, raised here like any other problem.
  const WITHDRAWN = '__offer_withdrawn';
  const offerOnFile = !!state.hasLender && !state.exchange?.exchangedAt && !['awaiting', 'not_required'].includes(state.mortgage?.status ?? 'awaiting');
  const withdrawing = draft.kind === WITHDRAWN;
  // A renegotiated price (before exchange) and a moved completion date (after) are their own commands too.
  const PRICE = '__price_changed', DATE = '__completion_date_changed';
  const purchase = /_purchase$/.test(state.transactionType ?? '');
  const canPrice = purchase && !state.exchange?.exchangedAt && !state.completion?.confirmedAt;
  const canDate = !!state.exchange?.exchangedAt && !state.completion?.confirmedAt;
  const special = withdrawing || draft.kind === PRICE || draft.kind === DATE;
  const specialReady = draft.kind === PRICE ? /\d/.test(newValue) : draft.kind === DATE ? /^\d{4}-\d{2}-\d{2}$/.test(newValue) : true;
  const pickKind = (kind: string) => { const k = byKind[kind]; setDraft((d) => ({ ...d, kind, gate: 'default', severity: 'default', resolveBy: k && !k.context ? inWorkingDays(k.escalateAfterWorkingDays ?? 10) : '' })); };
  const raise = async (): Promise<boolean> => {
    const why = [draft.title.trim(), draft.detail.trim()].filter(Boolean).join(': ');
    const body = draft.kind === PRICE ? { type: 'record_price_change', toPennies: pennies(newValue), reason: why }
      : draft.kind === DATE ? { type: 'change_completion_date', completionDate: newValue, reason: why }
      : withdrawing ? { type: 'mortgage_offer_withdrawn', reason: why }
      : { type: 'raise_issue', kind: draft.kind, title: draft.title.trim(), detail: draft.detail.trim() || null, severity: draft.severity === 'default' ? null : draft.severity, gate: sel?.context ? 'none' : draft.gate === 'default' ? null : draft.gate, resolveBy: sel?.context ? null : draft.resolveBy || null };
    const ok = await run(body);
    if (ok) {
      onChanged?.();
      setTimeout(() => { setRaising(false); setNewValue(''); setDraft((d) => ({ kind: special ? '' : d.kind, title: '', detail: '', gate: 'default', resolveBy: '', severity: 'default' })); }, 900);
    }
    return ok;
  };

  // Opened on its own (from a task's header): the kind's usual resolve-by, as the Raise Issue button sets it.
  const primed = useRef(false);
  useEffect(() => { if (raiseOnly && cat && !primed.current) { primed.current = true; pickKind(draft.kind); } }); // eslint-disable-line react-hooks/exhaustive-deps
  const raiseDialog = () => (
        <div className="is-veil" onMouseDown={(e) => { if (e.target === e.currentTarget) setRaising(false); }}>
          <div className="is-dlg" role="dialog" aria-label="Raise Issue">
            <h2>Raise Issue</h2>
            <label>Kind
              <select className="ep-input" value={draft.kind} onChange={(e) => pickKind(e.target.value)}>
                <option value="" disabled>Choose…</option>
                {offerOnFile && <optgroup label="Mortgage"><option value={WITHDRAWN}>Mortgage Offer Withdrawn Or Lapsed</option></optgroup>}
                {(canPrice || canDate) && <optgroup label="Contract">{canPrice && <option value={PRICE}>Price Changed</option>}{canDate && <option value={DATE}>Completion Date Moved</option>}</optgroup>}
                {(cat?.groups ?? []).map((g) => (
                  <optgroup key={g.id} label={tc(g.label)}>{kinds.filter((k) => k.group === g.id && k.kind !== 'lender_approval').map((k) => <option key={k.kind} value={k.kind}>{tc(k.label)}{k.context ? ' (Context)' : ''}</option>)}</optgroup>
                ))}
              </select>
            </label>
            {draft.kind === PRICE && <label>New Price<input className="ep-input" inputMode="decimal" placeholder={state.purchasePricePennies != null ? `Now ${gbp(state.purchasePricePennies)}` : '£'} value={newValue} onChange={(e) => setNewValue(e.target.value)} /></label>}
            {draft.kind === DATE && <label>New Completion Date<input className="ep-input" type="date" value={newValue} onChange={(e) => setNewValue(e.target.value)} /></label>}
            <label>{withdrawing ? 'Why The Offer Went' : draft.kind === PRICE ? 'Why The Price Changed' : draft.kind === DATE ? 'Why The Date Moved' : "What's Wrong"}<input className="ep-input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus /></label>
            <label>Detail (Optional)<textarea className="ep-input" rows={3} value={draft.detail} onChange={(e) => setDraft({ ...draft, detail: e.target.value })} /></label>
            {!sel?.context && !special && (
              <div className="two">
                <label>Stops
                  <select className="ep-input" value={draft.gate} onChange={(e) => setDraft({ ...draft, gate: e.target.value as typeof draft.gate })}>
                    <option value="default">{sel ? `${sel.gate === 'none' ? 'Nothing' : sel.gate === 'exchange' && !exchanged ? 'Exchange' : 'Completion'} (Usual)` : 'The Usual'}</option>
                    {!exchanged && <option value="exchange">Exchange</option>}
                    <option value="completion">Completion</option>
                    <option value="none">Nothing</option>
                  </select>
                </label>
                <label>Resolve By<input className="ep-input" type="date" min={todayIso()} value={draft.resolveBy} onChange={(e) => setDraft({ ...draft, resolveBy: e.target.value })} /></label>
                <label>Severity
                  <select className="ep-input" value={draft.severity} onChange={(e) => setDraft({ ...draft, severity: e.target.value as typeof draft.severity })}>
                    <option value="default">{sel?.severity ? `${SEVERITY_LABEL[sel.severity]} (Usual)` : 'The Usual'}</option>
                    {SEVERITIES.map((x) => <option key={x} value={x}>{SEVERITY_LABEL[x]}</option>)}
                  </select>
                </label>
              </div>
            )}
            {formErr && <div style={{ fontSize: 12.5, color: '#b91c1c', fontWeight: 600 }}>{formErr}</div>}
            <div className="f">
              <button className="ep-btn" style={{ margin: 0 }} onClick={() => setRaising(false)}>Cancel</button>
              <BusyButton disabled={busy || !draft.kind || !draft.title.trim() || !specialReady} busyLabel="Raising…" doneLabel="Raised" onClick={raise}>{special ? 'Record' : 'Raise Issue'}</BusyButton>
            </div>
          </div>
        </div>
  );
  if (raiseOnly) return <div className="is"><style>{CSS}</style>{raising && raiseDialog()}</div>;
  if (only) {
    const one = live.find((i) => i.id === only);
    return (
      <div className="is">
        <style>{CSS}</style>
        {outcome && <div className={`is-out${outcome.ok ? '' : ' warn'}`} role="status">{outcome.text}</div>}
        {one ? <div className="is-list">{row(one, isContext(one), true)}</div> : null}
      </div>
    );
  }
  const holding = open.filter((i) => i.gate !== 'none').length;
  const late = open.filter((i) => i.resolveBy && i.resolveBy < todayIso()).length;
  return (
    <div className="is">
      <style>{CSS}</style>
      <div className="is-h">
        <h3>Issues</h3>
        <span className="n">{open.length ? [`${open.length} open`, holding ? `${holding} stopping ${exchanged ? 'completion' : 'exchange'}` : '', late ? `${late} overdue` : ''].filter(Boolean).join(' · ') : 'None open'}</span>
        {!done && <button className="ep-btn sp" style={{ margin: '0 0 0 auto' }} disabled={busy} onClick={() => { setRaising(true); setFormErr(null); pickKind(draft.kind); }}>Raise Issue</button>}
      </div>
      {outcome && <div className={`is-out${outcome.ok ? '' : ' warn'}`} role="status">{outcome.text}</div>}
      <div className="is-list">{open.length ? open.map((i) => row(i, false)) : <div className="is-empty">Nothing is wrong on this case.</div>}</div>

      {context.length > 0 && (
        <>
          <div className="is-h"><h3>Context</h3></div>
          <div className="is-list">{context.map((i) => row(i, true))}</div>
        </>
      )}

      {closed.length > 0 && (
        <div className="is-closed">
          <button type="button" onClick={() => setShowClosed((x) => !x)}>{showClosed ? 'Hide' : 'Show'} {closed.length} Resolved</button>
          {showClosed && closed.map((i) => (
            <div key={i.id}><b>{clean(i.title)}</b>{i.resolution ? ` · ${resTitle(i.resolution)}` : ''}{i.resolvedAt ? ` · ${fmtDay(i.resolvedAt)}` : ''}{i.costPennies != null ? ` · ${gbp(i.costPennies)}${i.paidBy ? ` paid by ${i.paidBy}` : ''}` : ''}</div>
          ))}
        </div>
      )}

      {raising && raiseDialog()}
    </div>
  );
}
