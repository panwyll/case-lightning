'use client';
import { Spin } from './BusyButton';
import { useCallback, useEffect, useState } from 'react';
import { X } from '@/app/shared/icons';
import type { Api } from './types';

/** Everyone on the case and how to reach them: name, email, role, mobile, WhatsApp opt-in. Every message the case sends goes to these addresses. */
interface Contact { id: string; email: string; name: string | null; role: string | null; phone: string | null; whatsappOptIn: boolean | null }
const ROLES: Array<[string, string]> = [['CLIENT', 'Client'], ['OTHER_SIDE', "Other side's solicitor"], ['AGENT', 'Estate agent'], ['LENDER', 'Lender'], ['FAMILY', 'Family'], ['OUR_FIRM', 'Our firm'], ['OTHER', 'Other'], ['UNKNOWN', 'Not sure']];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const CONTACTS_CSS = `
.cc{display:grid;gap:8px}
.cc-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px;align-items:start;padding:8px 0;border-top:1px solid #eef1f5}
.cc-row:first-of-type{border-top:0;padding-top:0}
.cc-row .n{font-size:13px;font-weight:600;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-row .e{font-size:12px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-row .r{font-size:11.5px;color:#5A27E0;font-weight:700}
.cc-x{width:24px;height:24px;border:0;background:#f1f5f9;border-radius:6px;cursor:pointer;color:#64748b;display:inline-flex;align-items:center;justify-content:center}
.cc-edit{grid-column:1 / -1;display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px}
.cc-edit input,.cc-edit select{width:100%;box-sizing:border-box;font-size:12.5px;padding:6px 8px;border-radius:8px;border:1px solid #d0d5dd;font-family:inherit}
.cc-edit label.chk{display:flex;gap:6px;align-items:center;font-size:12px;color:#475569}
.cc-btn{border:1px solid #5A27E0;background:#fff;color:#5A27E0;border-radius:8px;padding:5px 10px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}
.cc-btn.primary{background:#5A27E0;color:#fff}
.cc-link{border:0;background:none;color:#5A27E0;font-weight:700;font-size:12px;cursor:pointer;padding:0;font-family:inherit}
.cc-err{font-size:11.5px;color:#b91c1c}
`;

export function ContactsCard({ matterId, api }: { matterId: string; api: Api }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [editing, setEditing] = useState<string | null>(null); // contact id, or 'new'
  const [draft, setDraft] = useState<{ name: string; email: string; role: string; phone: string; whatsappOptIn: boolean }>({ name: '', email: '', role: 'CLIENT', phone: '', whatsappOptIn: false });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ contacts: Contact[] }>(`/matters/${matterId}/contacts`).then((r) => setContacts(r.contacts)).catch(() => {}), [api, matterId]);
  useEffect(() => { void load(); }, [load]);

  const start = (c: Contact | null) => {
    setErr(null);
    setEditing(c ? c.id : 'new');
    setDraft(c ? { name: c.name ?? '', email: c.email, role: c.role ?? 'UNKNOWN', phone: c.phone ?? '', whatsappOptIn: !!c.whatsappOptIn } : { name: '', email: '', role: 'CLIENT', phone: '', whatsappOptIn: false });
  };
  const save = async () => {
    if (!EMAIL_RE.test(draft.email.trim())) { setErr('A valid email is needed.'); return; }
    if (draft.whatsappOptIn && !draft.phone.trim()) { setErr('WhatsApp needs a mobile number.'); return; }
    setBusy(true); setErr(null);
    try {
      const original = editing && editing !== 'new' ? contacts.find((c) => c.id === editing) : null;
      // An email change is a new row; the old one goes.
      if (original && original.email !== draft.email.trim().toLowerCase()) await api(`/matters/${matterId}/contacts?id=${original.id}`, { method: 'DELETE' });
      await api(`/matters/${matterId}/contacts`, { method: 'POST', body: JSON.stringify({ email: draft.email.trim().toLowerCase(), name: draft.name.trim() || undefined, role: draft.role, phone: draft.phone.trim() || null, whatsappOptIn: draft.whatsappOptIn }) });
      setEditing(null);
      await load();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  };
  const remove = async (c: Contact) => {
    if (!window.confirm(`Remove ${c.name || c.email} from this case?`)) return;
    await api(`/matters/${matterId}/contacts?id=${c.id}`, { method: 'DELETE' }).catch(() => {});
    await load();
  };
  const form = (
    <div className="cc-edit">
      <input placeholder="Name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
      <select value={draft.role} onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))}>{ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <input type="email" placeholder="Email" value={draft.email} onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))} />
      <input type="tel" placeholder="Mobile" value={draft.phone} onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} />
      <label className="chk"><input type="checkbox" checked={draft.whatsappOptIn} onChange={(e) => setDraft((d) => ({ ...d, whatsappOptIn: e.target.checked }))} /> Has opted in to WhatsApp</label>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" className="cc-btn" onClick={() => setEditing(null)}>Cancel</button>
        <button type="button" className="cc-btn primary" disabled={busy} onClick={() => void save()}>{busy ? <Spin>Saving…</Spin> : 'Save'}</button>
      </div>
      {err && <div className="cc-err" style={{ gridColumn: '1 / -1' }}>{err}</div>}
    </div>
  );
  return (
    <div className="cc">
      <style>{CONTACTS_CSS}</style>
      {contacts.map((c) => (
        <div key={c.id} className="cc-row">
          <div style={{ minWidth: 0 }}>
            <div className="n">{c.name || c.email}{c.role && c.role !== 'UNKNOWN' ? <span className="r"> · {ROLES.find(([v]) => v === c.role)?.[1] ?? c.role}</span> : null}</div>
            <div className="e">{c.email}{c.phone ? ` · ${c.phone}${c.whatsappOptIn ? ' (WhatsApp)' : ''}` : ''}</div>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button type="button" className="cc-link" onClick={() => start(c)}>Edit</button>
            <button type="button" className="cc-x" onClick={() => void remove(c)} aria-label="Remove"><X size={12} /></button>
          </div>
          {editing === c.id && form}
        </div>
      ))}
      {editing === 'new' ? form : <button type="button" className="cc-link" onClick={() => start(null)}>+ Add a contact</button>}
    </div>
  );
}
