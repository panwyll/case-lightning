'use client';
import { BusyButton, Spin } from '@/app/shared/engine/BusyButton';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/app/shared/engine/api';

type Firm = { name: string; addressLine1: string | null; addressLine2: string | null; town: string | null; postcode: string | null; phone: string | null; sraNumber: string | null; website: string | null; logoUrl?: string | null; signatureNotice?: string | null };
const PROVIDERS: Array<[string, string]> = [['none', 'Wet Ink Only'], ['infotrack', 'InfoTrack'], ['intouch', 'InTouch'], ['leap', 'LEAP']];

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
      <div className="fd-h">Firm</div>
      <div className="fd-grid">
        {field('Firm Name', 'name')}
        {field('Address', 'addressLine1', { placeholder: 'Street' })}
        {field('', 'addressLine2', { placeholder: 'Line 2' })}
        {field('Town', 'town', { width: 240 })}
        {field('Postcode', 'postcode', { width: 140 })}
        {field('Phone', 'phone', { width: 240, inputMode: 'tel' })}
        {field('SRA Number', 'sraNumber', { width: 160, inputMode: 'numeric' })}
        {field('Website', 'website', { inputMode: 'url' })}
        {field('Logo', 'logoUrl', { placeholder: 'https:// link to the logo image', inputMode: 'url' })}
        <label className="fd-row"><span>Signature Notice</span><textarea className="fd-in" rows={2} value={f.signatureNotice ?? ''} onChange={(e) => setF({ ...f, signatureNotice: e.target.value })} disabled={!canEdit} placeholder="We will never change our bank details by email. Call us before sending money." /></label>
        <label className="fd-row"><span>Electronic Signing</span>
          <select className="fd-in" value={provider} onChange={(e) => setProvider(e.target.value)} disabled={!canEdit} style={{ maxWidth: 240 }}>
            {PROVIDERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      {canEdit && <div className="fd-a"><button className="fd-btn" disabled={busy} onClick={() => void save()}>{busy ? <Spin>Saving…</Spin> : 'Save'}</button>{note && <span className="fd-note">{note}</span>}</div>}
    </div>
  );
}

/** Your own signature: paste a rendered one (from Gmail, Outlook, a signature generator) or write it here; empty means the firm's standard. */
export function MySignature() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [sig, setSig] = useState<{ own: string | null; standard: string; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fill = (r: { own: string | null; standard: string; preview: string }) => { setSig(r); if (ref.current) ref.current.innerHTML = r.own ?? r.standard; };
  useEffect(() => { api<{ own: string | null; standard: string; preview: string }>('/me/signature').then(fill).catch(() => setSig(null)); }, []);
  useEffect(() => { if (sig && ref.current && !ref.current.innerHTML) ref.current.innerHTML = sig.own ?? sig.standard; }, [sig]);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 4000); return () => clearTimeout(t); }, [note]);
  const save = async (html: string | null) => {
    setBusy(true);
    try { fill(await api('/me/signature', { method: 'PATCH', body: JSON.stringify({ html }) })); setNote('Saved'); }
    catch (e: unknown) { setNote(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  };
  if (!sig) return null;
  return (
    <div className="fd">
      <style>{CSS}</style>
      <div className="fd-h">My Signature</div>
      <div ref={ref} className="fd-sig" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="My signature" />
      <div className="fd-a">
        <button className="fd-btn" disabled={busy} onClick={() => void save(ref.current?.innerHTML ?? null)}>{busy ? <Spin>Saving…</Spin> : 'Save'}</button>
        {sig.own && <button className="fd-btn2" disabled={busy} onClick={() => void save(null)}>Use The Firm&apos;s Standard</button>}
        {note && <span className="fd-note">{note}</span>}
      </div>
    </div>
  );
}

type Baseline = { weeksPurchase: number | null; weeksSale: number | null; casesPerConveyancer: number | null; hoursPerCase: number | null; recordedAt?: string; recordedBy?: string | null };
const BASELINE: Array<[keyof Baseline, string, string]> = [
  ['weeksPurchase', 'Weeks To Complete A Purchase', 'e.g. 16'],
  ['weeksSale', 'Weeks To Complete A Sale', 'e.g. 14'],
  ['casesPerConveyancer', 'Open Cases Per Conveyancer', 'e.g. 60'],
  ['hoursPerCase', 'Hours Per Case', 'e.g. 12'],
];

/** The firm's own figures from before CONVEYi: the "before" in any "faster than before" (docs/analytics.md). */
export function BaselineCard({ canEdit }: { canEdit: boolean }) {
  const [b, setB] = useState<Record<string, string> | null>(null);
  const [saved, setSaved] = useState<Baseline | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fill = (x: Baseline | null) => { setSaved(x); setB(Object.fromEntries(BASELINE.map(([k]) => [k, x?.[k] == null ? '' : String(x[k])]))); };
  useEffect(() => { api<{ baseline: Baseline | null }>('/admin/baseline').then((r) => fill(r.baseline)).catch(() => fill(null)); }, []);
  if (!b) return null;
  const save = async () => {
    setErr(null);
    const body = Object.fromEntries(BASELINE.map(([k]) => { const v = b[k].trim(); return [k, v === '' ? null : Number(v)]; }));
    if (Object.values(body).some((v) => v != null && (!Number.isFinite(v) || v <= 0))) { setErr('Figures must be positive numbers.'); return false; }
    try { fill((await api<{ baseline: Baseline }>('/admin/baseline', { method: 'PUT', body: JSON.stringify(body) })).baseline); return true; }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not save.'); return false; }
  };
  return (
    <div className="fd">
      <style>{CSS}</style>
      <div className="fd-h">Before CONVEYi</div>
      <div className="fd-grid">
        {BASELINE.map(([k, label, ph]) => (
          <label key={k} className="fd-row"><span>{label}</span><input className="fd-in" inputMode="decimal" value={b[k]} onChange={(e) => setB({ ...b, [k]: e.target.value })} disabled={!canEdit} placeholder={ph} style={{ maxWidth: 140 }} /></label>
        ))}
      </div>
      <div className="fd-a">
        {canEdit && <BusyButton className="fd-btn" busyLabel="Saving…" doneLabel="Saved" onClick={save}>Save</BusyButton>}
        {saved?.recordedAt && <span className="fd-meta">Recorded {new Date(saved.recordedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}{saved.recordedBy ? ` by ${saved.recordedBy}` : ''}</span>}
        {err && <span className="fd-note" style={{ color: '#b91c1c' }}>{err}</span>}
      </div>
    </div>
  );
}

const CSS = `
.fd-meta{font-size:12.5px;color:#94a3b8}
.fd-sig{min-height:120px;border:1px solid #cbd5e1;border-radius:8px;padding:10px 12px;background:#fff;overflow:auto;outline:none;font-family:Segoe UI,Arial,sans-serif;font-size:13px}
.fd-sig:focus{border-color:#5A27E0;box-shadow:0 0 0 3px rgba(90,39,224,.15)}
.fd-btn2{background:#fff;color:#334155;border:1px solid #cbd5e1;border-radius:8px;padding:7px 14px;font-weight:700;font-size:13px;cursor:pointer}
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

/** Where the firm's files are held, and moving them all into storage (from the database, and from OneDrive-only). */
export function StorageCard() {
  const [c, setC] = useState<{ inStorage: number; inDatabase: number; oneDriveOnly: number; configured: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { api<NonNullable<typeof c>>('/admin/storage/move').then(setC).catch(() => setC(null)); }, []);
  const move = async () => {
    setBusy(true); setNote(null);
    try {
      const r = await api<NonNullable<typeof c> & { moved: number; copied: number; failed: number }>('/admin/storage/move', { method: 'POST' });
      setC(r);
      setNote(`${r.moved + r.copied} moved${r.failed ? `; ${r.failed} could not be fetched from OneDrive` : ''}${r.inDatabase + r.oneDriveOnly - r.failed > 0 ? '. Run again for the rest.' : '.'}`);
    } catch (e: unknown) { setNote(e instanceof Error ? e.message : 'Could not move them.'); }
    finally { setBusy(false); }
  };
  if (!c) return null;
  const left = c.inDatabase + c.oneDriveOnly;
  return (
    <div className="fd">
      <div className="fd-h">Storage</div>
      <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.6 }}>
        {c.inStorage} in storage · {c.inDatabase} in the database · {c.oneDriveOnly} only in OneDrive
      </div>
      {left > 0 && c.configured && <div className="fd-a"><button className="fd-btn" disabled={busy} onClick={() => void move()}>{busy ? <Spin>Moving…</Spin> : 'Move To Storage'}</button>{note && <span className="fd-note">{note}</span>}</div>}
      {left === 0 && note && <div className="fd-a"><span className="fd-note">{note}</span></div>}
    </div>
  );
}

type Band = { upTo: number | null; fee: number };
type Extra = { id: string; label: string; fee: number; when: string; sides: string[] };
type Fees = { purchase: Band[]; sale: Band[]; remortgage: Band[]; transfer: Band[]; extras: Extra[] };
type Features = { mode: string; modes: Array<{ value: string; label: string }>; features: Array<{ key: string; label: string; on: boolean; byDefault: boolean; overridden: boolean }>; targets: { monthlyCompletions: number | null; perPerson: Record<string, number> }; fees: Fees; feeConditions: Array<{ value: string; label: string }>; commonExtras: Array<{ label: string; when: string; sides: string[] }>; reviewUrl: string | null; canEdit: boolean };
const SIDES: Array<[keyof Omit<Fees, 'extras'>, string]> = [['purchase', 'Purchase'], ['sale', 'Sale'], ['remortgage', 'Remortgage'], ['transfer', 'Transfer Of Equity']];
const FEE_CSS = `
.fe-row{display:grid;grid-template-columns:150px minmax(0,1fr);gap:10px;align-items:start;font-size:12.5px;color:#334155;font-weight:600;padding:5px 0}
.fe-bands{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center}
.fe-band{display:inline-flex;align-items:center;gap:4px;font-weight:400;color:#64748b}
.fe-n{width:92px;border:1px solid #cbd5e1;border-radius:7px;padding:5px 7px;font:inherit;font-size:13px;color:#0f172a;background:#fff}
.fe-n.sm{width:72px}
.fe-txt{border:1px solid #cbd5e1;border-radius:7px;padding:5px 7px;font:inherit;font-size:13px;min-width:0;width:100%}
.fe-del{background:none;border:0;color:#b91c1c;font:inherit;font-size:12px;font-weight:700;cursor:pointer;padding:2px 4px}
.fe-add{background:none;border:0;color:#5A27E0;font:inherit;font-size:12px;font-weight:700;cursor:pointer;padding:2px 4px}
.fe-x{display:grid;grid-template-columns:minmax(140px,1.4fr) 90px minmax(150px,1fr) minmax(130px,1fr) auto;gap:6px;align-items:center;padding:3px 0}
.fe-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.fe-chip{border:1px dashed #c4b5fd;background:#faf7ff;color:#5A27E0;border-radius:99px;padding:3px 10px;font:inherit;font-size:12px;font-weight:700;cursor:pointer}
@media (max-width:760px){.fe-x{grid-template-columns:1fr 90px}.fe-row{grid-template-columns:1fr}}
`;

/** The targets analytics measures against, and where happy clients are asked to leave a review. (How CONVEYi runs for the firm is set on the platform's Firms page.) */
export function FirmSetup() {
  const [f, setF] = useState<Features | null>(null);
  const [people, setPeople] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [per, setPer] = useState<Record<string, string>>({});
  const [review, setReview] = useState('');
  useEffect(() => {
    api<Features>('/admin/features').then((r) => { setF(r); setTarget(r.targets.monthlyCompletions?.toString() ?? ''); setPer(Object.fromEntries(Object.entries(r.targets.perPerson).map(([k, v]) => [k, String(v)]))); setReview(r.reviewUrl ?? ''); }).catch(() => setF(null));
    api<{ users: Array<{ id: string; email: string; display_name: string | null }> }>('/admin/users').then((r) => setPeople(r.users.map((u) => ({ id: u.id, name: u.display_name || u.email })))).catch(() => setPeople([]));
  }, []);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 4000); return () => clearTimeout(t); }, [note]);
  if (!f) return null;
  const patch = async (label: string, body: Record<string, unknown>) => {
    setBusy(label);
    try { setF(await api<Features>('/admin/features', { method: 'PATCH', body: JSON.stringify(body) })); setNote('Saved'); }
    catch (e: unknown) { setNote(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(null); }
  };
  const num = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.round(Number(v))));
  const saveTargets = () => patch('targets', { reviewUrl: review.trim() || null, targets: { monthlyCompletions: num(target), perPerson: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, num(v)]).filter(([, v]) => v !== null)) } });
  return (
    <div className="fd">
      <style>{CSS + '.fd-flag{display:flex;align-items:center;gap:10px;font-size:13px;padding:5px 0}.fd-flag b{font-weight:600;min-width:240px}.fd-dflt{font-size:11.5px;color:#94a3b8}.fd-on{border:1px solid #cbd5e1;border-radius:999px;padding:3px 12px;font-size:12px;font-weight:700;cursor:pointer;background:#fff;color:#64748b;min-width:56px}.fd-on.yes{background:#dcfce7;border-color:#86efac;color:#166534}.fd-on:disabled{opacity:.6;cursor:default}'}</style>
      <div className="fd-h">Targets And Reviews</div>
      <div className="fd-grid">
        <label className="fd-row"><span>Review Page</span><input className="fd-in" type="url" placeholder="https://" value={review} onChange={(e) => setReview(e.target.value)} disabled={!f.canEdit} /></label>
        <label className="fd-row"><span>Completions A Month</span><input className="fd-in" inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value.replace(/\D/g, ''))} disabled={!f.canEdit} style={{ maxWidth: 120 }} /></label>
        {people.map((p) => (
          <label key={p.id} className="fd-row"><span>{p.name}</span><input className="fd-in" inputMode="numeric" value={per[p.id] ?? ''} onChange={(e) => setPer({ ...per, [p.id]: e.target.value.replace(/\D/g, '') })} disabled={!f.canEdit} style={{ maxWidth: 120 }} /></label>
        ))}
      </div>
      {f.canEdit && <div className="fd-a"><button className="fd-btn" disabled={!!busy} onClick={() => void saveTargets()}>{busy === 'targets' ? <Spin>Saving…</Spin> : 'Save'}</button>{note && <span className="fd-note">{note}</span>}</div>}
    </div>
  );
}

/** What the firm charges: a legal fee per kind of case in price bands, and the add-ons (ID checks, leasehold, lender work…) that apply to a case by its facts. Feeds the fee figures in Analytics. */
export function FeesEditor() {
  const [f, setF] = useState<Features | null>(null);
  const [fees, setFees] = useState<Fees | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { api<Features>('/admin/features').then((r) => { setF(r); setFees(r.fees); }).catch(() => setF(null)); }, []);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 4000); return () => clearTimeout(t); }, [note]);
  if (!f || !fees) return null;
  const edit = !f.canEdit;
  const n = (v: string) => (v.trim() === '' ? null : Math.max(0, Number(v.replace(/[^\d.]/g, ''))));
  const setBand = (side: keyof Omit<Fees, 'extras'>, i: number, b: Partial<Band>) => setFees({ ...fees, [side]: fees[side].map((x, j) => (j === i ? { ...x, ...b } : x)) });
  const setExtra = (i: number, x: Partial<Extra>) => setFees({ ...fees, extras: fees.extras.map((e, j) => (j === i ? { ...e, ...x } : e)) });
  const addExtra = (x: { label: string; when: string; sides: string[] }) => setFees({ ...fees, extras: [...fees.extras, { id: `x${Date.now().toString(36)}`, fee: 0, ...x }] });
  const save = async () => {
    setBusy(true);
    try {
      const clean: Fees = { ...fees, extras: fees.extras.filter((e) => e.label.trim()) };
      for (const [k] of SIDES) clean[k] = fees[k].filter((b) => b.fee > 0);
      const r = await api<Features>('/admin/features', { method: 'PATCH', body: JSON.stringify({ fees: clean }) });
      setF(r); setFees(r.fees); setNote('Saved');
    } catch (e: unknown) { setNote(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  };
  const unused = f.commonExtras.filter((c) => !fees.extras.some((e) => e.when === c.when && e.label === c.label));
  return (
    <div className="fd">
      <style>{CSS + FEE_CSS}</style>
      <div className="fd-h">Fees <span className="fd-dflt" style={{ fontWeight: 600, marginLeft: 6, fontSize: 11.5, color: '#94a3b8' }}>Ex VAT</span></div>
      {SIDES.map(([side, label]) => {
        const bands = fees[side].length ? fees[side] : [{ upTo: null, fee: 0 }];
        return (
          <div key={side} className="fe-row">
            <span style={{ paddingTop: 6 }}>{label}</span>
            <div className="fe-bands">
              {bands.map((b, i) => (
                <span key={i} className="fe-band">
                  {bands.length > 1 && <>Up To £<input className="fe-n" inputMode="numeric" placeholder="Any Price" disabled={edit} value={b.upTo?.toLocaleString('en-GB') ?? ''} onChange={(e) => { if (!fees[side].length) setFees({ ...fees, [side]: [{ upTo: n(e.target.value), fee: 0 }] }); else setBand(side, i, { upTo: n(e.target.value) }); }} /></>}
                  £<input className="fe-n sm" inputMode="numeric" disabled={edit} value={b.fee ? b.fee.toLocaleString('en-GB') : ''} onChange={(e) => { if (!fees[side].length) setFees({ ...fees, [side]: [{ upTo: null, fee: n(e.target.value) ?? 0 }] }); else setBand(side, i, { fee: n(e.target.value) ?? 0 }); }} />
                  {f.canEdit && bands.length > 1 && <button className="fe-del" onClick={() => setFees({ ...fees, [side]: fees[side].filter((_, j) => j !== i) })}>Remove</button>}
                </span>
              ))}
              {f.canEdit && <button className="fe-add" onClick={() => setFees({ ...fees, [side]: [...(fees[side].length ? fees[side] : [{ upTo: null, fee: 0 }]), { upTo: null, fee: 0 }] })}>+ Price Band</button>}
            </div>
          </div>
        );
      })}
      <div className="fd-h" style={{ marginTop: 12 }}>Add-Ons</div>
      {fees.extras.map((x, i) => (
        <div key={x.id} className="fe-x">
          <input className="fe-txt" value={x.label} disabled={edit} onChange={(e) => setExtra(i, { label: e.target.value })} aria-label="Charge" />
          <span className="fe-band">£<input className="fe-n sm" inputMode="numeric" disabled={edit} value={x.fee ? x.fee.toLocaleString('en-GB') : ''} onChange={(e) => setExtra(i, { fee: n(e.target.value) ?? 0 })} aria-label="Fee" /></span>
          <select className="fd-in" value={x.when} disabled={edit} onChange={(e) => setExtra(i, { when: e.target.value })} aria-label="When">
            {f.feeConditions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <select className="fd-in" value={x.sides.length === 1 ? x.sides[0] : x.sides.length ? x.sides.join(',') : ''} disabled={edit} onChange={(e) => setExtra(i, { sides: e.target.value ? e.target.value.split(',') : [] })} aria-label="Cases">
            <option value="">All Cases</option>
            {x.sides.length > 1 && <option value={x.sides.join(',')}>{x.sides.map((s) => SIDES.find(([k]) => k === s)?.[1]).join(' And ')}</option>}
            {SIDES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {f.canEdit ? <button className="fe-del" onClick={() => setFees({ ...fees, extras: fees.extras.filter((_, j) => j !== i) })}>Remove</button> : <span />}
        </div>
      ))}
      {f.canEdit && (
        <div className="fe-chips">
          {unused.map((c) => <button key={c.label} className="fe-chip" onClick={() => addExtra(c)}>+ {c.label}</button>)}
          <button className="fe-chip" onClick={() => addExtra({ label: '', when: 'always', sides: [] })}>+ Other Charge</button>
        </div>
      )}
      {f.canEdit && <div className="fd-a"><button className="fd-btn" disabled={busy} onClick={() => void save()}>{busy ? <Spin>Saving…</Spin> : 'Save Fees'}</button>{note && <span className="fd-note">{note}</span>}</div>}
    </div>
  );
}
