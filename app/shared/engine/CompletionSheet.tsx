'use client';
import { useMemo, useState } from 'react';
import type { CaseDocument, CompletionContract } from './types';

/**
 * The completion sheet: gathers what a milestone's contract asks for — the document, the
 * figures and dates, the checklist, who confirmed — and hands one body back to record.
 * Field keys are the command's own fields; `completion` carries the rest.
 */
export function CompletionSheet({ contract, docs, busy, onSubmit, onCancel }: {
  contract: CompletionContract;
  docs: CaseDocument[] | null;
  busy: boolean;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [documentId, setDocumentId] = useState('');
  const [read, setRead] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [party, setParty] = useState({ who: '', channel: 'email', at: new Date().toISOString().slice(0, 10) });
  const [note, setNote] = useState('');

  const roles = (contract.documentRoles ?? []).map((r) => r.toLowerCase());
  const fits = (d: CaseDocument) => !roles.length || roles.includes((d.docType ?? '').toLowerCase());
  const sorted = useMemo(() => (docs ?? []).slice().sort((a, b) => Number(fits(b)) - Number(fits(a)) || b.createdAt.localeCompare(a.createdAt)), [docs]);
  const chosen = sorted.find((d) => d.id === documentId) ?? null;

  const missing: string[] = [];
  if (contract.documentRequired && !documentId) missing.push(contract.documentLabel ?? 'the document');
  if (documentId && !read) missing.push('open the document');
  for (const f of contract.fields ?? []) if (f.required && !(values[f.key] ?? '').trim()) missing.push(f.label.toLowerCase());
  for (const c of contract.checklist ?? []) if (!ticks[c.key]) missing.push(c.label.toLowerCase());
  if (contract.party && !party.who.trim()) missing.push('who confirmed');

  const submit = async () => {
    const body: Record<string, unknown> = {};
    for (const f of contract.fields ?? []) {
      const v = (values[f.key] ?? '').trim();
      if (!v) continue;
      if (f.kind === 'money') body[f.key] = Math.round(Number(v.replace(/[£,\s]/g, '')) * 100);
      else if (f.kind === 'names') body[f.key] = v.split(',').map((x) => x.trim()).filter(Boolean);
      else if (f.kind === 'datetime') body[f.key] = new Date(v).toISOString();
      else body[f.key] = v;
    }
    if (contract.party) body.note = [`${party.who} confirmed by ${party.channel} on ${party.at}`, note.trim()].filter(Boolean).join('. ');
    body.completion = {
      documentId: documentId || null,
      checklist: contract.checklist ? ticks : null,
      party: contract.party ? party : null,
      note: note.trim() || null,
      readDocument: documentId ? read : null,
    };
    if (documentId && contract.party) body.evidenceDocumentId = documentId;
    await onSubmit(body);
  };

  const row = (label: string, control: React.ReactNode) => (
    <div className="cs-row"><div className="cs-k">{label}</div><div className="cs-v">{control}</div></div>
  );

  return (
    <div className="cs" role="dialog" aria-label={contract.label}>
      <style>{CSS}</style>
      <div className="cs-h">{contract.label}</div>
      {(contract.documentRequired || contract.documentLabel) && row(contract.documentLabel ?? 'Document', (
        <div>
          <select className="ep-input" value={documentId} onChange={(e) => { setDocumentId(e.target.value); setRead(false); }} style={{ maxWidth: 420 }} title={roles.length ? `Filed as ${roles.join(', ')}` : 'Any document on the case'}>
            <option value="">{docs === null ? 'Loading…' : contract.documentRequired ? 'Choose…' : 'None'}</option>
            {sorted.map((d) => <option key={d.id} value={d.id} disabled={!fits(d)}>{d.fileName ?? d.id}{d.docType ? ` · ${d.docType}` : ''}{fits(d) ? '' : ' (wrong kind)'}</option>)}
          </select>
          {chosen && (
            <label className="cs-read">
              <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} />
              {chosen.webUrl ? <a href={chosen.webUrl} target="_blank" rel="noreferrer">Open</a> : <span>Open</span>} and read before recording
            </label>
          )}
        </div>
      ))}
      {(contract.fields ?? []).map((f) => row(f.label, (
        <input
          className="ep-input"
          type={f.kind === 'date' ? 'date' : f.kind === 'datetime' ? 'datetime-local' : 'text'}
          inputMode={f.kind === 'money' ? 'decimal' : undefined}
          placeholder={f.kind === 'money' ? '£' : f.hint ?? ''}
          value={values[f.key] ?? ''}
          onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
          title={f.hint}
          style={{ width: f.kind === 'names' ? 360 : 200, maxWidth: '100%' }}
        />
      )))}
      {contract.checklist?.map((c) => row('', (
        <label className="cs-tick"><input type="checkbox" checked={!!ticks[c.key]} onChange={(e) => setTicks({ ...ticks, [c.key]: e.target.checked })} />{c.label}</label>
      )))}
      {contract.party && row(contract.party.label, (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <input className="ep-input" placeholder="Who" value={party.who} onChange={(e) => setParty({ ...party, who: e.target.value })} style={{ width: 200 }} />
          <select className="ep-input" value={party.channel} onChange={(e) => setParty({ ...party, channel: e.target.value })}>
            {['email', 'phone', 'in person', 'letter', 'portal'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input className="ep-input" type="date" value={party.at} onChange={(e) => setParty({ ...party, at: e.target.value })} />
        </div>
      ))}
      {row('Note', <input className="ep-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" style={{ width: 420, maxWidth: '100%' }} />)}
      <div className="cs-a">
        <button className="ep-btn primary" disabled={busy || missing.length > 0} title={missing.length ? `Needs: ${missing.join(', ')}` : contract.effect} onClick={() => void submit()}>{busy ? 'Recording…' : `Record ${contract.label}`}</button>
        <button className="ep-btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

const CSS = `
.cs{margin-top:10px;border:1px solid #c4b5fd;background:#faf8ff;border-radius:10px;padding:12px 14px}
.cs-h{font-size:13px;font-weight:800;margin-bottom:8px}
.cs-row{display:grid;grid-template-columns:180px minmax(0,1fr);gap:8px 12px;align-items:center;padding:4px 0}
.cs-k{font-size:12.5px;color:#334155;font-weight:600}
.cs-v .ep-input{margin:0}
.cs-read{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;margin-top:6px;color:#334155}
.cs-read a{color:#5A27E0}
.cs-tick{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;color:#0f172a}
.cs-a{display:flex;gap:8px;margin-top:10px}
.cs-a .ep-btn{margin:0}
@media (max-width:700px){.cs-row{grid-template-columns:1fr}}
`;
