'use client';
/**
 * Manual handling: a person marks a step complete by hand. Where the step would have been read
 * from a document (the offer, the redemption statement, the register), the facts later rules run
 * on are asked for here; they can be skipped only with a reason, and the step still completes.
 */
import { Spin } from './BusyButton';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Paperclip, X } from '@/app/shared/icons';
import type { Api } from './types';
import { uploadCaseFile } from './uploadCaseFile';

type Kind = 'text' | 'money' | 'date' | 'years' | 'months' | 'yesno';
interface Field { key: string; label: string; kind: Kind; required?: boolean; without?: string; lender?: boolean }
interface Lender { lenderName: string; minUnexpiredYears: number | null; maxSearchAgeMonths: number | null; acceptsNonFamilyGift: boolean | null; requiresEws1: boolean | null }

/** Mirrors MANUAL_STEP_REQUIRED in lib/server/engine/types.ts (the machine enforces it). */
const FIELDS: Record<string, { details: Field[]; requirements?: Field[] }> = {
  mortgage: {
    details: [
      { key: 'lender', label: 'Lender', kind: 'text', required: true, lender: true, without: 'No lender for the certificate of title or the signing method' },
      { key: 'amountPennies', label: 'Advance', kind: 'money', required: true, without: 'No advance figure for the completion statement' },
      { key: 'expiryDate', label: 'Offer Expires', kind: 'date', required: true, without: 'No offer-expiry deadline is tracked' },
    ],
    requirements: [
      { key: 'minUnexpiredYears', label: 'Minimum Lease Term', kind: 'years' },
      { key: 'maxSearchAgeMonths', label: 'Maximum Search Age', kind: 'months' },
      { key: 'acceptsNonFamilyGift', label: 'Non-Family Gifts', kind: 'yesno' },
      { key: 'acceptsLoanDeposit', label: 'Borrowed Deposit', kind: 'yesno' },
      { key: 'acceptsDonorAbroad', label: 'Donor Abroad', kind: 'yesno' },
      { key: 'requiresEws1', label: 'EWS1 Required', kind: 'yesno' },
    ],
  },
  redemption: {
    details: [
      { key: 'lender', label: 'Lender', kind: 'text' },
      { key: 'amountPennies', label: 'Redemption Figure', kind: 'money', required: true, without: 'No redemption figure for the completion statement' },
      { key: 'validUntil', label: 'Figure Good To', kind: 'date', required: true, without: 'Nothing checks the figure is still good on completion' },
    ],
  },
  title: {
    details: [{ key: 'titleNumber', label: 'Title Number', kind: 'text', required: true, without: 'No title number for the report on title or registration' }],
  },
};

const CSS = `
.mc-veil{position:fixed;inset:0;background:rgba(15,23,42,.42);z-index:70;display:flex;align-items:flex-start;justify-content:center;padding:64px 16px 16px;overflow-y:auto}
.mc{background:#fff;border-radius:14px;width:100%;max-width:560px;box-shadow:0 24px 64px rgba(15,23,42,.26);display:grid}
.mc-h{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid #f1f5f9}
.mc-h h2{margin:0;font-size:16px;font-weight:800;color:#0f172a}
.mc-h .x{margin-left:auto;border:0;background:none;color:#64748b;cursor:pointer;padding:4px;border-radius:6px;display:flex}
.mc-h .x:hover{background:#f1f5f9}
.mc-b{padding:6px 20px 16px;display:grid;gap:4px}
.mc-sec{padding-top:12px}
.mc-sec h3{margin:0 0 8px;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#64748b;display:flex;align-items:center;gap:8px}
.mc-tag{font-size:10.5px;font-weight:700;letter-spacing:0;text-transform:none;color:#5A27E0;background:#f5f3ff;border-radius:99px;padding:1px 8px}
.mc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px}
.mc-f{display:grid;gap:4px;min-width:0}
.mc-f.wide{grid-column:1 / -1}
.mc-f>span{font-size:12px;font-weight:700;color:#334155}
.mc-f>span i{color:#b91c1c;font-style:normal;margin-left:2px}
.mc-in{border:1px solid #cbd5e1;border-radius:8px;padding:7px 9px;font:inherit;font-size:13px;color:#0f172a;background:#fff;width:100%;box-sizing:border-box}
.mc-in:focus{outline:2px solid #c4b5fd;border-color:#8b5cf6}
.mc-in.miss{border-color:#fbbf24;background:#fffbeb}
.mc-pre{position:relative}
.mc-pre>b{position:absolute;left:9px;top:50%;transform:translateY(-50%);font-size:13px;color:#64748b;font-weight:600}
.mc-pre>.mc-in{padding-left:22px}
.mc-suf{display:flex;align-items:center;gap:6px}
.mc-suf em{font-style:normal;font-size:12px;color:#64748b}
.mc-seg{display:inline-flex;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden}
.mc-seg button{border:0;background:#fff;padding:6px 12px;font:inherit;font-size:12.5px;color:#334155;cursor:pointer}
.mc-seg button+button{border-left:1px solid #e2e8f0}
.mc-seg button.on{background:#5A27E0;color:#fff}
.mc-drop{display:flex;align-items:center;gap:8px;border:1px dashed #cbd5e1;border-radius:8px;padding:9px 11px;font-size:12.5px;color:#475569;cursor:pointer}
.mc-drop:hover{border-color:#8b5cf6;background:#faf8ff}
.mc-files{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.mc-files span{display:inline-flex;align-items:center;gap:4px;background:#f1f5f9;border-radius:99px;padding:2px 4px 2px 10px;font-size:12px;color:#0f172a;max-width:100%}
.mc-files span button{border:0;background:none;cursor:pointer;color:#64748b;display:flex;padding:2px}
.mc-warn{margin-top:14px;border:1px solid #fcd34d;background:#fffbeb;border-radius:10px;padding:10px 12px;display:grid;gap:8px}
.mc-warn .t{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;font-weight:700;color:#78350f}
.mc-warn ul{margin:0;padding-left:26px;font-size:12.5px;color:#92400e;display:grid;gap:2px}
.mc-warn label{display:flex;gap:8px;align-items:center;font-size:12.5px;font-weight:600;color:#78350f;cursor:pointer}
.mc-err{font-size:12.5px;color:#b91c1c;margin-top:8px}
.mc-a{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid #f1f5f9;background:#fafafa;border-radius:0 0 14px 14px}
.mc-a .ep-btn{margin:0}
@media (max-width:560px){.mc-grid{grid-template-columns:1fr}}
`;

const toPennies = (v: string): number | null => { const n = Number(v.replace(/[£,\s]/g, '')); return v.trim() && Number.isFinite(n) ? Math.round(n * 100) : null; };

export function MarkComplete({ matterId, api, step, label, busy, cmd, lender: knownLender }: { matterId: string; api: Api; step: string; label: string; busy: boolean; cmd: (body: Record<string, unknown>) => Promise<unknown>; lender?: string | null }) {
  const spec = FIELDS[step];
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [skip, setSkip] = useState(false);
  const [skipReason, setSkipReason] = useState('');
  const [lenders, setLenders] = useState<Lender[]>([]);
  const [fromDirectory, setFromDirectory] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !spec?.details.some((f) => f.lender)) return;
    let live = true;
    api<{ lenders: Lender[] }>('/engine/lenders/names').then((r) => { if (live) setLenders(r.lenders); }).catch(() => {});
    return () => { live = false; };
  }, [open, spec, api]);
  useEffect(() => { if (open && knownLender && !values.lender) setValues((v) => ({ ...v, lender: knownLender })); }, [open, knownLender]); // eslint-disable-line react-hooks/exhaustive-deps

  // The lender's requirements fill in from the Lender Directory as soon as the name matches one.
  const setLender = (name: string) => {
    const next: Record<string, string> = { ...values, lender: name };
    const norm = (x: string) => x.toLowerCase().replace(/\b(plc|ltd|limited|bank|building society|bs|uk|the)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
    const hit = name.trim() ? lenders.find((l) => norm(l.lenderName) === norm(name)) : undefined;
    if (hit && spec?.requirements) {
      if (hit.minUnexpiredYears != null) next.minUnexpiredYears = String(hit.minUnexpiredYears);
      if (hit.maxSearchAgeMonths != null) next.maxSearchAgeMonths = String(hit.maxSearchAgeMonths);
      if (hit.acceptsNonFamilyGift != null) next.acceptsNonFamilyGift = hit.acceptsNonFamilyGift ? 'yes' : 'no';
      if (hit.requiresEws1 != null) next.requiresEws1 = hit.requiresEws1 ? 'yes' : 'no';
    }
    setFromDirectory(hit ? hit.lenderName : null);
    setValues(next);
  };

  const all = useMemo(() => [...(spec?.details ?? []), ...(spec?.requirements ?? [])], [spec]);
  const missing = (spec?.details ?? []).filter((f) => f.required && !(values[f.key] ?? '').trim());
  const canSave = !!note.trim() && (!missing.length || (skip && !!skipReason.trim()));

  const reset = () => { setOpen(false); setNote(''); setFiles([]); setValues({}); setSkip(false); setSkipReason(''); setErr(null); setFromDirectory(null); };
  const save = async () => {
    if (!canSave) return;
    setSaving(true); setErr(null);
    try {
      const facts: Record<string, unknown> = {};
      for (const f of all) {
        const v = (values[f.key] ?? '').trim();
        if (!v) continue;
        if (f.kind === 'money') { const p = toPennies(v); if (p == null) throw new Error(`${f.label} is not an amount.`); facts[f.key] = p; }
        else if (f.kind === 'years' || f.kind === 'months') { const n = Number(v); if (!Number.isInteger(n)) throw new Error(`${f.label} should be a whole number.`); facts[f.key] = n; }
        else if (f.kind === 'yesno') facts[f.key] = v === 'yes';
        else facts[f.key] = v;
      }
      const documentIds: string[] = [];
      for (const file of files) documentIds.push((await uploadCaseFile<{ documentId: string }>(api, matterId, file, { role: 'evidence' })).documentId);
      const ok = await cmd({ type: 'complete_step_manually', step, note: note.trim(), documentIds, ...(spec ? { facts } : {}), ...(missing.length ? { skipReason: skipReason.trim() } : {}) });
      if (ok !== false) reset();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not save it.');
    } finally {
      setSaving(false);
    }
  };

  const input = (f: Field) => {
    const v = values[f.key] ?? '';
    const set = (x: string) => setValues({ ...values, [f.key]: x });
    const miss = skip ? '' : f.required && !v.trim() ? ' miss' : '';
    if (f.kind === 'yesno') return (
      <div className="mc-seg" role="group" aria-label={f.label}>
        {(['yes', 'no', ''] as const).map((o) => <button key={o || 'unknown'} type="button" className={v === o ? 'on' : ''} onClick={() => set(o)}>{o === 'yes' ? 'Yes' : o === 'no' ? 'No' : 'Not Stated'}</button>)}
      </div>
    );
    if (f.kind === 'money') return <div className="mc-pre"><b>£</b><input className={`mc-in${miss}`} inputMode="decimal" value={v} onChange={(e) => set(e.target.value)} /></div>;
    if (f.kind === 'years' || f.kind === 'months') return <div className="mc-suf"><input className="mc-in" inputMode="numeric" value={v} onChange={(e) => set(e.target.value.replace(/[^\d]/g, ''))} style={{ width: 90 }} /><em>{f.kind}</em></div>;
    if (f.kind === 'date') return <input className={`mc-in${miss}`} type="date" value={v} onChange={(e) => set(e.target.value)} />;
    if (f.lender) return <><input className={`mc-in${miss}`} list={`mc-lenders-${step}`} value={v} onChange={(e) => setLender(e.target.value)} /><datalist id={`mc-lenders-${step}`}>{lenders.map((l) => <option key={l.lenderName} value={l.lenderName} />)}</datalist></>;
    return <input className={`mc-in${miss}`} value={v} onChange={(e) => set(e.target.value)} />;
  };
  const field = (f: Field, wide = false) => <label key={f.key} className={`mc-f${wide ? ' wide' : ''}`}><span>{f.label}{f.required && <i>*</i>}</span>{input(f)}</label>;

  const trigger = <button type="button" className="ep-btn" style={{ margin: 0, padding: '2px 9px', fontSize: 11.5 }} disabled={busy} onClick={() => setOpen(true)}>Mark Complete</button>;
  if (!open || typeof document === 'undefined') return trigger;
  return <>
    {trigger}
    {createPortal(
      <div className="mc-veil" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) reset(); }}>
        <style>{CSS}</style>
        <div className="mc" role="dialog" aria-label={`Mark Complete: ${label}`}>
          <div className="mc-h"><h2>Mark Complete · {label}</h2><button type="button" className="x" aria-label="Close" onClick={reset} disabled={saving}><X size={16} /></button></div>
          <div className="mc-b">
            {spec && (
              <div className="mc-sec">
                <h3>Details</h3>
                <div className="mc-grid">{spec.details.map((f) => field(f, spec.details.length === 1 || f.kind === 'text'))}</div>
              </div>
            )}
            {spec?.requirements && (
              <div className="mc-sec">
                <h3>Lender Requirements{fromDirectory && <span className="mc-tag">From Lender Directory · {fromDirectory}</span>}</h3>
                <div className="mc-grid">{spec.requirements.map((f) => field(f))}</div>
              </div>
            )}
            <div className="mc-sec">
              <h3>What Was Done</h3>
              <textarea className="mc-in" rows={3} autoFocus={!spec} value={note} onChange={(e) => setNote(e.target.value)} placeholder={`How ${label.toLowerCase()} was done or checked`} />
            </div>
            <div className="mc-sec">
              <h3>Supporting Documents</h3>
              <label className="mc-drop"><Paperclip size={16} />Add Files<input type="file" multiple hidden onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = ''; }} /></label>
              {files.length > 0 && <div className="mc-files">{files.map((f, i) => <span key={`${f.name}-${i}`}>{f.name}<button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><X size={16} /></button></span>)}</div>}
            </div>
            {missing.length > 0 && (
              <div className="mc-warn">
                <div className="t"><AlertTriangle size={16} />Missing {missing.map((m) => m.label).join(', ')}</div>
                <ul>{missing.map((m) => <li key={m.key}>{m.without}</li>)}</ul>
                <label><input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />Complete Without {missing.length === 1 ? 'It' : 'Them'}</label>
                {skip && <textarea className="mc-in" rows={2} value={skipReason} onChange={(e) => setSkipReason(e.target.value)} placeholder="Reason" autoFocus />}
              </div>
            )}
            {err && <div className="mc-err">{err}</div>}
          </div>
          <div className="mc-a">
            <button type="button" className="ep-btn" disabled={saving} onClick={reset}>Cancel</button>
            <button type="button" className="ep-btn primary" disabled={saving || busy || !canSave} onClick={() => void save()}>{saving ? <Spin>Saving…</Spin> : 'Mark Complete'}</button>
          </div>
        </div>
      </div>,
      document.body,
    )}
  </>;
}
