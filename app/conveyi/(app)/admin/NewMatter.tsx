'use client';
import { useEffect, useState } from 'react';
import { matterRefFrom, fallbackMatterRef } from '@/lib/ref-name';
import { composeAddress, EMPTY_ADDR, UK_POSTCODE_RE, type AddrParts } from '@/lib/address';
import { X } from '@/app/shared/icons';
import { LenderPicker } from '@/app/shared/engine/LenderPicker';
import { ChainPicker, type ChainOption } from '@/app/shared/engine/ChainPicker';

async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('cl_token') : null;
  const res = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  // A write can raise or clear a task: the sidebar number re-reads.
  if ((options.method ?? 'GET').toUpperCase() !== 'GET' && typeof window !== 'undefined') window.dispatchEvent(new Event('conveyi:counts'));
  return json as T;
}

const TRACKS: Array<[string, string]> = [
  ['PURCHASE', 'Purchase (acting for the buyer)'],
  ['SALE', 'Sale (acting for the seller)'],
  ['REMORTGAGE', 'Remortgage'],
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;

interface Person { name: string; email: string; phone: string }
interface Found { line1: string; line2: string; town: string; county: string; postcode: string; label: string }
const blank = (): Person => ({ name: '', email: '', phone: '' });

/**
 * A new case with everyone on it reachable from day one: the property found from its
 * postcode, the clients with an email each (the ID check, the proof-of-funds form and
 * every update go to them), the other side's solicitor with an email (the contract pack
 * request and the chases go there), the agent and the lender when known.
 */
export default function NewMatter({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [addr, setAddr] = useState<AddrParts>({ ...EMPTY_ADDR, country: 'England' });
  const [found, setFound] = useState<Found[] | null>(null);
  const [looking, setLooking] = useState(false);
  const [pcNote, setPcNote] = useState<string | null>(null);
  const [track, setTrack] = useState('PURCHASE');
  const [price, setPrice] = useState('');
  const [clients, setClients] = useState<Person[]>([blank()]);
  const [others, setOthers] = useState('');
  const [sideKnown, setSideKnown] = useState(true);
  const [firm, setFirm] = useState('');
  const [sideName, setSideName] = useState('');
  const [sideEmail, setSideEmail] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agentEmail, setAgentEmail] = useState('');
  const [lender, setLender] = useState('');
  // A purchase is on a mortgage or cash; a sale has a mortgage to pay off or not. It shapes the case's flow.
  const [mortgaged, setMortgaged] = useState(true);
  // The client's chain: on a purchase, their sale (and the reverse), if the firm acts on it too. Linked as the case is created.
  const [chainOptions, setChainOptions] = useState<ChainOption[]>([]);
  const [linkTo, setLinkTo] = useState('');
  // None, an existing case, or the other half created now alongside this one.
  const [chainMode, setChainMode] = useState<'none' | 'existing' | 'new'>('none');
  const [otherAddress, setOtherAddress] = useState('');
  const clientKey = clients.map((c) => `${c.name.trim()}|${c.email.trim().toLowerCase()}`).join(';');
  useEffect(() => {
    if (track === 'REMORTGAGE') { setChainOptions([]); setChainMode('none'); return; }
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ side: track === 'SALE' ? 'buyer' : 'seller' });
      for (const c of clients) { if (c.name.trim()) qs.append('name', c.name.trim()); if (c.email.trim()) qs.append('email', c.email.trim().toLowerCase()); }
      api<{ candidates: ChainOption[] }>(`/matters/chain-candidates?${qs}`).then((r) => {
        setChainOptions(r.candidates);
        // The client's own case on the other side: suggested, not assumed.
        const same = r.candidates.filter((x) => x.sameClient);
        if (same.length === 1 && chainMode === 'none' && !linkTo) { setChainMode('existing'); setLinkTo(same[0].matterId); }
      }).catch(() => setChainOptions([]));
    }, 400);
    return () => clearTimeout(t);
  }, [track, clientKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [exchange, setExchange] = useState('');
  const [completion, setCompletion] = useState('');
  const [ref, setRef] = useState('');
  const [refTouched, setRefTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const address = composeAddress(addr);
  const setPart = (k: keyof AddrParts, v: string) => setAddr((a) => ({ ...a, [k]: v }));
  const weAre = track === 'SALE' ? 'Seller' : track === 'REMORTGAGE' ? 'Borrower' : 'Buyer';
  const theyAre = track === 'SALE' ? 'Buyer' : 'Seller';

  // ── what is wrong, per field, shown once the person has tried to create ──
  const problems: Record<string, string> = {};
  if (!addr.street.trim()) problems.street = 'The street is needed.';
  if (!UK_POSTCODE_RE.test(addr.postcode.trim())) problems.postcode = 'A UK postcode is needed.';
  if (!addr.town.trim()) problems.town = 'The town is needed.';
  if (track !== 'REMORTGAGE' && chainMode === 'new' && !/[A-Z]{1,2}\d/i.test(otherAddress)) problems.otherAddress = 'The other property\'s address, with its postcode, is needed.';
  if (track !== 'REMORTGAGE' && chainMode === 'existing' && !linkTo) problems.linkTo = `Choose the client\'s ${track === 'SALE' ? 'purchase' : 'sale'}, or pick Not With Us.`;
  clients.forEach((c, i) => {
    if (!c.name.trim()) problems[`c${i}name`] = 'Name needed.';
    if (!EMAIL_RE.test(c.email.trim())) problems[`c${i}email`] = 'A valid email is needed: the ID check, the forms and every update go here.';
    if (c.phone.trim() && !PHONE_RE.test(c.phone.trim())) problems[`c${i}phone`] = 'That does not look like a phone number.';
  });
  if (track !== 'REMORTGAGE' && sideKnown) {
    if (!firm.trim()) problems.firm = "The other side's firm is needed (or tick not yet instructed).";
    if (!EMAIL_RE.test(sideEmail.trim())) problems.sideEmail = 'A valid email is needed: the contract pack request and the chases go here.';
  }
  if (agentEmail.trim() && !EMAIL_RE.test(agentEmail.trim())) problems.agentEmail = 'That is not a valid email.';
  if (price.trim() && !/^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(price.trim())) problems.price = 'Pounds only, e.g. 325,000.';
  if (exchange && completion && completion < exchange) problems.completion = 'Completion cannot be before exchange.';
  const ok = Object.keys(problems).length === 0;
  const show = (k: string) => (tried && problems[k] ? <div style={S.err}>{problems[k]}</div> : null);

  const list = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  const ourNames = clients.map((c) => c.name.trim()).filter(Boolean);
  const derivedRef = matterRefFrom({ buyerNames: track === 'SALE' ? list(others) : ourNames, sellerNames: track === 'SALE' ? ourNames : list(others), propertyAddress: address });
  const shownRef = refTouched ? ref : derivedRef;

  const lookup = async () => {
    const pc = addr.postcode.trim();
    if (!UK_POSTCODE_RE.test(pc)) { setPcNote('Enter a UK postcode first.'); return; }
    setLooking(true); setPcNote(null); setFound(null);
    try {
      const r = await api<{ valid: boolean; reason?: string; postcode?: string; town?: string; county?: string; country?: string; addresses?: Found[] }>(`/address/lookup?postcode=${encodeURIComponent(pc)}`);
      if (!r.valid) { setPcNote(r.reason ?? 'Postcode not found.'); return; }
      setAddr((a) => ({ ...a, postcode: r.postcode ?? a.postcode, town: a.town || r.town || '', country: r.country && ['England', 'Wales', 'Scotland', 'Northern Ireland'].includes(r.country) ? r.country : a.country }));
      if (r.addresses?.length) setFound(r.addresses);
      else setPcNote(`Postcode found${r.town ? ` (${r.town})` : ''}: enter the house and street.`);
    } catch (e: unknown) {
      setPcNote(e instanceof Error ? e.message : 'Could not look that up.');
    } finally { setLooking(false); }
  };
  const pick = (f: Found) => {
    const m = f.line1.match(/^(\S+)\s+(.*)$/);
    setAddr((a) => ({ ...a, building: m && /\d/.test(m[1]) ? m[1] : f.line2 ? f.line1 : '', street: m && /\d/.test(m[1]) ? m[2] : f.line2 || f.line1, town: f.town || a.town, postcode: f.postcode }));
    setFound(null);
  };

  const create = async () => {
    setTried(true);
    if (!ok || busy) return;
    setBusy(true); setErr(null);
    try {
      const pennies = price.trim() ? Math.round(Number(price.replace(/,/g, '')) * 100) : undefined;
      const created = await api<{ id: string }>('/matters', {
        method: 'POST',
        body: JSON.stringify({
          matterRef: shownRef.trim() || fallbackMatterRef(),
          propertyAddress: address.trim(),
          track,
          addressParts: addr,
          purchasePricePennies: pennies,
          parties: clients.map((c) => ({ name: c.name.trim(), email: c.email.trim().toLowerCase(), phone: c.phone.trim() || undefined })),
          otherParties: list(others),
          otherSide: track !== 'REMORTGAGE' && sideKnown ? { firm: firm.trim(), contactName: sideName.trim() || undefined, email: sideEmail.trim().toLowerCase() } : null,
          agent: agentName.trim() ? { name: agentName.trim(), email: agentEmail.trim() ? agentEmail.trim().toLowerCase() : undefined } : null,
          lender: mortgaged || track === 'REMORTGAGE' ? lender.trim() || undefined : undefined,
          funding: track === 'SALE' ? { hasExistingMortgage: mortgaged } : track === 'REMORTGAGE' ? { hasLender: true, hasExistingMortgage: true } : { hasLender: mortgaged },
          exchangeTargetDate: exchange || undefined,
          completionTargetDate: completion || undefined,
          linkedMatterId: track !== 'REMORTGAGE' && chainMode === 'existing' && linkTo ? linkTo : undefined,
        }),
      });
      // The client's other half, set up now for the same clients and linked to this one.
      if (track !== 'REMORTGAGE' && chainMode === 'new' && otherAddress.trim()) {
        await api('/matters', {
          method: 'POST',
          body: JSON.stringify({
            matterRef: `${(shownRef.trim() || fallbackMatterRef())}-${track === 'SALE' ? 'P' : 'S'}`,
            propertyAddress: otherAddress.trim(),
            track: track === 'SALE' ? 'PURCHASE' : 'SALE',
            parties: clients.map((c) => ({ name: c.name.trim(), email: c.email.trim().toLowerCase(), phone: c.phone.trim() || undefined })),
            completionTargetDate: completion || undefined,
            exchangeTargetDate: exchange || undefined,
            linkedMatterId: created.id,
          }),
        });
      }
      onCreated(created.id);
    } catch (e: any) {
      setErr(e?.message?.includes('graph') || e?.message?.toLowerCase?.().includes('token')
        ? 'Creating a case provisions its OneDrive folder, so you need Outlook connected first (open the CONVEYi add-in once to connect).'
        : (e?.message || 'Could not create the case.'));
    } finally { setBusy(false); }
  };

  const person = (c: Person, i: number) => (
    <div key={i} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div style={{ flex: '2 1 160px', minWidth: 0 }}><label style={S.lbl}>{weAre}{clients.length > 1 ? ` ${i + 1}` : ''} name *</label><input value={c.name} autoComplete="off" onChange={(e) => setClients((cs) => cs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Full name" style={S.input} />{show(`c${i}name`)}</div>
      <div style={{ flex: '2 1 180px', minWidth: 0 }}><label style={S.lbl}>Email *</label><input type="email" inputMode="email" value={c.email} onChange={(e) => setClients((cs) => cs.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} placeholder="name@example.com" style={S.input} />{show(`c${i}email`)}</div>
      <div style={{ flex: '1 1 130px', minWidth: 0 }}><label style={S.lbl}>Mobile</label><input type="tel" inputMode="tel" value={c.phone} onChange={(e) => setClients((cs) => cs.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))} placeholder="07…" style={S.input} />{show(`c${i}phone`)}</div>
      {clients.length > 1 && <button type="button" onClick={() => setClients((cs) => cs.filter((_, j) => j !== i))} style={{ ...S.x, marginTop: 24 }} aria-label="Remove"><X size={12} /></button>}
    </div>
  );

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.card} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <strong style={{ fontSize: 16, color: '#0f172a', flex: 1 }}>New Case</strong>
          <button onClick={onClose} style={S.x} aria-label="Close"><X size={14} /></button>
        </div>

        <div style={S.sec}>Property</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 130px', minWidth: 0 }}>
            <label style={S.lbl}>Postcode *</label>
            <input autoFocus value={addr.postcode} autoComplete="postal-code" onChange={(e) => { setPart('postcode', e.target.value.toUpperCase()); setFound(null); setPcNote(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void lookup(); } }} placeholder="LS1 2AB" style={S.input} />
            {show('postcode')}
          </div>
          <button type="button" onClick={() => void lookup()} disabled={looking} style={{ ...S.btn, marginBottom: 1 }}>{looking ? 'Looking…' : 'Find Address'}</button>
          <div style={{ flex: '1 1 120px', minWidth: 0 }}>
            <label style={S.lbl}>Country</label>
            <select value={addr.country} onChange={(e) => setPart('country', e.target.value)} style={S.input}>
              {['England', 'Wales', 'Scotland', 'Northern Ireland'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        {pcNote && <div style={S.note}>{pcNote}</div>}
        {found && (
          <div style={S.list} role="listbox" aria-label="Addresses at this postcode">
            {found.map((f, i) => <button key={i} type="button" onClick={() => pick(f)} style={S.item}>{f.label}</button>)}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 110px', minWidth: 0 }}>
            <label style={S.lbl}>House name / number</label>
            <input value={addr.building} onChange={(e) => setPart('building', e.target.value)} placeholder="14" style={S.input} />
          </div>
          <div style={{ flex: '2 1 200px', minWidth: 0 }}>
            <label style={S.lbl}>Street *</label>
            <input value={addr.street} autoComplete="address-line1" onChange={(e) => setPart('street', e.target.value)} placeholder="Oak Street" style={S.input} />
            {show('street')}
          </div>
          <div style={{ flex: '1 1 140px', minWidth: 0 }}>
            <label style={S.lbl}>Town / city *</label>
            <input value={addr.town} autoComplete="address-level2" onChange={(e) => setPart('town', e.target.value)} placeholder="Leeds" style={S.input} />
            {show('town')}
          </div>
        </div>

        <div style={S.sec}>Transaction</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '2 1 200px', minWidth: 0 }}>
            <label style={S.lbl}>Acting for</label>
            <select value={track} onChange={(e) => setTrack(e.target.value)} style={S.input}>{TRACKS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </div>
          <div style={{ flex: '1 1 130px', minWidth: 0 }}>
            <label style={S.lbl}>Price (£)</label>
            <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="325,000" style={S.input} />
            {show('price')}
          </div>
          <div style={{ flex: '1 1 130px', minWidth: 0 }}>
            <label style={S.lbl}>Case ref</label>
            <input value={shownRef} onChange={(e) => { setRef(e.target.value); setRefTouched(true); }} placeholder="auto" style={S.input} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 150px', minWidth: 0 }}><label style={S.lbl}>Exchange target</label><input type="date" value={exchange} onChange={(e) => setExchange(e.target.value)} style={S.input} /></div>
          <div style={{ flex: '1 1 150px', minWidth: 0 }}><label style={S.lbl}>Completion target</label><input type="date" value={completion} min={exchange || undefined} onChange={(e) => setCompletion(e.target.value)} style={S.input} />{show('completion')}</div>
        </div>

        <div style={S.sec}>{weAre}{clients.length > 1 ? 's' : ''} (our client{clients.length > 1 ? 's' : ''})</div>
        {clients.map(person)}
        <button type="button" onClick={() => setClients((cs) => [...cs, blank()])} style={{ ...S.link, marginTop: 6 }}>+ Add another {weAre.toLowerCase()}</button>
        {/* How the clients fund it sits with them: a mortgage or cash on a purchase, a mortgage to pay off on a sale. It shapes the case's flow. */}
        <div style={{ marginTop: 12 }}>
          {track !== 'REMORTGAGE' && (
            <div role="group" aria-label={track === 'SALE' ? 'Existing mortgage' : 'Funding'} style={{ display: 'inline-flex', border: '1px solid #cbd5e1', borderRadius: 8, overflow: 'hidden', marginBottom: 8 }}>
              {([[true, track === 'SALE' ? 'Mortgage To Pay Off' : 'Mortgage'], [false, track === 'SALE' ? 'No Mortgage' : 'Cash Purchase']] as const).map(([v, l], n) => (
                <button key={l} type="button" aria-pressed={mortgaged === v} onClick={() => setMortgaged(v)} style={{ border: 0, borderLeft: n ? '1px solid #e2e8f0' : 0, background: mortgaged === v ? '#5A27E0' : '#fff', color: mortgaged === v ? '#fff' : '#334155', padding: '6px 12px', font: 'inherit', fontSize: 12.5, cursor: 'pointer' }}>{l}</button>
              ))}
            </div>
          )}
          {(mortgaged || track === 'REMORTGAGE') && (
            <div style={{ maxWidth: 360 }}>
              <label style={S.lbl}>{track === 'SALE' ? 'Current lender' : track === 'REMORTGAGE' ? 'New lender' : 'Lender (if known)'}</label>
              <LenderPicker api={api} value={lender} onChange={setLender} inputStyle={S.input} />
            </div>
          )}
        </div>

        {track !== 'REMORTGAGE' && (
          <>
            <div style={S.sec}>Client's {track === 'SALE' ? 'Purchase' : 'Sale'}</div>
            <div style={{ display: 'inline-flex', border: '1px solid #cbd5e1', borderRadius: 8, overflow: 'hidden', alignSelf: 'flex-start' }} role="group" aria-label={`Client's ${track === 'SALE' ? 'purchase' : 'sale'}`}>
              {([['none', 'Not With Us'], ['existing', 'Already A Case'], ['new', 'Create It Now']] as const).map(([v, l], n) => (
                <button key={v} type="button" onClick={() => setChainMode(v)} style={{ border: 0, borderLeft: n ? '1px solid #e2e8f0' : 0, background: chainMode === v ? '#5A27E0' : '#fff', color: chainMode === v ? '#fff' : '#334155', padding: '6px 12px', font: 'inherit', fontSize: 12.5, cursor: 'pointer' }}>{l}</button>
              ))}
            </div>
            {chainMode === 'existing' && <ChainPicker options={chainOptions} value={linkTo} onChange={setLinkTo} want={track === 'SALE' ? 'purchase' : 'sale'} />}
            {chainMode === 'existing' && show('linkTo')}
            {chainMode === 'new' && <div><label style={S.lbl}>Address of the {track === 'SALE' ? 'property they are buying' : 'property they are selling'}</label><input value={otherAddress} onChange={(e) => setOtherAddress(e.target.value)} placeholder="Full address with postcode" style={S.input} />{show('otherAddress')}</div>}
          </>
        )}
        {track !== 'REMORTGAGE' && (
          <>
            <div style={S.sec}>Other Side</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ flex: '2 1 220px', minWidth: 0 }}>
                <label style={S.lbl}>{theyAre}(s)</label>
                <input value={others} onChange={(e) => setOthers(e.target.value)} placeholder="Names, comma-separated" style={S.input} />
              </div>
            </div>
            <label style={{ ...S.lbl, display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}><input type="checkbox" checked={!sideKnown} onChange={(e) => setSideKnown(!e.target.checked)} /> Their solicitor is not yet instructed</label>
            {sideKnown && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ flex: '2 1 160px', minWidth: 0 }}><label style={S.lbl}>Their solicitor's firm *</label><input value={firm} onChange={(e) => setFirm(e.target.value)} placeholder="Delaney & Webb" style={S.input} />{show('firm')}</div>
                <div style={{ flex: '1 1 140px', minWidth: 0 }}><label style={S.lbl}>Contact</label><input value={sideName} onChange={(e) => setSideName(e.target.value)} placeholder="Chloe Patel" style={S.input} /></div>
                <div style={{ flex: '2 1 180px', minWidth: 0 }}><label style={S.lbl}>Email *</label><input type="email" inputMode="email" value={sideEmail} onChange={(e) => setSideEmail(e.target.value)} placeholder="conveyancing@firm.co.uk" style={S.input} />{show('sideEmail')}</div>
              </div>
            )}
          </>
        )}

        <div style={S.sec}>Estate Agent</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 140px', minWidth: 0 }}><label style={S.lbl}>Estate agent</label><input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Hunters" style={S.input} /></div>
          <div style={{ flex: '2 1 180px', minWidth: 0 }}><label style={S.lbl}>Agent email</label><input type="email" inputMode="email" value={agentEmail} onChange={(e) => setAgentEmail(e.target.value)} placeholder="sales@agent.co.uk" style={S.input} />{show('agentEmail')}</div>
        </div>

        {err && <div style={{ fontSize: 12, color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 10px', margin: '10px 0 0' }}>{err}</div>}
        {tried && !ok && !err && <div style={{ fontSize: 12, color: '#b91c1c', margin: '10px 0 0' }}>Fix the fields marked above.</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button onClick={() => void create()} disabled={busy} style={{ ...S.btn, background: '#5A27E0', color: '#fff', border: 'none', opacity: busy ? 0.5 : 1 }}>{busy ? 'Creating…' : 'Create Case'}</button>
          <button onClick={onClose} style={S.btn}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,15,30,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 12 },
  card: { background: '#fff', borderRadius: 14, padding: 16, width: '100%', maxWidth: 620, maxHeight: '92vh', overflowY: 'auto', boxSizing: 'border-box', boxShadow: '0 14px 44px rgba(0,0,0,0.3)' },
  x: { width: 26, height: 26, border: 'none', background: '#f1f5f9', borderRadius: 8, cursor: 'pointer', color: '#64748b', fontSize: 12, flexShrink: 0 },
  sec: { fontSize: 11, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase', color: '#5A27E0', margin: '16px 0 0', paddingBottom: 4, borderBottom: '1px solid #eef1f5' },
  lbl: { display: 'block', fontSize: 11, fontWeight: 700, color: '#64748b', margin: '10px 0 3px' },
  input: { width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '7px 9px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#0f172a' },
  err: { fontSize: 11.5, color: '#b91c1c', marginTop: 3 },
  note: { fontSize: 12, color: '#475569', marginTop: 6 },
  list: { display: 'grid', gap: 2, marginTop: 6, maxHeight: 180, overflowY: 'auto', border: '1px solid #e6e8ee', borderRadius: 8, padding: 4 },
  item: { textAlign: 'left', border: 0, background: '#fff', padding: '6px 8px', borderRadius: 6, fontSize: 12.5, cursor: 'pointer', color: '#0f172a', fontFamily: 'inherit' },
  link: { border: 0, background: 'none', color: '#5A27E0', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', padding: 0, fontFamily: 'inherit' },
  btn: { fontSize: 13, fontWeight: 700, padding: '8px 16px', borderRadius: 8, border: '1px solid #d0d5dd', background: '#fff', color: '#334155', cursor: 'pointer', fontFamily: 'inherit' },
};
