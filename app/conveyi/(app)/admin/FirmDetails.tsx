'use client';
import { useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';

type Firm = { name: string; addressLine1: string | null; addressLine2: string | null; town: string | null; postcode: string | null; phone: string | null; sraNumber: string | null; website: string | null; logoUrl?: string | null; signatureNotice?: string | null };
const PROVIDERS: Array<[string, string]> = [['none', 'Wet ink only'], ['infotrack', 'InfoTrack'], ['intouch', 'InTouch'], ['leap', 'LEAP']];

/** The firm's details (where signed originals come back, what an email footer says) and how it signs deeds. */
export function FirmDetails({ canEdit }: { canEdit: boolean }) {
  const [f, setF] = useState<Firm | null>(null);
  const [provider, setProvider] = useState('none');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    api<{ firm: Firm; signing: { provider: string } }>('/admin/firm').then((r) => { setF(r.firm); setProvider(r.signing.provider); }).catch(() => setF(null));
  }, []);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 4000); return () => clearTimeout(t); }, [note]);
  if (!f) return null;
  const set = (k: keyof Firm) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ firm: Firm; signing: { provider: string } }>('/admin/firm', { method: 'PATCH', body: JSON.stringify({ ...f, signingProvider: provider }) });
      setF(r.firm); setProvider(r.signing.provider); setNote('Saved');
    } catch (e: unknown) { setNote(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  };
  const field = (label: string, k: keyof Firm, opts: { placeholder?: string; width?: number; inputMode?: 'tel' | 'numeric' | 'url' } = {}) => (
    <label className="fd-row"><span>{label}</span><input className="fd-in" value={f[k] ?? ''} onChange={set(k)} disabled={!canEdit} placeholder={opts.placeholder} inputMode={opts.inputMode} style={opts.width ? { maxWidth: opts.width } : undefined} /></label>
  );
  return (
    <div className="fd">
      <style>{CSS}</style>
      <div className="fd-h">Firm Details</div>
      <div className="fd-grid">
        {field('Firm name', 'name')}
        {field('Address', 'addressLine1', { placeholder: 'Street' })}
        {field('', 'addressLine2', { placeholder: 'Line 2' })}
        {field('Town', 'town', { width: 240 })}
        {field('Postcode', 'postcode', { width: 140 })}
        {field('Phone', 'phone', { width: 240, inputMode: 'tel' })}
        {field('SRA number', 'sraNumber', { width: 160, inputMode: 'numeric' })}
        {field('Website', 'website', { inputMode: 'url' })}
        {field('Logo', 'logoUrl', { placeholder: 'https:// link to the logo image', inputMode: 'url' })}
        <label className="fd-row"><span>Signature notice</span><textarea className="fd-in" rows={2} value={f.signatureNotice ?? ''} onChange={(e) => setF({ ...f, signatureNotice: e.target.value })} disabled={!canEdit} placeholder="We will never change our bank details by email. Call us before sending money." /></label>
        <label className="fd-row"><span>Electronic signing</span>
          <select className="fd-in" value={provider} onChange={(e) => setProvider(e.target.value)} disabled={!canEdit} style={{ maxWidth: 240 }}>
            {PROVIDERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      {canEdit && <div className="fd-a"><button className="fd-btn" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>{note && <span className="fd-note">{note}</span>}</div>}
    </div>
  );
}

type Person = { name: string | null; jobTitle: string | null; phone: string | null; email: string | null };

/** Your own lines in the email signature, and the signature as clients will see it. */
export function MySignature() {
  const [p, setP] = useState<Person | null>(null);
  const [html, setHtml] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const load = (r: { person: Person; preview: { html: string } }) => { setP(r.person); setHtml(r.preview.html); };
  useEffect(() => { api<{ person: Person; preview: { html: string } }>('/me/signature').then(load).catch(() => setP(null)); }, []);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 4000); return () => clearTimeout(t); }, [note]);
  if (!p) return null;
  const save = async () => {
    setBusy(true);
    try { load(await api('/me/signature', { method: 'PATCH', body: JSON.stringify({ jobTitle: p.jobTitle, phone: p.phone }) })); setNote('Saved'); }
    catch (e: unknown) { setNote(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="fd">
      <style>{CSS}</style>
      <div className="fd-h">My Signature</div>
      <div className="fd-grid">
        <label className="fd-row"><span>Name</span><input className="fd-in" value={p.name ?? ''} disabled /></label>
        <label className="fd-row"><span>Job title</span><input className="fd-in" value={p.jobTitle ?? ''} onChange={(e) => setP({ ...p, jobTitle: e.target.value })} placeholder="Conveyancer" style={{ maxWidth: 320 }} /></label>
        <label className="fd-row"><span>Direct line</span><input className="fd-in" value={p.phone ?? ''} onChange={(e) => setP({ ...p, phone: e.target.value })} inputMode="tel" style={{ maxWidth: 240 }} /></label>
      </div>
      <div className="fd-a"><button className="fd-btn" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>{note && <span className="fd-note">{note}</span>}</div>
      <div className="fd-prev" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

const CSS = `
.fd-prev{margin-top:14px;padding:4px 16px 16px;border:1px dashed #cbd5e1;border-radius:10px;background:#fafafa;overflow-x:auto}
.fd{border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin-bottom:14px;background:#fff}
.fd-h{font-weight:800;font-size:14px;color:#0f172a;margin-bottom:10px}
.fd-grid{display:grid;gap:6px}
.fd-row{display:grid;grid-template-columns:150px minmax(0,1fr);gap:10px;align-items:center;font-size:12.5px;color:#334155;font-weight:600}
.fd-in{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:6px 9px;font:inherit;font-weight:400;font-size:13px;background:#fff}
.fd-a{display:flex;gap:10px;align-items:center;margin-top:10px}
.fd-btn{background:#5A27E0;color:#fff;border:0;border-radius:8px;padding:7px 16px;font-weight:700;font-size:13px;cursor:pointer}
.fd-btn:disabled{opacity:.6}
.fd-note{font-size:12.5px;color:#166534}
@media (max-width:560px){.fd-row{grid-template-columns:1fr}}
`;
