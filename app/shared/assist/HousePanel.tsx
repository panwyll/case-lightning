'use client';
// The House tab's property record and the matter's contacts list — shared between
// the Outlook taskpane and the web inbox. `api` is injected (matching MatterDrawer)
// so each surface supplies its own auth-aware fetch.
import { useEffect, useState } from 'react';
import type * as React from 'react';
import { composeAddress, parseAddress, type AddrParts } from '@/lib/address';
import { S } from './styles';
import { Label } from './ui';
import { STAGES, TRACKS, STATUS_FLAGS } from './constants';

type Api = <T = any>(path: string, options?: RequestInit) => Promise<T>;

// The House tab's property record: controlled fields with validation and an
// explicit Save / Discard (no silent save-on-blur). Keyed by matter id by the
// caller so it re-initialises when the matter changes. Buyers/sellers are
// read-only (the matter PATCH doesn't accept them); stage/status are enum selects
// that apply immediately. Purchase price is validated as a money value.
const MONEY_RE = /^£?\s*\d{1,3}(,\d{3})*(\.\d{1,2})?$|^£?\s*\d+(\.\d{1,2})?$/;

function seedAddr(matter: any): AddrParts {
  const p = matter.address_parts;
  if (p && typeof p === 'object') return { building: p.building || '', street: p.street || '', town: p.town || '', postcode: p.postcode || '', country: p.country || '' };
  return parseAddress(matter.property_address ?? '');
}

// A person + their firm, stored as one "Name, Firm" string. Split on the FIRST comma only,
// so a firm with commas ("Delaney, Webb & Co") survives; round-trips cleanly on save.
type PartyParts = { name: string; firm: string };
function splitParty(s: string): PartyParts {
  const i = (s || '').indexOf(',');
  return i === -1 ? { name: (s || '').trim(), firm: '' } : { name: s.slice(0, i).trim(), firm: s.slice(i + 1).trim() };
}
function joinParty(p: PartyParts): string {
  return [p.name, p.firm].map((x) => (x || '').trim()).filter(Boolean).join(', ');
}
export function HousePanel({
  matter,
  facts,
  onPatch,
  history,
  members,
  stages,
}: {
  matter: any;
  facts: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => Promise<unknown>;
  history: any[];
  members: Array<{ id: string; display_name: string | null; email: string; role: string }>;
  stages: Array<{ key: string; name: string }>;
}) {
  const dateStr = (s: unknown) => (s ? String(s).slice(0, 10) : '');
  const priceKey = Object.keys(facts).find((k) => /price|consideration|value|offer/i.test(k));
  const initial = {
    track: matter.track || 'PURCHASE',
    propertyAddress: matter.property_address ?? '',
    purchasePrice: matter.purchase_price ?? (priceKey ? String(facts[priceKey]) : ''),
    counterpartySolicitor: matter.counterparty_solicitor ?? '',
    counterpartyAgent: matter.counterparty_agent ?? '',
    lender: matter.lender ?? '',
    chainPosition: matter.chain_position ?? '',
    exchangeTargetDate: dateStr(matter.exchange_target_date),
    completionTargetDate: dateStr(matter.completion_target_date),
  };
  type Draft = typeof initial;
  const [draft, setDraft] = useState<Draft>(initial);
  const [baseline, setBaseline] = useState<Draft>(initial);
  const set = (k: keyof Draft, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const [openField, setOpenField] = useState<keyof Draft | null>(null);
  // Structured address editing: parts seeded from address_parts (or a legacy parse), an
  // expand toggle, and a setter that recomposes the display string into the draft.
  const [addr, setAddr] = useState<AddrParts>(() => seedAddr(matter));
  const [addrEditing, setAddrEditing] = useState(false);
  const setAddrPart = (k: keyof AddrParts, v: string) => {
    const next = { ...addr, [k]: v };
    setAddr(next);
    setDraft((d) => ({ ...d, propertyAddress: composeAddress(next) }));
  };
  // Structured name/firm editing for the solicitor + estate agent (each stored as one string).
  type PartyKey = 'counterpartySolicitor' | 'counterpartyAgent';
  const [solParts, setSolParts] = useState<PartyParts>(() => splitParty(initial.counterpartySolicitor));
  const [agentParts, setAgentParts] = useState<PartyParts>(() => splitParty(initial.counterpartyAgent));
  const [editingParty, setEditingParty] = useState<PartyKey | null>(null);
  const setPartyPart = (which: PartyKey, key: keyof PartyParts, v: string) => {
    if (which === 'counterpartySolicitor') {
      const next = { ...solParts, [key]: v };
      setSolParts(next);
      setDraft((d) => ({ ...d, counterpartySolicitor: joinParty(next) }));
    } else {
      const next = { ...agentParts, [key]: v };
      setAgentParts(next);
      setDraft((d) => ({ ...d, counterpartyAgent: joinParty(next) }));
    }
  };
  // Map each editable field to the DB field name used in the figure-change audit, so a
  // field's label can reveal its own history.
  const DB_FIELD: Partial<Record<keyof Draft, string>> = {
    propertyAddress: 'property_address',
    purchasePrice: 'purchase_price',
    counterpartySolicitor: 'counterparty_solicitor',
    counterpartyAgent: 'counterparty_agent',
    lender: 'lender',
    chainPosition: 'chain_position',
    exchangeTargetDate: 'exchange_target_date',
    completionTargetDate: 'completion_target_date',
    track: 'track',
  };

  const priceValid = !draft.purchasePrice.trim() || MONEY_RE.test(draft.purchasePrice.trim());
  const keys = Object.keys(draft) as (keyof Draft)[];
  const dirty = keys.some((k) => draft[k] !== baseline[k]);
  const canSave = dirty && priceValid;
  const join = (a?: string[]) => (a && a.length ? a.join(', ') : '');

  const save = async () => {
    const patch: Record<string, unknown> = {};
    keys.forEach((k) => { if (draft[k] !== baseline[k]) patch[k] = draft[k].trim(); });
    // Address edits go out as both the composed display string and the structured parts.
    if (patch.propertyAddress !== undefined) patch.addressParts = addr;
    if (!Object.keys(patch).length) return;
    await onPatch(patch);
    setBaseline(draft);
  };

  // Shared change-history list (reused by the field() rows and the address block).
  const histRows = (rows: any[]) => (
    <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {rows.map((h: any) => (
        <div key={h.id} style={{ fontSize: 11, color: '#4A4358', background: '#FBFAFF', border: '1px solid #ECE7F8', borderRadius: 8, padding: '5px 8px' }}>
          <div>
            <span style={{ color: '#94a3b8', textDecoration: h.old_value ? 'line-through' : 'none' }}>{h.old_value || '—'}</span>
            {' → '}
            <span style={{ color: '#5A27E0', fontWeight: 700 }}>{h.new_value || '—'}</span>
          </div>
          <div style={{ color: '#7A7388', marginTop: 1 }}>
            {h.actor || 'CONVEYi'} · {new Date(h.created_at).toLocaleDateString()} ·{' '}
            {h.source === 'MANUAL' ? 'by hand' : h.source === 'AI_EMAIL' ? 'from email' : h.source === 'AI_DOC' ? 'from a document' : String(h.source).toLowerCase()}
            {h.ref_label ? ` · ${h.ref_kind === 'EMAIL' ? '✉' : '📎'} ${h.ref_label}` : ''}
          </div>
          {h.reason && h.source === 'MANUAL' && <div style={{ fontStyle: 'italic', color: '#7A7388', marginTop: 1 }}>{h.reason}</div>}
        </div>
      ))}
    </div>
  );

  const field = (label: string, k: keyof Draft, type = 'text', valid = true, placeholder?: string) => {
    const dbf = DB_FIELD[k];
    const rows = dbf ? history.filter((h: any) => h.field === dbf) : [];
    const open = openField === k;
    return (
      <div style={{ marginBottom: 6 }}>
        <span
          style={{ ...S.fieldLabel, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: rows.length ? 'pointer' : 'default' }}
          onClick={rows.length ? () => setOpenField(open ? null : k) : undefined}
          title={rows.length ? 'Show change history' : undefined}
        >
          {label}
          {rows.length > 0 && (
            <span style={{ fontSize: 10, fontWeight: 700, color: '#5A27E0', background: '#EDE7FB', borderRadius: 8, padding: '1px 6px' }}>
              {rows.length} {open ? '⌃' : '⌄'}
            </span>
          )}
        </span>
        <input
          style={{ ...S.input, marginBottom: 0, ...(valid ? {} : { borderColor: '#dc2626' }) }}
          type={type}
          value={draft[k]}
          placeholder={placeholder}
          onChange={(e) => set(k, e.target.value)}
        />
        {!valid && <span style={{ fontSize: 11, color: '#dc2626' }}>Enter a valid amount, e.g. £210,000</span>}
        {open && rows.length > 0 && histRows(rows)}
      </div>
    );
  };

  // Property address: a fixed, formatted display with an Edit button that expands the
  // structured form (house name/number, street, town, postcode, country).
  const addressBlock = () => {
    const rows = history.filter((h: any) => h.field === 'property_address');
    const open = openField === 'propertyAddress';
    const part = (label: string, k: keyof AddrParts, placeholder: string, style?: React.CSSProperties) => (
      <label style={{ display: 'block', ...style }}>
        <span style={{ ...S.fieldLabel, fontSize: 10, textTransform: 'none', letterSpacing: 0 }}>{label}</span>
        <input style={{ ...S.input, marginBottom: 6 }} value={addr[k]} placeholder={placeholder} onChange={(e) => setAddrPart(k, e.target.value)} />
      </label>
    );
    return (
      <div style={{ marginBottom: 6 }}>
        <span
          style={{ ...S.fieldLabel, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: rows.length ? 'pointer' : 'default' }}
          onClick={rows.length ? () => setOpenField(open ? null : 'propertyAddress') : undefined}
          title={rows.length ? 'Show change history' : undefined}
        >
          Property address
          {rows.length > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: '#5A27E0', background: '#EDE7FB', borderRadius: 8, padding: '1px 6px' }}>{rows.length} {open ? '⌃' : '⌄'}</span>}
        </span>
        {!addrEditing ? (
          <div style={{ display: 'flex', alignItems: 'stretch', gap: 6 }}>
            <div style={{ ...S.input, marginBottom: 0, flex: 1, minHeight: 34, display: 'flex', alignItems: 'center', background: '#F8F7FC', color: draft.propertyAddress ? '#1C1530' : '#94a3b8' }}>
              {draft.propertyAddress || 'No address set'}
            </div>
            <button type="button" onClick={() => setAddrEditing(true)} style={{ flex: 'none', padding: '0 12px', borderRadius: 8, border: '1px solid #D9D2EC', background: '#fff', color: '#5A27E0', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Edit</button>
          </div>
        ) : (
          <div style={{ border: '1px solid #E7E2F3', borderRadius: 10, padding: 10, background: '#FBFAFF' }}>
            {part('House name / number', 'building', 'e.g. 14 or Rose Cottage')}
            {part('Street', 'street', 'e.g. Oak Street')}
            {part('Town / city', 'town', 'e.g. Leeds')}
            <div style={{ display: 'flex', gap: 6 }}>
              {part('Postcode', 'postcode', 'e.g. LS1 2AB', { flex: 1 })}
              {part('Country', 'country', 'United Kingdom', { flex: 1 })}
            </div>
            <button type="button" onClick={() => setAddrEditing(false)} style={{ marginTop: 2, padding: '5px 12px', borderRadius: 8, border: 'none', background: '#5A27E0', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Done</button>
          </div>
        )}
        {open && rows.length > 0 && histRows(rows)}
      </div>
    );
  };

  // A person + firm (solicitor / estate agent): fixed display + Edit → Name & Firm inputs,
  // composed back into the single field. Mirrors the address block.
  const partyBlock = (label: string, k: PartyKey, emptyLabel: string, namePlaceholder: string, firmPlaceholder: string) => {
    const dbf = DB_FIELD[k];
    const rows = dbf ? history.filter((h: any) => h.field === dbf) : [];
    const open = openField === k;
    const parts = k === 'counterpartySolicitor' ? solParts : agentParts;
    const editing = editingParty === k;
    const partInput = (plabel: string, pkey: keyof PartyParts, placeholder: string) => (
      <label style={{ display: 'block' }}>
        <span style={{ ...S.fieldLabel, fontSize: 10, textTransform: 'none', letterSpacing: 0 }}>{plabel}</span>
        <input style={{ ...S.input, marginBottom: 6 }} value={parts[pkey]} placeholder={placeholder} onChange={(e) => setPartyPart(k, pkey, e.target.value)} />
      </label>
    );
    return (
      <div style={{ marginBottom: 6 }}>
        <span
          style={{ ...S.fieldLabel, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: rows.length ? 'pointer' : 'default' }}
          onClick={rows.length ? () => setOpenField(open ? null : k) : undefined}
          title={rows.length ? 'Show change history' : undefined}
        >
          {label}
          {rows.length > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: '#5A27E0', background: '#EDE7FB', borderRadius: 8, padding: '1px 6px' }}>{rows.length} {open ? '⌃' : '⌄'}</span>}
        </span>
        {!editing ? (
          <div style={{ display: 'flex', alignItems: 'stretch', gap: 6 }}>
            <div style={{ ...S.input, marginBottom: 0, flex: 1, minHeight: 34, display: 'flex', alignItems: 'center', background: '#F8F7FC', color: draft[k] ? '#1C1530' : '#94a3b8' }}>
              {draft[k] || emptyLabel}
            </div>
            <button type="button" onClick={() => setEditingParty(k)} style={{ flex: 'none', padding: '0 12px', borderRadius: 8, border: '1px solid #D9D2EC', background: '#fff', color: '#5A27E0', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Edit</button>
          </div>
        ) : (
          <div style={{ border: '1px solid #E7E2F3', borderRadius: 10, padding: 10, background: '#FBFAFF' }}>
            {partInput('Name', 'name', namePlaceholder)}
            {partInput('Firm', 'firm', firmPlaceholder)}
            <button type="button" onClick={() => setEditingParty(null)} style={{ marginTop: 2, padding: '5px 12px', borderRadius: 8, border: 'none', background: '#5A27E0', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Done</button>
          </div>
        )}
        {open && rows.length > 0 && histRows(rows)}
      </div>
    );
  };

  return (
    <section style={S.card}>
      <Label>{matter.matter_ref}</Label>
      <label style={{ display: 'block', marginBottom: 6 }}>
        <span style={S.fieldLabel}>Acting For</span>
        <select style={{ ...S.input, marginBottom: 0 }} value={draft.track} onChange={(e) => set('track', e.target.value)}>
          {TRACKS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      {members.length > 1 && (
        <label style={{ display: 'block', marginBottom: 6 }}>
          <span style={S.fieldLabel}>Assigned to</span>
          <select
            style={{ ...S.input, marginBottom: 0 }}
            value={matter.assigned_to || ''}
            onChange={(e) => onPatch({ assignedTo: e.target.value || null })}
          >
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.display_name || m.email}</option>
            ))}
          </select>
        </label>
      )}
      {addressBlock()}
      {field('Purchase Price', 'purchasePrice', 'text', priceValid, '£')}
      {join(matter.buyer_names) && <div style={S.kv}><span>Buyer(s)</span><span style={{ textAlign: 'right' }}>{join(matter.buyer_names)}</span></div>}
      {join(matter.seller_names) && <div style={S.kv}><span>Seller(s)</span><span style={{ textAlign: 'right' }}>{join(matter.seller_names)}</span></div>}
      {partyBlock('Other Side (Solicitor)', 'counterpartySolicitor', 'No solicitor set', 'e.g. Chloe Patel', 'e.g. Delaney & Webb')}
      {partyBlock('Estate Agent', 'counterpartyAgent', 'No agent set', 'e.g. Ben Ashworth', 'e.g. Bramley & Vale')}
      {field('Lender', 'lender', 'text', true, 'e.g. Santander')}
      {field('Chain Position', 'chainPosition', 'text', true, 'e.g. 2nd in a chain of 3')}
      <div style={{ display: 'flex', gap: 6 }}>
        {field('Exchange Target', 'exchangeTargetDate', 'date')}
        {field('Completion Target', 'completionTargetDate', 'date')}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <label style={{ flex: 1 }}>
          <span style={S.fieldLabel}>Stage</span>
          <select style={{ ...S.input, marginBottom: 0 }} value={matter.stage || 'INSTRUCTION'} onChange={(e) => onPatch({ stage: e.target.value })}>
            {(stages.length ? stages.map((s) => [s.key, s.name] as [string, string]) : STAGES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label style={{ flex: 1 }}>
          <span style={S.fieldLabel}>Status</span>
          <select style={{ ...S.input, marginBottom: 0 }} value={matter.status_flag || 'ON_TRACK'} onChange={(e) => onPatch({ statusFlag: e.target.value })}>
            {STATUS_FLAGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      {dirty && (
        <div style={{ display: 'flex', gap: 6, marginTop: 10, paddingTop: 10, borderTop: '1px solid #e2e8f0' }}>
          <button style={{ ...S.primary, marginTop: 0, flex: 1, opacity: canSave ? 1 : 0.5 }} onClick={save} disabled={!canSave}>
            Save changes
          </button>
          <button style={S.secondary} onClick={() => { setDraft(baseline); setAddr(seedAddr(matter)); setAddrEditing(false); setSolParts(splitParty(baseline.counterpartySolicitor)); setAgentParts(splitParty(baseline.counterpartyAgent)); setEditingParty(null); }}>Discard</button>
        </div>
      )}
    </section>
  );
}

const CONTACT_ROLES: [string, string][] = [
  ['CLIENT', 'Client'],
  ['OTHER_SIDE', 'Other side'],
  ['AGENT', 'Estate agent'],
  ['LENDER', 'Lender'],
  ['OUR_FIRM', 'Our firm'],
  ['OTHER', 'Other'],
  ['UNKNOWN', '—'],
];

// The matter's address book: every party we've seen on its email traffic, each
// taggable with a role so actions like "email the client" can target the right
// person rather than only ever replying to the sender. Two-way: role edits and
// manual adds persist; new addresses appear as emails are matched to the case.
export function ContactsPanel({ matterId, initial, api }: { matterId: string; initial: any[]; api: Api }) {
  const [contacts, setContacts] = useState<any[]>(initial);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  useEffect(() => setContacts(initial), [initial]);

  const setRole = async (c: any, role: string) => {
    setContacts((cs) => cs.map((x) => (x.id === c.id ? { ...x, role } : x)));
    await api(`/matters/${matterId}/contacts`, { method: 'POST', body: JSON.stringify({ email: c.email, role }) }).catch(() => {});
  };
  const add = async () => {
    const e = email.trim().toLowerCase();
    if (!e.includes('@')) return;
    await api(`/matters/${matterId}/contacts`, {
      method: 'POST',
      body: JSON.stringify({ email: e, name: name.trim() || undefined }),
    }).catch(() => {});
    const r = await api<{ contacts: any[] }>(`/matters/${matterId}/contacts`).catch(() => ({ contacts }));
    setContacts(r.contacts);
    setEmail('');
    setName('');
  };
  const remove = async (c: any) => {
    setContacts((cs) => cs.filter((x) => x.id !== c.id));
    await api(`/matters/${matterId}/contacts?id=${c.id}`, { method: 'DELETE' }).catch(() => {});
  };

  return (
    <section style={S.card}>
      <Label>People</Label>
      {contacts.length === 0 && (
        <p style={{ ...S.muted, margin: '4px 0 8px' }}>No contacts yet — they’ll appear as emails are matched to this case.</p>
      )}
      {contacts.map((c) => (
        <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || c.email}</div>
            {c.name && <div style={{ fontSize: 11, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.email}</div>}
          </div>
          <select
            style={{ ...S.input, marginBottom: 0, width: 116, flex: '0 0 auto' }}
            value={c.role || 'UNKNOWN'}
            onChange={(e) => setRole(c, e.target.value)}
          >
            {CONTACT_ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button style={{ ...S.iconAction, width: 30, height: 30 }} onClick={() => remove(c)} title="Remove contact" aria-label="Remove contact">✕</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, paddingTop: 8, borderTop: '1px solid #e2e8f0' }}>
        <input style={{ ...S.input, marginBottom: 0, flex: 1 }} placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input style={{ ...S.input, marginBottom: 0, width: 90 }} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <button style={S.secondary} onClick={add}>Add</button>
      </div>
    </section>
  );
}
