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
  { id: 'business_income', label: 'Business income', evidence: 'Business bank statements and the latest accounts.' },
  { id: 'dividend', label: 'A dividend from my own company', evidence: 'The dividend voucher, the board minute declaring it, the company\'s latest filed accounts, and the statement showing it paid to you.' },
  { id: 'directors_loan', label: 'A loan from my company (director\'s loan)', evidence: 'The director\'s loan account or loan agreement, and the company statement showing the payment. Your mortgage lender will need to know.' },
  { id: 'drawings', label: 'Sole trader or partnership drawings', evidence: 'Business bank statements and your latest tax calculation (SA302) or accounts.' },
  { id: 'bonus', label: 'Bonus, commission or redundancy pay', evidence: 'The payslip showing it, or the settlement agreement for redundancy, and the statement showing it paid in.' },
  { id: 'bridging_loan', label: 'A bridging loan', evidence: 'The bridging lender\'s offer and how it will be repaid. Your mortgage lender will need to agree.' },
  { id: 'cash', label: 'Cash', evidence: 'We cannot take cash. Pay it into your own bank account first, and tell us where it came from.' },
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
  jointHolderName: string; gift: { donorName: string; donorRelationship: string; donorAddress: string; repayable: boolean; donorAbroad: boolean; jointDonorName: string; files: Array<{ id: string; fileName: string }> };
  overseas: { country: string; alreadyInUk: boolean };
  owner: string;
  notYetReceived: boolean;
  giftMore: { donorCountry: string; expectsShare: boolean; willLiveThere: boolean; via: string; forBuyer: string };
}
const blank = (kind = 'savings'): Source => ({ kind, amount: '', description: '', bankName: '', accountHolder: '', jointHolderName: '', files: [], gift: { donorName: '', donorRelationship: '', donorAddress: '', repayable: false, donorAbroad: false, jointDonorName: '', files: [] }, overseas: { country: '', alreadyInUk: true }, owner: '', notYetReceived: false, giftMore: { donorCountry: '', expectsShare: false, willLiveThere: false, via: '', forBuyer: '' } });
/** Money that may still be on its way when the form is filled in. */
const LATER = new Set(['inheritance', 'investment_sale', 'pension', 'remortgage_equity', 'sale_proceeds', 'bonus', 'bridging_loan']);
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
.pf .ob-veil{position:fixed;inset:0;background:rgba(15,23,42,.4);display:flex;align-items:flex-start;justify-content:center;padding:60px 16px;z-index:50}
.pf .ob-dlg{background:#fff;border-radius:14px;width:100%;max-width:460px;padding:18px;display:grid;gap:10px;box-shadow:0 24px 64px rgba(15,23,42,.24)}
.pf .ob-dlg h2{margin:0;font-size:17px}
.pf .ob-list{display:grid;gap:4px;max-height:320px;overflow-y:auto}
.pf .ob-bank{display:flex;align-items:center;gap:10px;border:1px solid #e2e8f0;background:#fff;border-radius:10px;padding:10px 12px;font-size:14px;font-family:inherit;text-align:left;cursor:pointer}
.pf .ob-bank:hover{border-color:#5A27E0;background:#f5f3ff}
.pf .ob-bank img,.pf .ob-logo{width:24px;height:24px;border-radius:6px;object-fit:contain;background:#f1f5f9;flex:none}
.pf .tot{display:flex;justify-content:space-between;font-size:13.5px;padding:6px 0;border-top:1px solid #f1f5f9}
`;

export default function ProofOfFundsPage() {
  const { token } = useParams<{ token: string }>();
  type Query = { id: string; question: string; transaction: { date: string; description: string; amountPennies: number } | null };
  const [ctx, setCtx] = useState<{ status: string; firmName?: string; propertyAddress?: string; firstName?: string | null; fullName?: string | null; coBuyers?: string[]; purchasePricePennies?: number | null; hasLender?: boolean | null; noteToClient?: string | null; followUp?: boolean; round?: number; queries?: Query[]; previous?: { purchasePricePennies: number | null; mortgageAdvancePennies: number | null; sources: Array<{ kind: string; amountPennies: number; description: string; gift: Source['gift'] extends infer G ? (G & { donorEvidenceDocumentIds?: string[] }) | null : never; overseas: { country: string; alreadyInUk: boolean } | null }> } | null } | null>(null);
  const [answers, setAnswers] = useState<Record<string, { answer: string; files: Array<{ id: string; fileName: string }> }>>({});
  const [fullName, setFullName] = useState('');
  const [coDeclarants, setCoDeclarants] = useState<string[]>([]);
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
  // Open banking: connect a bank for one source (the client's account, or the donor's for a gift).
  const [obAvailable, setObAvailable] = useState(false);
  const [bankFor, setBankFor] = useState<{ i: number; party: 'client' | 'donor' } | null>(null);
  const [bankQ, setBankQ] = useState('');
  const [banks, setBanks] = useState<Array<{ id: string; name: string; logo: string | null }>>([]);
  const [obMsg, setObMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const draftKey = `pof-draft:${token}`;

  useEffect(() => {
    fetch(`/api/v1/pof/${token}`).then(async (r) => {
      const j = await r.json();
      setCtx(r.ok ? j : { status: 'unknown' });
      if (r.ok) {
        if (j.fullName) setFullName(j.fullName);
        if (j.purchasePricePennies) setPrice(String(j.purchasePricePennies / 100));
        if (j.hasLender) setSources([blank('mortgage'), blank('savings')]);
        if (j.previous) {
          if (j.previous.purchasePricePennies) setPrice(String(j.previous.purchasePricePennies / 100));
          if (j.previous.mortgageAdvancePennies) setMortgage(String(j.previous.mortgageAdvancePennies / 100));
          setSources((j.previous.sources as Array<{ kind: string; amountPennies: number; description: string; bankName?: string | null; accountHolder?: string | null; jointHolderName?: string | null; files?: Array<{ id: string; fileName: string }>; gift: { donorName: string; donorRelationship: string; donorAddress?: string | null; repayable: boolean; donorAbroad: boolean; jointDonorName?: string | null; files?: Array<{ id: string; fileName: string }> } | null; overseas: { country: string; alreadyInUk: boolean } | null; owner?: string | null; notYetReceived?: boolean }>).map((s) => ({ ...blank(s.kind), owner: s.owner ?? '', notYetReceived: !!s.notYetReceived, giftMore: { donorCountry: (s.gift as { donorCountry?: string | null } | null)?.donorCountry ?? '', expectsShare: !!(s.gift as { expectsShare?: boolean } | null)?.expectsShare, willLiveThere: !!(s.gift as { willLiveThere?: boolean } | null)?.willLiveThere, via: (s.gift as { via?: string | null } | null)?.via ?? '', forBuyer: (s.gift as { forBuyer?: string | null } | null)?.forBuyer ?? '' }, amount: String(s.amountPennies / 100), description: s.description, bankName: s.bankName ?? '', accountHolder: s.accountHolder ?? '', jointHolderName: s.jointHolderName ?? '', files: s.files ?? [], gift: s.gift ? { donorName: s.gift.donorName, donorRelationship: s.gift.donorRelationship, donorAddress: s.gift.donorAddress ?? '', repayable: s.gift.repayable, donorAbroad: s.gift.donorAbroad, jointDonorName: s.gift.jointDonorName ?? '', files: s.gift.files ?? [] } : blank().gift, overseas: s.overseas ?? blank().overseas })));
        }
      }
      // Back from the bank: the form as it was, with the accounts shared attached to the source they were for.
      const url = new URL(window.location.href);
      const connected = url.searchParams.get('connected');
      const failed = url.searchParams.get('connectFailed');
      if (r.ok && (connected || failed)) {
        try {
          const d = JSON.parse(localStorage.getItem(draftKey) ?? 'null');
          if (d) { setSources(d.sources); setFullName(d.fullName); setPrice(d.price); setMortgage(d.mortgage); setCoDeclarants(d.coDeclarants ?? []); setEmail(d.email ?? ''); setPhone(d.phone ?? ''); setNote(d.note ?? ''); setDec(d.dec); setAnswers(d.answers ?? {}); }
        } catch { /* storage blocked: the form starts again, the connected accounts are still attached below */ }
      }
      // Every bank connected from this form is attached to its source, whichever browser it was finished in.
      if (r.ok) {
        const c = await fetch(`/api/v1/pof/${token}/connections`).then((x) => x.json()).catch(() => null) as { connections?: Array<{ id: string; sourceIndex: number; party: 'client' | 'donor'; status: string; bank: string; files: Array<{ id: string; fileName: string }> }> } | null;
        const got = (c?.connections ?? []).filter((x) => x.status === 'linked');
        if (got.length) setSources((ss) => ss.map((src, k) => {
          const mine = got.filter((x) => x.sourceIndex === k + 1);
          const add = (have: Array<{ id: string; fileName: string }>, party: 'client' | 'donor') => [...have, ...mine.filter((x) => x.party === party).flatMap((x) => x.files).filter((f) => !have.some((h) => h.id === f.id))];
          return { ...src, files: add(src.files, 'client'), gift: { ...src.gift, files: add(src.gift.files, 'donor') } };
        }));
        if (connected || failed) {
          const just = got.find((x) => x.id === connected);
          setObMsg(failed ? { ok: false, text: failed } : { ok: true, text: just ? `${just.bank} connected: ${just.files.length} account${just.files.length === 1 ? '' : 's'} added.` : 'Bank connected.' });
          url.searchParams.delete('connected'); url.searchParams.delete('connectFailed'); url.searchParams.delete('demo');
          window.history.replaceState(null, '', url.pathname + url.search);
        }
      }
      if (r.ok) fetch(`/api/v1/pof/${token}/banks`).then((x) => x.json()).then((b) => { setObAvailable(!!b.available); setBanks(b.banks ?? []); }).catch(() => {});
    }).catch(() => setCtx({ status: 'unknown' }));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Choosing a bank: the form is kept in this browser while the client is away at their bank.
  useEffect(() => {
    if (!bankFor) return;
    const t = setTimeout(() => { fetch(`/api/v1/pof/${token}/banks?q=${encodeURIComponent(bankQ)}`).then((x) => x.json()).then((b) => setBanks(b.banks ?? [])).catch(() => {}); }, 200);
    return () => clearTimeout(t);
  }, [bankQ, bankFor, token]);
  const connectBank = async (institutionId: string) => {
    if (!bankFor) return;
    setBusy(true); setObMsg(null);
    try {
      try { localStorage.setItem(draftKey, JSON.stringify({ sources, fullName, price, mortgage, coDeclarants, email, phone, note, dec, answers })); } catch { /* storage blocked */ }
      const src = sources[bankFor.i];
      const r = await fetch(`/api/v1/pof/${token}/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceIndex: bankFor.i + 1, party: bankFor.party, institutionId, holderName: bankFor.party === 'donor' ? src.gift.donorName || null : fullName || null }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? 'The bank could not be connected.');
      // The bank returns the client to /pof/return, which needs this form's link: kept in this browser only.
      try { localStorage.setItem(`pof-return:${j.connectionId}`, token); } catch { /* storage blocked: /pof/return says to use the email link */ }
      window.location.href = j.link;
    } catch (e: unknown) { setObMsg({ ok: false, text: e instanceof Error ? e.message : 'The bank could not be connected.' }); setBusy(false); }
  };

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

  const attachAnswer = async (qid: string, files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setErr(null);
    try {
      const added: Array<{ id: string; fileName: string }> = [];
      for (const f of Array.from(files)) added.push(await upload(f));
      setAnswers((a) => ({ ...a, [qid]: { answer: a[qid]?.answer ?? '', files: [...(a[qid]?.files ?? []), ...added] } }));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

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
        coDeclarants,
        purchasePricePennies: priceP || null,
        mortgageAdvancePennies: mortgage ? pennies(mortgage) : null,
        sources: sources.map((s) => ({
          kind: s.kind,
          amountPennies: pennies(s.amount),
          description: s.description.trim() || `${KINDS.find((k) => k.id === s.kind)?.label ?? s.kind}`,
          bankName: s.bankName.trim() || null,
          accountHolder: s.accountHolder.trim() || null,
          evidenceDocumentIds: s.files.map((f) => f.id),
          gift: s.kind === 'gift' ? { donorName: s.gift.donorName.trim(), donorRelationship: s.gift.donorRelationship.trim(), donorAddress: s.gift.donorAddress.trim() || null, repayable: s.gift.repayable, donorAbroad: s.gift.donorAbroad, jointDonorName: s.gift.jointDonorName.trim() || null, donorEvidenceDocumentIds: s.gift.files.map((f) => f.id), donorCountry: s.gift.donorAbroad ? s.giftMore.donorCountry.trim() || null : null, expectsShare: s.giftMore.expectsShare, willLiveThere: s.giftMore.willLiveThere, via: s.giftMore.via.trim() || null, forBuyer: s.giftMore.forBuyer || null } : null,
          jointHolderName: s.kind !== 'gift' && s.kind !== 'mortgage' ? s.jointHolderName.trim() || null : null,
          overseas: s.kind === 'overseas' ? { country: s.overseas.country.trim(), alreadyInUk: s.overseas.alreadyInUk } : null,
          owner: s.owner || null,
          notYetReceived: LATER.has(s.kind) ? s.notYetReceived : false,
        })),
        declarations: dec,
        clientNote: note.trim() || null,
        answers: (ctx?.queries ?? []).map((q) => ({ queryId: q.id, answer: answers[q.id]?.answer?.trim() ?? '', evidenceDocumentIds: (answers[q.id]?.files ?? []).map((f) => f.id) })).filter((a) => a.answer || a.evidenceDocumentIds.length),
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

  const declaredTotal = sources.filter((s) => s.kind !== 'mortgage').reduce((n, s) => n + pennies(s.amount), 0);
  const needed = priceP ? Math.max(0, priceP - (mortgage ? pennies(mortgage) : 0)) : null;
  const shortfall = needed != null ? Math.max(0, needed - declaredTotal) : 0;
  const canSubmit = shortfall === 0 && fullName.trim().length > 1 && sources.length > 0 && sources.every((s) => pennies(s.amount) > 0 && (s.kind !== 'gift' || (s.gift.donorName.trim() && s.gift.donorRelationship.trim())) && (s.kind !== 'overseas' || s.overseas.country.trim())) && dec.accurate && dec.noThirdPartyInterest && dec.noUndisclosedBorrowing;

  return (
    <div className="pf"><style>{CSS}</style><div className="wrap">
      {obMsg && <div className={obMsg.ok ? 'ok' : 'err'} style={obMsg.ok ? { marginBottom: 12, padding: 12 } : undefined} role="status">{obMsg.text}</div>}
      <h1>Proof of funds — {ctx.propertyAddress}</h1>
      <p className="sub">{ctx.firmName} must verify where the money for your purchase is coming from before contracts can be exchanged. This is a legal requirement on every purchase. It takes about ten minutes; you can attach photos or PDFs from your phone.</p>
      {ctx.followUp && ctx.noteToClient && <div className="card" style={{ borderColor: '#fde68a', background: '#fffbeb' }}><b>Your conveyancer asked for a little more:</b><div style={{ marginTop: 6, whiteSpace: 'pre-wrap', fontSize: 14 }}>{ctx.noteToClient}</div></div>}
      {(ctx.queries?.length ?? 0) > 0 && (
        <div className="card" style={{ borderColor: '#c7d2fe', background: '#f5f3ff' }}>
          <b>Questions about your statements ({ctx.queries!.length})</b>
          <div className="hint" style={{ marginBottom: 6 }}>These are routine: every purchase is checked this way. Answer in your own words and attach anything that shows it.</div>
          {ctx.queries!.map((q, n) => (
            <div key={q.id} style={{ padding: '10px 0', borderTop: '1px solid #e0e7ff' }}>
              <div style={{ fontSize: 14 }}><b>{n + 1}.</b> {q.question}</div>
              {q.transaction && <div className="hint">Line: {q.transaction.date} · {q.transaction.description} · {gbp(Math.abs(q.transaction.amountPennies))}</div>}
              <label htmlFor={`pf-ans-${q.id}`}>Your answer</label>
              <textarea id={`pf-ans-${q.id}`} value={answers[q.id]?.answer ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: { answer: e.target.value, files: a[q.id]?.files ?? [] } }))} />
              <input type="file" multiple accept="application/pdf,image/*" onChange={(e) => void attachAnswer(q.id, e.target.files)} disabled={busy} style={{ marginTop: 6 }} />
              {(answers[q.id]?.files?.length ?? 0) > 0 && <div className="files">Attached: {answers[q.id].files.map((f) => f.fileName).join(', ')}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <b>About you</b>
        <label htmlFor="pf-name">Your full name</label><input id="pf-name" type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        {(ctx?.coBuyers?.length ?? 0) > 0 && (
          <div style={{ marginTop: 8 }}>
            <label>Buying with you</label>
            {ctx!.coBuyers!.map((n) => (
              <div className="chk" key={n}><input id={`pf-co-${n}`} type="checkbox" checked={coDeclarants.includes(n)} onChange={(e) => setCoDeclarants((cur) => (e.target.checked ? [...cur, n] : cur.filter((x) => x !== n)))} /><label htmlFor={`pf-co-${n}`} style={{ margin: 0, fontWeight: 400 }}>{n} confirms this declaration covers their money too</label></div>
            ))}
            <div className="hint">Anyone not ticked will be sent their own form.</div>
          </div>
        )}
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
            {s.kind !== 'gift' && s.kind !== 'mortgage' && (
              <>
                <label htmlFor={`pf-joint-${i}`}>Anyone else named on this account who is not buying with you</label>
                <input id={`pf-joint-${i}`} type="text" value={s.jointHolderName} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, jointHolderName: e.target.value } : x)))} placeholder="Leave blank if the account is yours alone or shared only with a co-buyer" />
                <div className="hint">Their share of the money counts as a gift to you: they will be asked for ID and to sign to say so.</div>
              </>
            )}
            {k.gift && (
              <div style={{ marginTop: 6, padding: 10, background: '#f8fafc', borderRadius: 8 }}>
                <div className="row">
                  <div><label htmlFor={`pf-donor-${i}`}>Who is giving it</label><input id={`pf-donor-${i}`} type="text" value={s.gift.donorName} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, gift: { ...x.gift, donorName: e.target.value } } : x)))} /></div>
                  <div><label htmlFor={`pf-rel-${i}`}>Their relationship to you</label><input id={`pf-rel-${i}`} type="text" value={s.gift.donorRelationship} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, gift: { ...x.gift, donorRelationship: e.target.value } } : x)))} placeholder="e.g. mother" /></div>
                </div>
                <label htmlFor={`pf-daddr-${i}`}>Their address</label><input id={`pf-daddr-${i}`} type="text" value={s.gift.donorAddress} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, gift: { ...x.gift, donorAddress: e.target.value } } : x)))} />
                <div className="chk"><input id={`pf-repay-${i}`} type="checkbox" checked={s.gift.repayable} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, gift: { ...x.gift, repayable: e.target.checked } } : x)))} /><label htmlFor={`pf-repay-${i}`} style={{ margin: 0, fontWeight: 400 }}>I will have to pay this money back</label></div>
                <label htmlFor={`pf-jdonor-${i}`}>Is the account the gift comes from in joint names? Name the other account holder</label>
                <input id={`pf-jdonor-${i}`} type="text" value={s.gift.jointDonorName} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, gift: { ...x.gift, jointDonorName: e.target.value } } : x)))} placeholder="e.g. my father, if the gift comes from my parents' joint account" />
                <div className="hint">Both account holders are giving the money, so both will be asked for ID and to sign the gift letter.</div>
                <div className="chk"><input id={`pf-abroad-${i}`} type="checkbox" checked={s.gift.donorAbroad} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, gift: { ...x.gift, donorAbroad: e.target.checked } } : x)))} /><label htmlFor={`pf-abroad-${i}`} style={{ margin: 0, fontWeight: 400 }}>They live outside the UK</label></div>
                {s.gift.donorAbroad && <><label htmlFor={`pf-dcountry-${i}`}>Which country they live in</label><input id={`pf-dcountry-${i}`} type="text" value={s.giftMore.donorCountry} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, giftMore: { ...x.giftMore, donorCountry: e.target.value } } : x)))} /></>}
                <div className="chk"><input id={`pf-share-${i}`} type="checkbox" checked={s.giftMore.expectsShare} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, giftMore: { ...x.giftMore, expectsShare: e.target.checked } } : x)))} /><label htmlFor={`pf-share-${i}`} style={{ margin: 0, fontWeight: 400 }}>They expect to own part of the property</label></div>
                <div className="chk"><input id={`pf-live-${i}`} type="checkbox" checked={s.giftMore.willLiveThere} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, giftMore: { ...x.giftMore, willLiveThere: e.target.checked } } : x)))} /><label htmlFor={`pf-live-${i}`} style={{ margin: 0, fontWeight: 400 }}>They will live in the property</label></div>
                <label htmlFor={`pf-via-${i}`}>Is it coming to you through someone else's account? Whose</label>
                <input id={`pf-via-${i}`} type="text" value={s.giftMore.via} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, giftMore: { ...x.giftMore, via: e.target.value } } : x)))} placeholder="Leave blank if it comes straight from them" />
                {(ctx?.coBuyers?.length ?? 0) > 0 && <><label htmlFor={`pf-for-${i}`}>Who the gift is for</label><select id={`pf-for-${i}`} value={s.giftMore.forBuyer} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, giftMore: { ...x.giftMore, forBuyer: e.target.value } } : x)))}><option value="">All of us</option>{[fullName, ...(ctx?.coBuyers ?? [])].filter(Boolean).map((n) => <option key={n} value={n}>{n}</option>)}</select></>}
                <label>Documents from the person giving it (ID, gift letter, their statements)</label>
                {obAvailable && <div style={{ margin: '6px 0' }}><button type="button" className="btn primary" disabled={busy} onClick={() => { setBankQ(''); setBankFor({ i, party: 'donor' }); }}>Connect Their Bank</button><div className="hint">The quickest way: {s.gift.donorName || 'they'} sign in to their own bank and share the account the gift comes from. We never see their login.</div></div>}
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
            {!k.gift && s.kind !== 'mortgage' && (ctx?.coBuyers?.length ?? 0) > 0 && <><label htmlFor={`pf-owner-${i}`}>Whose money this is</label><select id={`pf-owner-${i}`} value={s.owner} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, owner: e.target.value } : x)))}><option value="">All of us</option>{[fullName, ...(ctx?.coBuyers ?? [])].filter(Boolean).map((n) => <option key={n} value={n}>{n}</option>)}</select></>}
            {LATER.has(s.kind) && <div className="chk"><input id={`pf-later-${i}`} type="checkbox" checked={s.notYetReceived} onChange={(e) => setSources((ss) => ss.map((x, k2) => (k2 === i ? { ...x, notYetReceived: e.target.checked } : x)))} /><label htmlFor={`pf-later-${i}`} style={{ margin: 0, fontWeight: 400 }}>I have not received this money yet</label></div>}
            <label>{k.gift ? 'Your own statement showing the gift arriving (optional)' : 'Attach evidence'}</label>
            <div className="hint">{k.gift ? 'A statement for the account the gift was (or will be) paid into.' : k.evidence}</div>
            {obAvailable && k.id !== 'mortgage' && <div style={{ margin: '6px 0' }}><button type="button" className="btn primary" disabled={busy} onClick={() => { setBankQ(''); setBankFor({ i, party: 'client' }); }}>Connect Your Bank</button><div className="hint">The quickest way: sign in to your bank and share the account, instead of uploading statements. We never see your login.</div></div>}
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
      {bankFor && (
        <div className="ob-veil" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setBankFor(null); }}>
          <div className="ob-dlg" role="dialog" aria-label="Choose Your Bank">
            <h2>{bankFor.party === 'donor' ? `Choose ${sources[bankFor.i]?.gift.donorName || 'their'}'s Bank` : 'Choose Your Bank'}</h2>
            <input type="text" autoFocus placeholder="Search for your bank" value={bankQ} onChange={(e) => setBankQ(e.target.value)} aria-label="Search for your bank" />
            <div className="ob-list">
              {banks.map((b) => <button key={b.id} type="button" className="ob-bank" disabled={busy} onClick={() => void connectBank(b.id)}>{b.logo ? <img src={b.logo} alt="" /> : <span className="ob-logo" />}{b.name}</button>)}
              {!banks.length && <div className="hint">No bank matches. Try another spelling, or close this and upload statements instead.</div>}
            </div>
            <div className="hint">You will sign in on your bank&apos;s own page and choose the accounts to share. We get up to 24 months of transactions and the balance, read-only, once.</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button type="button" className="btn" disabled={busy} onClick={() => setBankFor(null)}>Cancel</button></div>
          </div>
        </div>
      )}
    </div></div>
  );
}
