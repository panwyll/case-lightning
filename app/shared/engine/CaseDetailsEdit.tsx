'use client';
/**
 * The facts of a case, edited in one place: the property, every client (name, email, mobile),
 * the other side, the price, the lender and the target dates. Every client with an email is
 * written to; the engine's clients (their ID checks, the signers) follow the names.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X } from '@/app/shared/icons';
import type { Api } from './types';

interface Contact { id: string; email: string; name: string | null; role: string | null; phone: string | null }
interface ClientRow { name: string; email: string; phone: string; contactId: string | null }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const CSS = `
.cd-veil{position:fixed;inset:0;background:rgba(15,23,42,.42);z-index:70;display:flex;align-items:flex-start;justify-content:center;padding:48px 16px 16px;overflow-y:auto}
.cd{background:#fff;border-radius:14px;width:100%;max-width:640px;box-shadow:0 24px 64px rgba(15,23,42,.26);display:grid}
.cd-h{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid #f1f5f9}
.cd-h h2{margin:0;font-size:16px;font-weight:800;color:#0f172a}
.cd-h .x{margin-left:auto;border:0;background:none;color:#64748b;cursor:pointer;padding:4px;border-radius:6px;display:flex}
.cd-h .x:hover{background:#f1f5f9}
.cd-b{padding:4px 20px 16px;display:grid}
.cd-sec{padding-top:14px}
.cd-sec h3{margin:0 0 8px;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#64748b}
.cd-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px}
.cd-f{display:grid;gap:4px;min-width:0}
.cd-f.wide{grid-column:1 / -1}
.cd-f>span{font-size:12px;font-weight:700;color:#334155}
.cd-in{border:1px solid #cbd5e1;border-radius:8px;padding:7px 9px;font:inherit;font-size:13px;color:#0f172a;background:#fff;width:100%;box-sizing:border-box}
.cd-in:focus{outline:2px solid #c4b5fd;border-color:#8b5cf6}
.cd-in.bad{border-color:#f87171;background:#fef2f2}
.cd-people{display:grid;gap:8px}
.cd-person{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1.3fr) minmax(0,.9fr) 28px;gap:8px;align-items:center}
.cd-person.names{grid-template-columns:minmax(0,1fr) 28px}
.cd-cols{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1.3fr) minmax(0,.9fr) 28px;gap:8px;font-size:11.5px;font-weight:700;color:#64748b}
.cd-rm{width:28px;height:28px;border:0;background:#f1f5f9;border-radius:7px;color:#64748b;cursor:pointer;display:flex;align-items:center;justify-content:center}
.cd-rm:hover{background:#fee2e2;color:#b91c1c}
.cd-rm:disabled{opacity:.35;cursor:default;background:#f1f5f9;color:#64748b}
.cd-add{justify-self:start;display:inline-flex;align-items:center;gap:6px;border:0;background:none;color:#5A27E0;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;padding:2px 0}
.cd-err{font-size:12.5px;color:#b91c1c;margin-top:10px}
.cd-a{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid #f1f5f9;background:#fafafa;border-radius:0 0 14px 14px}
.cd-a .ep-btn{margin:0}
@media (max-width:600px){.cd-grid{grid-template-columns:1fr}.cd-person,.cd-cols{grid-template-columns:1fr 28px}.cd-person>input:nth-child(2),.cd-person>input:nth-child(3){grid-column:1}.cd-cols{display:none}}
`;

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v ? v.split(/\s*,\s*/) : []);
/** "Hannah & Josh Reid" is two people: Hannah Reid and Josh Reid. */
const people = (names: string[]): string[] => names.flatMap((n) => {
  const parts = n.split(/\s+(?:&|and)\s+/i).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return [n.trim()];
  const surname = parts[parts.length - 1].split(/\s+/).slice(1).join(' ');
  return parts.map((x) => (surname && !/\s/.test(x) ? `${x} ${surname}` : x));
});
const dateOnly = (v: unknown) => (v ? String(v).slice(0, 10) : '');

export function CaseDetailsEdit({ matterId, api, matter, side, onSaved }: { matterId: string; api: Api; matter: Record<string, unknown>; side: string; onSaved: (notes: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const sale = side === 'seller';
  const clientWord = sale ? 'Sellers' : side === 'owner' ? 'Owners' : 'Buyers';
  const otherWord = sale ? 'Buyers' : 'Sellers';
  const [address, setAddress] = useState('');
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [others, setOthers] = useState<string[]>([]);
  const [original, setOriginal] = useState<Contact[]>([]);
  const [f, setF] = useState({ price: '', lender: '', solicitor: '', agent: '', exchange: '', completion: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setAddress(String(matter.property_address ?? ''));
    setF({ price: String(matter.purchase_price ?? ''), lender: String(matter.lender ?? ''), solicitor: String(matter.counterparty_solicitor ?? ''), agent: String(matter.counterparty_agent ?? ''), exchange: dateOnly(matter.exchange_target_date), completion: dateOnly(matter.completion_target_date) });
    const mine = people(list(sale ? matter.seller_names : matter.buyer_names));
    setOthers(people(list(sale ? matter.buyer_names : matter.seller_names)));
    setClients(mine.map((name) => ({ name, email: '', phone: '', contactId: null })));
    let live = true;
    api<{ contacts: Contact[] }>(`/matters/${matterId}/contacts`).then((r) => {
      if (!live) return;
      const cs = r.contacts.filter((c) => c.role === 'CLIENT');
      setOriginal(cs);
      // Each client name takes the contact of the same name; contacts left over are clients too.
      const used = new Set<string>();
      const rows: ClientRow[] = mine.map((name) => {
        const c = cs.find((x) => !used.has(x.id) && (x.name ?? '').trim().toLowerCase() === name.trim().toLowerCase()) ?? cs.find((x) => !used.has(x.id) && !x.name);
        if (c) used.add(c.id);
        return { name, email: c?.email ?? '', phone: c?.phone ?? '', contactId: c?.id ?? null };
      });
      for (const c of cs) if (!used.has(c.id)) rows.push({ name: c.name ?? '', email: c.email, phone: c.phone ?? '', contactId: c.id });
      setClients(rows.length ? rows : [{ name: '', email: '', phone: '', contactId: null }]);
    }).catch(() => {});
    return () => { live = false; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const setClient = (i: number, patch: Partial<ClientRow>) => setClients(clients.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const badEmail = (e: string) => !!e.trim() && !EMAIL_RE.test(e.trim());

  const save = async () => {
    const named = clients.filter((c) => c.name.trim());
    if (!named.length) { setErr(`Name at least one of the ${clientWord.toLowerCase()}.`); return; }
    if (clients.some((c) => badEmail(c.email))) { setErr('One of the email addresses is not valid.'); return; }
    if (clients.some((c) => c.email.trim() && !c.name.trim())) { setErr('Every email needs a name beside it.'); return; }
    setSaving(true); setErr(null);
    try {
      const myNames = named.map((c) => c.name.trim());
      const otherNames = others.map((n) => n.trim()).filter(Boolean);
      const body: Record<string, unknown> = {
        propertyAddress: address.trim() || undefined,
        [sale ? 'sellerNames' : 'buyerNames']: myNames,
        [sale ? 'buyerNames' : 'sellerNames']: otherNames,
        purchasePrice: f.price.trim(),
        lender: f.lender.trim(),
        counterpartySolicitor: f.solicitor.trim(),
        counterpartyAgent: f.agent.trim(),
        ...(f.exchange && f.exchange !== dateOnly(matter.exchange_target_date) ? { exchangeTargetDate: f.exchange } : {}),
        ...(f.completion && f.completion !== dateOnly(matter.completion_target_date) ? { completionTargetDate: f.completion } : {}),
      };
      const r = await api<{ engineNotes?: string[] }>(`/matters/${matterId}`, { method: 'PATCH', body: JSON.stringify(body) });
      // The clients' addresses: every one with an email is written to.
      const kept = new Set<string>();
      for (const c of named) {
        const email = c.email.trim().toLowerCase();
        if (!email) continue;
        kept.add(email);
        await api(`/matters/${matterId}/contacts`, { method: 'POST', body: JSON.stringify({ email, name: c.name.trim(), role: 'CLIENT', phone: c.phone.trim() || null }) });
      }
      for (const o of original) if (!kept.has(o.email.toLowerCase())) await api(`/matters/${matterId}/contacts?id=${o.id}`, { method: 'DELETE' });
      onSaved(r.engineNotes ?? []);
      // Saved, but the case could not take part of it (dates after exchange, say): say so here rather than close.
      if (r.engineNotes?.length) setErr(`Saved. Not applied to the case: ${r.engineNotes.join(' ')}`);
      else setOpen(false);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const input = (label: string, key: keyof typeof f, opts: { type?: string; wide?: boolean; prefix?: boolean } = {}) => (
    <label className={`cd-f${opts.wide ? ' wide' : ''}`}><span>{label}</span><input className="cd-in" type={opts.type ?? 'text'} inputMode={opts.prefix ? 'decimal' : undefined} value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} /></label>
  );

  const trigger = <button type="button" className="cc-link" style={{ border: 0, background: 'none', color: '#5A27E0', fontWeight: 700, fontSize: 12, cursor: 'pointer', padding: 0, fontFamily: 'inherit' }} onClick={() => setOpen(true)}>Edit Details</button>;
  if (!open || typeof document === 'undefined') return trigger;
  return <>
    {trigger}
    {createPortal(
      <div className="cd-veil" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) setOpen(false); }}>
        <style>{CSS}</style>
        <div className="cd" role="dialog" aria-label="Edit Details">
          <div className="cd-h"><h2>Edit Details</h2><button type="button" className="x" aria-label="Close" onClick={() => setOpen(false)} disabled={saving}><X size={16} /></button></div>
          <div className="cd-b">
            <div className="cd-sec">
              <h3>Property</h3>
              <label className="cd-f wide"><span>Address</span><input className="cd-in" value={address} onChange={(e) => setAddress(e.target.value)} /></label>
            </div>
            <div className="cd-sec">
              <h3>{clientWord}</h3>
              <div className="cd-people">
                <div className="cd-cols"><span>Name</span><span>Email</span><span>Mobile</span><span /></div>
                {clients.map((c, i) => (
                  <div key={i} className="cd-person">
                    <input className="cd-in" aria-label="Name" value={c.name} onChange={(e) => setClient(i, { name: e.target.value })} />
                    <input className={`cd-in${badEmail(c.email) ? ' bad' : ''}`} aria-label="Email" type="email" value={c.email} onChange={(e) => setClient(i, { email: e.target.value })} />
                    <input className="cd-in" aria-label="Mobile" type="tel" value={c.phone} onChange={(e) => setClient(i, { phone: e.target.value })} />
                    <button type="button" className="cd-rm" aria-label={`Remove ${c.name || 'this client'}`} disabled={clients.length === 1} onClick={() => setClients(clients.filter((_, j) => j !== i))}><X size={16} /></button>
                  </div>
                ))}
                <button type="button" className="cd-add" onClick={() => setClients([...clients, { name: '', email: '', phone: '', contactId: null }])}><Plus size={16} />Add {sale ? 'Seller' : side === 'owner' ? 'Owner' : 'Buyer'}</button>
              </div>
            </div>
            <div className="cd-sec">
              <h3>Other Side</h3>
              <div className="cd-grid">
                <div className="cd-f wide"><span>{otherWord}</span>
                  <div className="cd-people">
                    {others.map((n, i) => (
                      <div key={i} className="cd-person names">
                        <input className="cd-in" aria-label={`${otherWord} name`} value={n} onChange={(e) => setOthers(others.map((x, j) => (j === i ? e.target.value : x)))} />
                        <button type="button" className="cd-rm" aria-label="Remove" onClick={() => setOthers(others.filter((_, j) => j !== i))}><X size={16} /></button>
                      </div>
                    ))}
                    <button type="button" className="cd-add" onClick={() => setOthers([...others, ''])}><Plus size={16} />Add {sale ? 'Buyer' : 'Seller'}</button>
                  </div>
                </div>
                {input('Their Solicitor', 'solicitor')}
                {input('Estate Agent', 'agent')}
              </div>
            </div>
            <div className="cd-sec">
              <h3>Money And Dates</h3>
              <div className="cd-grid">
                {input('Price', 'price', { prefix: true })}
                {input('Lender', 'lender')}
                {input('Exchange Target', 'exchange', { type: 'date' })}
                {input('Completion Target', 'completion', { type: 'date' })}
              </div>
            </div>
            {err && <div className="cd-err">{err}</div>}
          </div>
          <div className="cd-a">
            <button type="button" className="ep-btn" disabled={saving} onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="ep-btn primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>,
      document.body,
    )}
  </>;
}
