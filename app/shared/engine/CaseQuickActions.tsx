'use client';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Hand, Users } from '@/app/shared/icons';
import { BusyButton } from './BusyButton';
import { IssuesPanel } from './IssuesPanel';
import type { Api, EngineState } from './types';
import { WORK_CSS } from './WorkPanel';
import { CASE_SHAPES, SHAPE_SPEC } from '@/lib/server/engine/shapes';
import { profileOf } from '@/lib/server/engine/transactions';

/**
 * A task's header: raise an issue on its case, record something that happened to a person on it (people.ts),
 * and take the case over by hand (or hand it back).
 * Icons only; each opens its own small form. The case is read when one is first opened.
 */
const CSS = `
.cqa{position:relative;display:inline-flex;gap:4px;align-items:center}
.cqa-b{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border:1px solid #e2e8f0;background:#fff;border-radius:8px;color:#475569;cursor:pointer;padding:0}
.cqa-b:hover{border-color:#5A27E0;color:#5A27E0}
.cqa-b.on{border-color:#f59e0b;color:#b45309;background:#fffbeb}
.cqa-tip{position:absolute;top:40px;z-index:60;background:#0f172a;color:#fff;font-size:12px;font-weight:600;line-height:1.3;padding:6px 9px;border-radius:7px;white-space:nowrap;pointer-events:none;box-shadow:0 8px 24px rgba(15,23,42,.25)}
.cqa-pop{position:absolute;top:36px;right:0;z-index:50;width:320px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.14);padding:12px;display:grid;gap:8px;text-align:left}
.cqa-pop b{font-size:13px;color:#0f172a}
.cqa-pop textarea{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font:inherit;font-size:13px;resize:vertical}
.cqa-pop .f{display:flex;gap:6px;justify-content:flex-end}
.cqa-pop .warn{display:flex;gap:8px;align-items:flex-start;background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:8px;padding:8px 10px;font-size:12.5px;line-height:1.45}
.cqa-pop .warn svg{flex:none;margin-top:1px}
.cqa-pop .dont{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#475569;font-weight:600}
.cqa-pop .bad{font-size:12.5px;color:#b91c1c;font-weight:600}
.cqa-pop select,.cqa-pop input[type=text]{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:7px 8px;font:inherit;font-size:13px;background:#fff}
`;

/** What can still be recorded once the matter has completed. */
const AFTER_COMPLETION = new Set(['died', 'complaint', 'ceasing_to_act', 'fee_dispute', 'third_party_payment']);

/** People on the case: who it is about, and what happened (people.ts). */
const PARTY_EVENTS: Array<[string, string]> = [
  ['died', 'Someone Has Died'], ['capacity_lost', 'Someone Has Lost Capacity'], ['capacity_doubt', 'Doubt About Capacity'], ['bankrupt', 'Someone Is Bankrupt'],
  ['instructing_for_client', 'Someone Else Is Giving Instructions'], ['confidence', 'A Joint Client Told Us Something In Confidence'], ['refuses_to_sign', 'A Co-Owner Will Not Sign'],
  ['withhold_from_lender', 'Client Asks Us Not To Tell The Lender'], ['gift_withdrawn', 'A Gift Is Withdrawn'], ['cdd_refused', 'Client Will Not Give ID Or Source Of Funds'],
  ['uncontactable', 'Cannot Reach The Client'], ['complaint', 'Client Complaint'], ['moving_firm', 'Client Moving To Another Firm'], ['ceasing_to_act', 'We Are Ceasing To Act'],
  ['donor_died', 'The Donor Of A Power Of Attorney Has Died'], ['gift_donor_died', 'Someone Giving Money Has Died'], ['contributions_changed', 'What Each Buyer Puts In Has Changed'],
  ['company_insolvent', 'A Company Is In Liquidation Or Struck Off'], ['sanctions_designated', 'Someone Is Now On A Sanctions List'],
  ['fee_dispute', 'Client Disputes The Bill'], ['third_party_payment', 'Client Asks Us To Pay Someone Else'], ['cash_paid_in', 'Client Paid Cash In'],
];

export function CaseQuickActions({ api, matterId, onChanged }: { api: Api; matterId: string; onChanged?: () => void }) {
  const [state, setState] = useState<EngineState | null>(null);
  const [open, setOpen] = useState<'issue' | 'manual' | 'person' | null>(null);
  const [what, setWhat] = useState<string>('died');
  const [who, setWho] = useState('');
  const [lpa, setLpa] = useState(false);
  const [until, setUntil] = useState('');
  const [fee, setFee] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement | null>(null);
  const load = async () => { const v = await api<{ state: EngineState }>(`/matters/${matterId}/engine`).catch(() => null); if (v) setState(v.state); return v?.state ?? null; };
  useEffect(() => { void load(); }, [matterId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open !== 'manual' && open !== 'person') return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(null); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const cmd = async (body: Record<string, unknown>) => { await api(`/matters/${matterId}/engine`, { method: 'POST', body: JSON.stringify(body) }); await load(); onChanged?.(); return true; };
  const manual = !!state?.manualHandling?.required;
  // The button's name, shown on hover or focus.
  const [tip, setTip] = useState<{ which: 'issue' | 'manual' | 'person' } | null>(null);
  // Placed in the icons' own box, right under the icon it names: nothing about the page can move it.
  const showTip = (which: 'issue' | 'manual' | 'person') => () => setTip({ which });
  const TIPS = { issue: 'Raise Issue', manual: manual ? 'Resume Automation' : 'Take Over Manually', person: 'Something Happened' };
  const holdPending = state?.amlHold?.status === 'awaiting';
  const isParty = PARTY_EVENTS.some(([v]) => v === what);
  const isShape = what.startsWith('shape:');
  const isIsa = what.startsWith('isa:');
  const side = state?.transactionType ? profileOf(state.transactionType).side : null;
  const shapeOptions = side ? CASE_SHAPES.map((id) => SHAPE_SPEC[id]).filter((sh) => sh.sides.includes(side) && !(state?.shapes ?? []).includes(sh.id)) : [];
  // The warning before taking a case over, until the person says not to show it again (this browser only).
  const WARN_KEY = 'conveyi:manual-warning-hidden';
  const [warnHidden, setWarnHidden] = useState(false);
  useEffect(() => { try { setWarnHidden(localStorage.getItem(WARN_KEY) === '1'); } catch { /* storage blocked */ } }, []);
  // Saved at once, applied from the next time: the warning stays while it is being read.
  const [dontShow, setDontShow] = useState(false);
  const hideWarning = (on: boolean) => { setDontShow(on); try { if (on) localStorage.setItem(WARN_KEY, '1'); else localStorage.removeItem(WARN_KEY); } catch { /* storage blocked */ } };
  const hover = (which: 'issue' | 'manual' | 'person') => ({ onMouseEnter: showTip(which), onFocus: showTip(which), onMouseLeave: () => setTip(null), onBlur: () => setTip(null) });
  const completed = !!state?.completion?.confirmedAt;
  const done = completed || !!state?.abandoned;

  return (
    <span className="cqa" ref={box}>
      <style>{WORK_CSS + CSS}</style>
      {!done && <button type="button" data-tour="case-raise-issue" className="cqa-b" aria-label="Raise Issue" {...hover('issue')} onClick={() => { setTip(null); setErr(null); setOpen(open === 'issue' ? null : 'issue'); }}><AlertTriangle size={16} /></button>}
      {!done && <button type="button" data-tour="case-take-over" className={`cqa-b${manual ? ' on' : ''}`} aria-label={manual ? 'Resume Automation' : 'Take Over Manually'} {...hover('manual')} onClick={() => { setTip(null); setErr(null); setReason(''); try { setWarnHidden(localStorage.getItem(WARN_KEY) === '1'); } catch { /* storage blocked */ } setOpen(open === 'manual' ? null : 'manual'); }}><Hand size={16} /></button>}
      {!state?.abandoned && !state?.closedAt && <button type="button" data-tour="case-something-happened" className="cqa-b" aria-label="Something Happened" {...hover('person')} onClick={() => { setTip(null); setErr(null); setReason(''); setWho(state?.partyNames?.[0] ?? ''); setWhat(holdPending ? 'daml_granted' : completed ? 'complaint' : 'died'); setOpen(open === 'person' ? null : 'person'); }}><Users size={16} /></button>}
      {tip && !open && <span className="cqa-tip" role="tooltip" style={tip.which === 'issue' ? { right: 76 } : tip.which === 'manual' ? { right: 38 } : { right: 0 }}>{TIPS[tip.which]}</span>}
      {open === 'person' && (
        <span className="cqa-pop" role="dialog" aria-label="Something Happened">
          <b>Something Happened</b>
          <select value={what} onChange={(e) => setWhat(e.target.value)} aria-label="What happened">
            <optgroup label="People">{PARTY_EVENTS.filter(([v]) => !completed || AFTER_COMPLETION.has(v)).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</optgroup>
            {!completed && <optgroup label="The Property">
              <option value="damaged">The Property Was Damaged</option>
              <option value="not_vacant">Vacant Possession Not Given</option>
              <option value="early_access">Early Access Before Completion</option>
              <option value="seller_stays">The Seller Stays On After Completion</option>
            </optgroup>}
            {!completed && <optgroup label="The Deal">
              <option value="contract_race">Contract Race</option>
              <option value="lockout">Lock-Out Agreed</option>
              <option value="reservation">New-Build Reservation</option>
              <option value="renegotiated">Terms Renegotiated</option>
              <option value="sitting_tenant">Tenant In The Property</option>
              <option value="nominee">Transfer To Someone Else Or An Extra Person</option>
              <option value="buy_out">Sale Replaced By A Buy-Out</option>
              <option value="incentive">Incentive From The Seller</option>
              <option value="deposit_direct">Deposit Paid Directly To The Seller Or Agent</option>
            </optgroup>}
            {!completed && (state?.shapes ?? []).some((x) => x === 'lifetime_isa' || x === 'help_to_buy_isa') && <optgroup label="ISA">
              {(state?.shapes ?? []).includes('lifetime_isa') && <option value="isa:lifetime_isa">Lifetime ISA Opened On</option>}
              {(state?.shapes ?? []).includes('help_to_buy_isa') && <option value="isa:help_to_buy_isa">Help To Buy ISA Closed On</option>}
            </optgroup>}
            {!completed && shapeOptions.length > 0 && <optgroup label="This Case Is Also">{shapeOptions.map((sh) => <option key={sh.id} value={`shape:${sh.id}`}>{sh.label}</option>)}</optgroup>}
            <optgroup label="Compliance">
              {!holdPending && <option value="sar">Report Made To The NCA (Hold)</option>}
              {holdPending && <option value="daml_granted">NCA Consent Received</option>}
              {holdPending && <option value="daml_refused">NCA Consent Refused</option>}
            </optgroup>
          </select>
          {isParty && (
            <>
              <input type="text" list="cqa-people" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Who" aria-label="Who" />
              <datalist id="cqa-people">{(state?.partyNames ?? []).map((n) => <option key={n} value={n} />)}</datalist>
              {what === 'capacity_lost' && <label className="dont"><input type="checkbox" checked={lpa} onChange={(e) => setLpa(e.target.checked)} />A Registered Power Of Attorney Covers It</label>}
            </>
          )}
          {isIsa && <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Date" />}
          {(what === 'lockout' || what === 'reservation') && <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label={what === 'lockout' ? 'Lock-out ends' : 'Exchange deadline'} />}
          {(what === 'lockout' || what === 'reservation' || what === 'incentive') && <input type="text" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder={what === 'reservation' ? '£ Reservation fee' : what === 'incentive' ? '£ Value' : '£ Paid for it'} aria-label="Amount" />}
          {what === 'sar' && <span className="warn"><AlertTriangle size={16} /><span>No money moves and nothing exchanges for seven working days, or until consent. Say nothing to the client about it.</span></span>}
          {!isShape && !isIsa && <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={isParty || isShape || isIsa || what === 'sar' || what.startsWith('daml') ? 'Note' : 'What happened'} aria-label="Note" />}
          {err && <span className="bad">{err}</span>}
          <span className="f">
            <button type="button" className="ep-btn" style={{ margin: 0 }} onClick={() => setOpen(null)}>Cancel</button>
            <BusyButton disabled={(isIsa && !until) || (isParty && !who.trim()) || (!isParty && !isShape && !isIsa && !['sar', 'daml_granted', 'daml_refused'].includes(what) && !reason.trim())} busyLabel="Recording…" doneLabel="Recorded" onClick={async () => {
              setErr(null);
              const deal = ['contract_race', 'lockout', 'reservation', 'renegotiated', 'sitting_tenant', 'nominee', 'buy_out', 'incentive', 'deposit_direct'].includes(what);
              const body = isIsa ? { type: 'record_isa', isa: what.slice(4), ...(what === 'isa:lifetime_isa' ? { openedOn: until } : { closedOn: until }) } : isShape ? { type: 'add_shape', shape: what.slice(6) } : deal ? { type: 'record_deal_event', event: what, detail: reason.trim(), until: until || null, amountPennies: fee.trim() ? Math.round(Number(fee.replace(/[£,\s]/g, '')) * 100) : null } : ['damaged', 'not_vacant', 'early_access', 'seller_stays'].includes(what) ? { type: 'record_property_event', event: what, detail: reason.trim() } : what === 'sar' ? { type: 'sar_made', note: reason.trim() || null } : what === 'daml_granted' || what === 'daml_refused' ? { type: 'daml_response', decision: what === 'daml_granted' ? 'granted' : 'refused', note: reason.trim() || null } : { type: 'record_party_event', event: what, party: who.trim(), hasAttorney: what === 'capacity_lost' ? lpa : null, note: reason.trim() || null };
              try { await cmd(body); setTimeout(() => setOpen(null), 900); return true; }
              catch (e: unknown) { setErr(e instanceof Error ? e.message : 'It did not save.'); return false; }
            }}>Record</BusyButton>
          </span>
        </span>
      )}
      {open === 'issue' && state && (
        <IssuesPanel api={api} state={state} busy={false} raiseOnly onCancel={() => setOpen(null)} onChanged={() => { void load(); onChanged?.(); }} cmd={async (body) => { try { return await cmd(body); } catch (e: unknown) { throw e instanceof Error ? e : new Error('It did not save.'); } }} />
      )}
      {open === 'manual' && (
        <span className="cqa-pop" role="dialog" aria-label={manual ? 'Resume Automation' : 'Take Over Manually'}>
          <b>{manual ? 'Resume Automation' : 'Take Over Manually'}</b>
          {!manual && !warnHidden && (
            <span className="warn">
              <AlertTriangle size={16} />
              <span>The engine stops acting on this case on its own. Nothing is sent, chased or ordered without you, and you mark each step complete by hand until you resume automation.</span>
            </span>
          )}
          {!manual && !warnHidden && <label className="dont"><input type="checkbox" checked={dontShow} onChange={(e) => hideWarning(e.target.checked)} />Don&apos;t Show This Again</label>}
          <textarea rows={2} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={manual ? 'Why it can run on its own again' : 'Why this case needs handling by hand'} aria-label="Reason" />
          {err && <span className="bad">{err}</span>}
          <span className="f">
            <button type="button" className="ep-btn" style={{ margin: 0 }} onClick={() => setOpen(null)}>Cancel</button>
            <BusyButton disabled={reason.trim().length < 3} busyLabel={manual ? 'Resuming…' : 'Taking Over…'} doneLabel={manual ? 'Resumed' : 'Taken Over'} onClick={async () => {
              setErr(null);
              try { await cmd(manual ? { type: 'resume_automation', reason: reason.trim() } : { type: 'mark_manual_handling', reason: reason.trim() }); setTimeout(() => setOpen(null), 900); return true; }
              catch (e: unknown) { setErr(e instanceof Error ? e.message : 'It did not save.'); return false; }
            }}>{manual ? 'Resume Automation' : 'Take Over Manually'}</BusyButton>
          </span>
        </span>
      )}
    </span>
  );
}
