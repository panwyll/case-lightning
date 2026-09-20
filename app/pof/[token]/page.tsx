'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';

/**
 * The client's proof-of-funds form (docs/proof-of-funds.md). Public, tokenised, no login.
 * One block per source of money, evidence attached per block, three declarations, submit.
 * Everything the form says about what to attach comes from the same catalogue the rules
 * use, so the client is asked for exactly what the conveyancer will look for.
 */
const KINDS: Array<{ id: string; label: string; evidence: string; gift?: boolean; overseas?: boolean }> = [
  { id: 'savings', label: 'Savings', evidence: 'Bank statements for the last 3 months for each account the money is in, showing the balance building up.' },
  { id: 'sale_proceeds', label: 'Proceeds of a property sale', evidence: 'The memorandum of sale or completion statement for the property you are selling.' },
  { id: 'mortgage', label: 'Mortgage advance', evidence: 'Your mortgage offer or decision in principle.' },
  { id: 'gift', label: 'A gift', evidence: 'A signed letter from the person giving it (saying it is a gift, not a loan, and they will have no share in the property), their photo ID, and their bank statements showing the money.', gift: true },
  { id: 'inheritance', label: 'Inheritance', evidence: 'The grant of probate or a letter from the estate\'s solicitor, and the statement showing the money arriving.' },
  { id: 'investment_sale', label: 'Sale of shares or investments', evidence: 'A statement from the platform or broker showing the sale and the transfer to your bank.' },
  { id: 'pension', label: 'Pension lump sum', evidence: 'Your pension provider\'s letter and the statement showing receipt.' },
  { id: 'remortgage_equity', label: 'Equity release / remortgage', evidence: 'The new lender\'s offer and the completion statement.' },
  { id: 'help_to_buy_isa', label: 'Help to Buy ISA', evidence: 'Your ISA statement.' },
  { id: 'lifetime_isa', label: 'Lifetime ISA', evidence: 'Your LISA statement.' },
  { id: 'loan', label: 'A loan (family, employer, other)', evidence: 'The loan agreement and evidence of the lender\'s funds. Your mortgage lender will need to know.' },
  { id: 'business_income', label: 'Business income / dividends', evidence: 'Business bank statements and the latest accounts or dividend vouchers.' },
  { id: 'crypto', label: 'Cryptoassets', evidence: 'Exchange statements showing the purchases, the sale to pounds and the transfer to your bank.' },
  { id: 'overseas', label: 'Money from overseas', evidence: 'Statements from the overseas account, evidence of the transfer, and how the money was earned.', overseas: true },
  { id: 'other', label: 'Something else', evidence: 'Whatever shows where the money came from and that it is now yours.' },
];

interface Source {
  kind: string;
  amount: string;
  description: string;
  bankName: string;
  accountHolder: string;
  files: Array<{ id: string; fileName: string }>;
  gift: { donorName: string; donorRelationship: string; donorAddress: string; repayable: boolean; donorAbroad: boolean; files: Array<{ id: string; fileName: string }> };
  overseas: { country: string; alreadyInUk: boolean };
}
const blank = (kind = 'savings'): Source => ({ kind, amount: '', description: '', bankName: '', accountHolder: '', files: [], gift: { donorName: '', donorRelationship: '', donorAddress: '', repayable: false, donorAbroad: false, files: [] }, overseas: { country: '', alreadyInUk: true } });
const pennies = (s: string): number => Math.round(Number(String(s).replace(/[^0-9.]/g, '') || 0) * 100);
const gbp = (p: number) => `£${(p / 100).toLocaleString('en-GB')}`;

const CSS = `
.pf{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;background:#f6f7fb;min-height:100vh;padding:24px 16px 60px}
.pf .wrap{max-width:760px;margin:0 auto}
.pf h1{font-size:22px;margin:0 0 4px}
.pf .sub{color:#64748b;font-size:14px;margin:0 0 18px}
.pf .card{background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:16px;margin-bottom:12px}
.pf label{display:block;font-size:12.5px;font-weight:600;color:#334155;margin:10px 0 4px}
.pf input[type=text],.pf input[type=email],.pf input[type=tel],.pf select,.pf textarea{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:9px 10px;font-size:14px;font-family:inherit;background:#fff}
.pf textarea{min-height:64px}
.pf .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media (max-width:560px){.pf .row{grid-template-columns:1fr}}
.pf .hint{font-size:12px;color:#64748b;margin-top:4px}
.pf .btn{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:8px 12px;font-size:13.5px;cursor:pointer;font-family:inherit}
.pf .btn.primary{background:#5A27E0;color:#fff;border-color:#5A27E0}
.pf .btn:disabled{opacity:.5;cursor:not-allowed}
.pf .chk{display:flex;gap:8px;align-items:flex-start;font-size:13.5px;margin:8px 0}
.pf .chk input{margin-top:3px}
.pf .files{font-size:12.5px;color:#334155;margin-top:6px}
.pf .err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:8px;padding:10px;font-size:13px;margin:10px 0}
.pf .ok{background:#f0fdf4;border:1px solid #86efac;color:#14532d;border-radius:10px;padding:16px;font-size:14px}
.pf .tot{display:flex;justify-content:space-between;font-size:13.5px;padding:6px 0;border-top:1px solid #f1f5f9}
`;

export default function ProofOfFundsPage() {
  const { token } = useParams<{ token: string }>();
  const [ctx, setCtx] = useState<{ status: string; firmName?: string; propertyAddress?: string; firstName?: string | null; fullName?: string | null; purchasePricePennies?: number | null; hasLender?: boolean | null; noteToClient?: string | null; followUp?: boolean } | null>(null);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [price, setPrice] = useState('');
  const [mortgage, setMortgage] = useState('');
  const [sources, setSources] = useState<Source[]>([blank('savings')]);
  const [dec, setDec] = useState({ accurate: false, noThirdPartyInterest: false, noUndisclosedBorrowing: false });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<null | { flagged: number }>(null);

  useEffect(() => {
    fetch(`/api/v1/pof/${token}`).then(async (r) => {
      const j = await r.json();
      setCtx(r.ok ? j : { status: 'unknown' });
      if (r.ok) {
        if (j.fullName) setFullName(j.fullName);
        if (j.purchasePricePennies) setPrice(String(j.purchasePricePennies / 100));
        if (j.hasLender) setSources([blank('mortgage'), blank('savings')]);
      }
    }).catch(() => setCtx({ status: 'unknown' }));
  }, [token]);

  const upload = useCallback(async (file: File) => {
    const buf = await file.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const r = await fetch(`/api/v1/pof/${token}/upload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: file.name, mimeType: file.type || 'application/pdf', base64: btoa(bin) }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? 'Upload failed');
    return { id: j.id as string, fileName: j.fileName as string };
  }, [token]);

  const attach = async (i: number, files: FileList | null, donor = false) => {
    if (!files?.length) return;
    setBusy(true);
    setErr(null);
    try {
      const added: Array<{ id: string; fileName: string }> = [];
      for (const f of Array.from(files)) added.push(await upload(f));
      setSources((ss) => ss.map((s, k) => (k !== i ? s : donor ? { ...s, gift: { ...s.gift, files: [...s.gift.files, ...added] } } : { ...s, files: [...s.files, ...added] })));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const nonMortgage = useMemo(() => sources.filter((s) => s.kind !== 'mortgage').reduce((n, s) => n + pennies(s.amount), 0), [sources]);
  const mortgageP = useMemo(() => (mortgage ? pennies(mortgage) : sources.filter((s) => s.kind === 'mortgage').reduce((n, s) => n + pennies(s.amount), 0)), [mortgage, sources]);
  const priceP = pennies(price);
  const required = priceP ? Math.max(0, priceP - mortgageP) : null;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        declarant: { fullName: fullName.trim(), email: email.trim() || null, phone: phone.trim() || null },
        purchasePricePennies: priceP || null,
        mortgageAdvancePennies: mortgage ? pennies(mortgage) : null,
        sources: sources.map((s) => ({
          kind: s.kind,
          amountPennies: pennies(s.amount),
          description: s.description.trim() || `${KINDS.find((k) => k.id === s.kind)?.label ?? s.kind}`,
          bankName: s.bankName.trim() || null,
          accountHolder: s.accountHolder.trim() || null,
          evidenceDocumentIds: s.files.map((f) => f.id),
          gift: s.kind === 'gift' ? { donorName: s.gift.donorName.trim(), donorRelationship: s.gift.donorRelationship.trim(), donorAddress: s.gift.donorAddress.trim() || null, repayable: s.gift.repayable, donorAbroad: s.gift.donorAbroad, donorEvidenceDocumentIds: s.gift.files.map((f) => f.id) } : null,
          overseas: s.kind === 'overseas' ? { country: s.overseas.country.trim(), alreadyInUk: s.overseas.alreadyInUk } : null,
        })),
        declarations: dec,
        clientNote: note.trim() || null,
      };
      const r = await fetch(`/api/v1/pof/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'Could not submit');
      setDone({ flagged: j.flagged ?? 0 });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not submit');
    } finally {
      setBusy(false);
    }
  };

  if (!ctx) return <div className="pf"><style>{CSS}</style><div className="wrap">Loading…</div></div>;
  if (ctx.status === 'unknown') return <div className="pf"><style>{CSS}</style><div className="wrap"><div className="card">This link is not valid. Please ask your conveyancer for a new one.</div></div></div>;
  if (ctx.status === 'submitted' || done) {
    return (
      <div className="pf"><style>{CSS}</style><div className="wrap">
        <h1>Thank you{ctx.firstName ? `, ${ctx.firstName}` : ''}</h1>
        <div className="ok">Your proof-of-funds form for {ctx.propertyAddress} has been received by {ctx.firmName}. Your conveyancer will review it and come back to you if anything more is needed. You can close this page.</div>
      </div></div>
    );
  }
  if (ctx.status !== 'requested') return <div className="pf"><style>{CSS}</style><div className="wrap"><div className="card">This link has expired. Please ask {ctx.firmName ?? 'your conveyancer'} for a new one.</div></div></div>;

  const canSubmit = fullName.trim().length > 1 && sources.length > 0 && sources.every((s) => pennies(s.amount) > 0 && (s.kind !== 'gift' || (s.gift.donorName.trim() && s.gift.donorRelationship.trim())) && (s.kind !== 'overseas' || s.overseas.country.trim())) && dec.accurate && dec.noThirdPartyInterest && dec.noUndisclosedBorrowing;

  return (
    <div className="pf"><style>{CSS}</style><div className="wrap">
      <h1>Proof of funds — {ctx.propertyAddress}</h1>
      <p className="sub">{ctx.firmName} must verify where the money for your purchase is coming from before contracts can be exchanged. This is a legal requirement on every purchase. It takes about ten minutes; you can attach photos or PDFs from your phone.</p>
      {ctx.followUp && ctx.noteToClient && <div className="card" style={{ borderColor: '#fde68a', background: '#fffbeb' }}><b>Your conveyancer asked for a little more:</b><div style={{ marginTop: 6, whiteSpace: 'pre-wrap', fontSize: 14 }}>{ctx.noteToClient}</div></div>}

      <div className="card">
        <b>About you</b>
        <label htmlFor="pf-name">Your full name</label><input id="pf-name" type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <div className="row">
          <div><label htmlFor="pf-email">Email</label><input id="pf-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div><label htmlFor="pf-phone">Phone</label><input id="pf-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
        </div>
        <div className="row">
          <div><label htmlFor="pf-price">Purchase price (£)</label><input id="pf-price" type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 325000" /></div>
          <div><label htmlFor="pf-mortgage">Mortgage advance, if any (£)</label><input id="pf-mortgage" type="text" inputMode="decimal" value={mortgage} onChange={(e) => setMortgage(e.target.value)} placeholder="from your offer" /></div>
        </div>
      </div>

      {sources.map((s, i) => {
        const k = KINDS.find((x) => x.id === s.kind)!;
        return (
          <div className="card" key={i}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <b>Where the money comes from — part {i + 1}</b>
              {sources.length > 1 && <button className="btn" onClick={() => setSources((ss) => ss.filter((_, k2) => k2 !== i))}>Remove</button>}
            </div>
            <div className="row">
              <div><label htmlFor={`pf-kind-${i}`}>Type</label>
                <select id={`pf-kind-${i}`} value={s.kind} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, kind: e.target.value } : x)))}>{KINDS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></div>
              <div><label htmlFor={`pf-amt-${i}`}>Amount (£)</label><input id={`pf-amt-${i}`} type="text" inputMode="decimal" value={s.amount} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, amount: e.target.value } : x)))} /></div>
            </div>
            <label htmlFor={`pf-desc-${i}`}>Tell us about it</label>
            <textarea id={`pf-desc-${i}`} value={s.description} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, description: e.target.value } : x)))} placeholder={s.kind === 'savings' ? 'e.g. Saved from salary over 6 years in my Nationwide account' : s.kind === 'sale_proceeds' ? 'e.g. Sale of 12 Elm Road, completing the same day' : 'In your own words'} />
            {s.kind !== 'gift' && s.kind !== 'mortgage' && (
              <div className="row">
                <div><label htmlFor={`pf-bank-${i}`}>Bank / provider</label><input id={`pf-bank-${i}`} type="text" value={s.bankName} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, bankName: e.target.value } : x)))} /></div>
                <div><label htmlFor={`pf-holder-${i}`}>Account holder</label><input id={`pf-holder-${i}`} type="text" value={s.accountHolder} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, accountHolder: e.target.value } : x)))} /></div>
              </div>
            )}
            {k.gift && (
              <div style={{ marginTop: 6, padding: 10, background: '#f8fafc', borderRadius: 8 }}>
                <div className="row">
                  <div><label htmlFor={`pf-donor-${i}`}>Who is giving it</label><input id={`pf-donor-${i}`} type="text" value={s.gift.donorName} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, gift: { ...x.gift, donorName: e.target.value } } : x)))} /></div>
                  <div><label htmlFor={`pf-rel-${i}`}>Their relationship to you</label><input id={`pf-rel-${i}`} type="text" value={s.gift.donorRelationship} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, gift: { ...x.gift, donorRelationship: e.target.value } } : x)))} placeholder="e.g. mother" /></div>
                </div>
                <label htmlFor={`pf-daddr-${i}`}>Their address</label><input id={`pf-daddr-${i}`} type="text" value={s.gift.donorAddress} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, gift: { ...x.gift, donorAddress: e.target.value } } : x)))} />
                <div className="chk"><input id={`pf-repay-${i}`} type="checkbox" checked={s.gift.repayable} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, gift: { ...x.gift, repayable: e.target.checked } } : x)))} /><label htmlFor={`pf-repay-${i}`} style={{ margin: 0, fontWeight: 400 }}>I will have to pay this money back</label></div>
                <div className="chk"><input id={`pf-abroad-${i}`} type="checkbox" checked={s.gift.donorAbroad} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, gift: { ...x.gift, donorAbroad: e.target.checked } } : x)))} /><label htmlFor={`pf-abroad-${i}`} style={{ margin: 0, fontWeight: 400 }}>They live outside the UK</label></div>
                <label>Documents from the person giving it (ID, gift letter, their statements)</label>
                <input type="file" multiple accept="application/pdf,image/*" onChange={(e) => void attach(i, e.target.files, true)} disabled={busy} />
                {s.gift.files.length > 0 && <div className="files">Attached: {s.gift.files.map((f) => f.fileName).join(', ')}</div>}
              </div>
            )}
            {k.overseas && (
              <div className="row">
                <div><label htmlFor={`pf-country-${i}`}>Country the money is in / came from</label><input id={`pf-country-${i}`} type="text" value={s.overseas.country} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, overseas: { ...x.overseas, country: e.target.value } } : x)))} /></div>
                <div className="chk" style={{ marginTop: 28 }}><input id={`pf-inuk-${i}`} type="checkbox" checked={s.overseas.alreadyInUk} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, overseas: { ...x.overseas, alreadyInUk: e.target.checked } } : x)))} /><label htmlFor={`pf-inuk-${i}`} style={{ margin: 0, fontWeight: 400 }}>It is already in a UK bank account</label></div>
              </div>
            )}
            <label>{k.gift ? 'Your own statement showing the gift arriving (optional)' : 'Attach evidence'}</label>
            <div className="hint">{k.gift ? 'A statement for the account the gift was (or will be) paid into.' : k.evidence}</div>
            <input type="file" multiple accept="application/pdf,image/*" onChange={(e) => void attach(i, e.target.files)} disabled={busy} style={{ marginTop: 6 }} />
            {s.files.length > 0 && <div className="files">Attached: {s.files.map((f) => f.fileName).join(', ')}</div>}
          </div>
        );
      })}
      <button className="btn" onClick={() => setSources((ss) => [...ss, blank()])}>+ Add another source of money</button>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="tot"><span>Purchase price</span><b>{priceP ? gbp(priceP) : '—'}</b></div>
        <div className="tot"><span>Mortgage advance</span><b>{mortgageP ? gbp(mortgageP) : '—'}</b></div>
        <div className="tot"><span>You need to find</span><b>{required != null ? gbp(required) : '—'}</b></div>
        <div className="tot"><span>You have declared (excluding mortgage)</span><b style={{ color: required != null && nonMortgage < required ? '#b91c1c' : '#14532d' }}>{gbp(nonMortgage)}</b></div>
        {required != null && nonMortgage < required && <div className="hint">This is {gbp(required - nonMortgage)} short of what is needed. You can still submit; your conveyancer will ask about the difference.</div>}
      </div>

      <div className="card">
        <b>Declarations</b>
        <div className="chk"><input id="pf-d1" type="checkbox" checked={dec.accurate} onChange={(e) => setDec({ ...dec, accurate: e.target.checked })} /><label htmlFor="pf-d1" style={{ margin: 0, fontWeight: 400 }}>The information I have given is complete and accurate.</label></div>
        <div className="chk"><input id="pf-d2" type="checkbox" checked={dec.noThirdPartyInterest} onChange={(e) => setDec({ ...dec, noThirdPartyInterest: e.target.checked })} /><label htmlFor="pf-d2" style={{ margin: 0, fontWeight: 400 }}>No one else has an interest in this money or will have an interest in the property, except as I have stated.</label></div>
        <div className="chk"><input id="pf-d3" type="checkbox" checked={dec.noUndisclosedBorrowing} onChange={(e) => setDec({ ...dec, noUndisclosedBorrowing: e.target.checked })} /><label htmlFor="pf-d3" style={{ margin: 0, fontWeight: 400 }}>None of this money is borrowed, except as I have stated.</label></div>
        <label htmlFor="pf-note">Anything else your conveyancer should know (optional)</label>
        <textarea id="pf-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      {err && <div className="err">{err}</div>}
      <button className="btn primary" disabled={busy || !canSubmit} onClick={() => void submit()} style={{ padding: '11px 18px', fontSize: 15 }}>Submit to {ctx.firmName}</button>
      <div className="hint" style={{ marginTop: 8 }}>Your answers and documents go only to {ctx.firmName} and are stored on your file. This link stops working once you have submitted.</div>
    </div></div>
  );
}
