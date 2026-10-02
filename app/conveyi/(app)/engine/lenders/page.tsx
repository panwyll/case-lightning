'use client';
import { BackLink } from '@/app/shared/BackLink';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { fmtWhen } from '@/app/shared/engine/types';
import { paths } from '@/lib/paths';

/**
 * The firm's lender directory: each lender's Part 2 answers that change a rule in the engine.
 * When a mortgage offer names a lender here, its requirements are recorded on the matter and
 * the rules read them: the lease review, the search-age check at exchange, the gift flag.
 */
interface Lender { id: string; lenderName: string; minUnexpiredYears: number | null; maxSearchAgeMonths: number | null; acceptsNonFamilyGift: boolean | null; requiresEws1: boolean | null; acceptsDigitalDeed?: boolean | null; acceptsLoanDeposit?: boolean | null; acceptsDonorAbroad?: boolean | null; note: string | null; updatedAt: string }
const blank = { lenderName: '', minUnexpiredYears: '', maxSearchAgeMonths: '', acceptsNonFamilyGift: '', requiresEws1: '', acceptsDigitalDeed: '', acceptsLoanDeposit: '', acceptsDonorAbroad: '', note: '' };

const CSS = `
.ld-list{background:#fff;border:1px solid #e6e8ee;border-radius:12px;overflow:hidden;margin-bottom:14px}
.ld-list table{width:100%;border-collapse:collapse;font-size:12.5px}
.ld-list th{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#94a3b8;text-align:left;padding:8px 12px;background:#fafafa}
.ld-list td{padding:8px 12px;border-top:1px solid #f1f5f9;vertical-align:top}
.ld-form{background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:14px 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px 14px}
.ld-form label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:700;color:#475569}
.ld-form input,.ld-form select,.ld-form textarea{font:inherit;font-size:13px;border:1px solid #e2e8f0;border-radius:8px;padding:7px 9px;background:#fff}
.ld-form .wide{grid-column:1 / -1}
`;
const yn = (v: boolean | null) => (v == null ? '—' : v ? 'Yes' : 'No');

export default function LendersPage() {
  const [lenders, setLenders] = useState<Lender[]>([]);
  const [form, setForm] = useState(blank);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ lenders: Lender[] }>('/engine/lenders').then((r) => setLenders(r.lenders)).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load.')), []);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api('/engine/lenders', { method: 'PUT', body: JSON.stringify({ lenderName: form.lenderName.trim(), minUnexpiredYears: form.minUnexpiredYears.trim() ? Number(form.minUnexpiredYears) : null, maxSearchAgeMonths: form.maxSearchAgeMonths.trim() ? Number(form.maxSearchAgeMonths) : null, acceptsNonFamilyGift: form.acceptsNonFamilyGift === '' ? null : form.acceptsNonFamilyGift === 'yes', requiresEws1: form.requiresEws1 === '' ? null : form.requiresEws1 === 'yes', acceptsLoanDeposit: form.acceptsLoanDeposit === '' ? null : form.acceptsLoanDeposit === 'yes', acceptsDonorAbroad: form.acceptsDonorAbroad === '' ? null : form.acceptsDonorAbroad === 'yes', acceptsDigitalDeed: form.acceptsDigitalDeed === '' ? null : form.acceptsDigitalDeed === 'yes', note: form.note.trim() || null }) });
      setForm(blank);
      await load();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not save.'); } finally { setBusy(false); }
  };
  const edit = (l: Lender) => setForm({ lenderName: l.lenderName, minUnexpiredYears: l.minUnexpiredYears?.toString() ?? '', maxSearchAgeMonths: l.maxSearchAgeMonths?.toString() ?? '', acceptsNonFamilyGift: l.acceptsNonFamilyGift == null ? '' : l.acceptsNonFamilyGift ? 'yes' : 'no', requiresEws1: l.requiresEws1 == null ? '' : l.requiresEws1 ? 'yes' : 'no', acceptsDigitalDeed: l.acceptsDigitalDeed == null ? '' : l.acceptsDigitalDeed ? 'yes' : 'no', acceptsLoanDeposit: l.acceptsLoanDeposit == null ? '' : l.acceptsLoanDeposit ? 'yes' : 'no', acceptsDonorAbroad: l.acceptsDonorAbroad == null ? '' : l.acceptsDonorAbroad ? 'yes' : 'no', note: l.note ?? '' });
  const remove = async (l: Lender) => {
    if (!window.confirm(`Remove ${l.lenderName} from the directory?`)) return;
    setBusy(true);
    try { await api('/engine/lenders', { method: 'DELETE', body: JSON.stringify({ id: l.id }) }); await load(); } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not remove.'); } finally { setBusy(false); }
  };
  return (
    <div className="eg" style={{ maxWidth: 1100 }}>
      <style>{ENGINE_CSS + CSS}</style>
      <div className="eg-top">
        <h1 className="eg-h1" style={{ display: 'flex', alignItems: 'center' }}><BackLink href="/conveyi/integrations" label="Back to Tools" />Lender Directory</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <a className="eg-btn" href={paths.machineMap}>Machine Map</a>
        </div>
      </div>
      {err && <div className="eg-err">{err}</div>}
      <div className="ld-list">
        <table>
          <thead><tr><th>Lender</th><th>Min unexpired lease (years)</th><th>Max search age (months)</th><th>Non-family gift</th><th>EWS1</th><th>E-signed deed</th><th>Note</th><th>Updated</th><th /></tr></thead>
          <tbody>
            {lenders.length === 0 && <tr><td colSpan={8} style={{ color: '#94a3b8' }}>No lenders yet.</td></tr>}
            {lenders.map((l) => (
              <tr key={l.id}>
                <td><b>{l.lenderName}</b></td><td>{l.minUnexpiredYears ?? '—'}</td><td>{l.maxSearchAgeMonths ?? '—'}</td><td>{yn(l.acceptsNonFamilyGift)}</td><td>{yn(l.requiresEws1)}</td><td>{yn(l.acceptsDigitalDeed ?? null)}</td><td>{l.note ?? ''}</td><td>{fmtWhen(l.updatedAt)}</td>
                <td style={{ whiteSpace: 'nowrap' }}><button className="eg-btn" disabled={busy} onClick={() => edit(l)}>Edit</button> <button className="eg-btn" disabled={busy} onClick={() => void remove(l)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ld-form">
        <label>Lender<input value={form.lenderName} onChange={(e) => setForm({ ...form, lenderName: e.target.value })} placeholder="As it appears on the offer" /></label>
        <label>Min unexpired lease term (years)<input type="number" min={0} value={form.minUnexpiredYears} onChange={(e) => setForm({ ...form, minUnexpiredYears: e.target.value })} /></label>
        <label>Max search age at exchange (months)<input type="number" min={1} max={24} value={form.maxSearchAgeMonths} onChange={(e) => setForm({ ...form, maxSearchAgeMonths: e.target.value })} /></label>
        <label>Accepts a non-family gift<select value={form.acceptsNonFamilyGift} onChange={(e) => setForm({ ...form, acceptsNonFamilyGift: e.target.value })}><option value="">Not stated</option><option value="yes">Yes</option><option value="no">No</option></select></label>
        <label>Accepts a borrowed deposit<select value={form.acceptsLoanDeposit} onChange={(e) => setForm({ ...form, acceptsLoanDeposit: e.target.value })}><option value="">Not stated</option><option value="yes">Yes</option><option value="no">No</option></select></label>
        <label>Accepts a gift from a donor abroad<select value={form.acceptsDonorAbroad} onChange={(e) => setForm({ ...form, acceptsDonorAbroad: e.target.value })}><option value="">Not stated</option><option value="yes">Yes</option><option value="no">No</option></select></label>
        <label>Requires an EWS1<select value={form.requiresEws1} onChange={(e) => setForm({ ...form, requiresEws1: e.target.value })}><option value="">Not stated</option><option value="yes">Yes</option><option value="no">No</option></select></label>
        <label>E-signed mortgage deed<select value={form.acceptsDigitalDeed} onChange={(e) => setForm({ ...form, acceptsDigitalDeed: e.target.value })}><option value="">Not stated (wet ink)</option><option value="yes">Accepted</option><option value="no">Wet ink only</option></select></label>
        <label className="wide">Note (anything else from its Part 2 the handler must know)<textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
        <div className="wide"><button className="eg-btn primary" disabled={busy || form.lenderName.trim().length < 2} onClick={() => void save()}>Save Lender</button></div>
      </div>
    </div>
  );
}
