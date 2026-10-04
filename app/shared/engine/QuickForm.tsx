'use client';
import { useState } from 'react';
import { BusyButton } from './BusyButton';

/** A few answers for one action, asked in place (never a browser prompt, never a typed code). */
export interface QuickField {
  key: string;
  label: string;
  kind?: 'text' | 'textarea' | 'select' | 'date' | 'money';
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  initial?: string;
  placeholder?: string;
}
export interface QuickFormSpec {
  title: string;
  fields: QuickField[];
  submitLabel: string;
  /** Values as typed; money as pennies, blanks as null. */
  run: (values: Record<string, string | number | null>) => Promise<unknown> | void;
  /** Something that cannot be undone (abandoning a case): the button is red. */
  danger?: boolean;
}

const CSS = `
.qf{background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:14px 16px;max-width:560px;width:100%;box-shadow:0 8px 24px rgba(15,23,42,.08)}
.qf-h{font-size:14px;font-weight:700;color:#0f172a;margin-bottom:10px}
.qf-row{display:grid;grid-template-columns:180px 1fr;gap:10px;align-items:center;margin:8px 0}
.qf-row label{font-size:12.5px;color:#475569}
.qf-row .ep-input{width:100%;margin:0}
.qf-acts{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
.qf .ep-btn.danger{background:#dc2626;color:#fff;border-color:#dc2626;margin:0}
.qf .ep-btn.danger:hover{background:#b91c1c}
`;

export function QuickForm({ spec, busy, onCancel }: { spec: QuickFormSpec; busy?: boolean; onCancel: () => void }) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(spec.fields.map((f) => [f.key, f.initial ?? (f.kind === 'select' && f.required ? f.options?.[0]?.value ?? '' : '')])));
  const missing = spec.fields.filter((f) => f.required && !(v[f.key] ?? '').trim());
  const submit = async () => {
    const out: Record<string, string | number | null> = {};
    for (const f of spec.fields) {
      const x = (v[f.key] ?? '').trim();
      out[f.key] = !x ? null : f.kind === 'money' ? Math.round(Number(x.replace(/[£,\s]/g, '')) * 100) : x;
    }
    await spec.run(out);
  };
  return (
    <div className="qf" role="dialog" aria-label={spec.title}>
      <style>{CSS}</style>
      <div className="qf-h">{spec.title}</div>
      {spec.fields.map((f) => (
        <div key={f.key} className="qf-row">
          <label htmlFor={`qf-${f.key}`}>{f.label}</label>
          {f.kind === 'select' ? (
            <select id={`qf-${f.key}`} className="ep-input" value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })}>
              {!f.required && <option value="">None</option>}
              {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : f.kind === 'textarea' ? (
            <textarea id={`qf-${f.key}`} className="ep-input" rows={3} value={v[f.key] ?? ''} placeholder={f.placeholder} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
          ) : (
            <input id={`qf-${f.key}`} className="ep-input" type={f.kind === 'date' ? 'date' : 'text'} inputMode={f.kind === 'money' ? 'decimal' : undefined} value={v[f.key] ?? ''} placeholder={f.kind === 'money' ? '£' : f.placeholder} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
          )}
        </div>
      ))}
      <div className="qf-acts">
        <button type="button" className="ep-btn" style={{ margin: 0 }} onClick={onCancel} disabled={busy}>Cancel</button>
        <BusyButton className={spec.danger ? 'ep-btn danger' : 'ep-btn primary'} busyLabel="Saving…" doneLabel="Done" disabled={busy || missing.length > 0} onClick={submit}>{spec.submitLabel}</BusyButton>
      </div>
    </div>
  );
}
