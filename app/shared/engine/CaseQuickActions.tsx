'use client';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Hand } from '@/app/shared/icons';
import { BusyButton } from './BusyButton';
import { IssuesPanel } from './IssuesPanel';
import type { Api, EngineState } from './types';
import { WORK_CSS } from './WorkPanel';
import { CASE_SHAPES, SHAPE_SPEC } from '@/lib/server/engine/shapes';
import { profileOf } from '@/lib/server/engine/transactions';

/**
 * A task's header: raise an issue on its case (what happened, in sections that fold open: people.ts,
 * the deal, the property, completion; or any other problem), and take the case over by hand (or hand it back).
 * Icons only; each opens its own small form. The case is read when one is first opened.
 */
const CSS = `
.cqa{position:relative;display:inline-flex;gap:4px;align-items:center}
.cqa-b{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border:1px solid #e2e8f0;background:#fff;border-radius:8px;color:#475569;cursor:pointer;padding:0}
.cqa-b:hover{border-color:#5A27E0;color:#5A27E0}
.cqa-b.on{border-color:#f59e0b;color:#b45309;background:#fffbeb}
.cqa-tip{position:absolute;top:40px;z-index:60;background:#0f172a;color:#fff;font-size:12px;font-weight:600;line-height:1.3;padding:6px 9px;border-radius:7px;white-space:nowrap;pointer-events:none;box-shadow:0 8px 24px rgba(15,23,42,.25)}
.cqa-pop{position:absolute;top:36px;right:0;z-index:50;width:360px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.14);padding:12px;display:grid;gap:8px;text-align:left}
.cqa-pop b{font-size:13px;color:#0f172a}
.cqa-acc{border:1px solid #e2e8f0;border-radius:10px;overflow-y:auto;max-height:min(520px,62vh);overscroll-behavior:contain}
.cqa-h{display:flex;align-items:center;gap:8px;width:100%;border:0;border-top:1px solid #f1f5f9;background:#fff;padding:9px 12px;font:inherit;font-size:13px;font-weight:700;color:#0f172a;cursor:pointer;text-align:left}
.cqa-sec:first-child .cqa-h{border-top:0}
.cqa-h:hover{background:#f8fafc}
.cqa-h .n{margin-left:auto;font-size:11.5px;font-weight:600;color:#94a3b8}
.cqa-h svg{flex:none;color:#94a3b8}
.cqa-sec.open .cqa-h{background:#f7f5fd;color:#4c1d95}
.cqa-sec.open .cqa-h svg{color:#5A27E0}
.cqa-opts{display:grid;padding:2px 0 6px;background:#fcfcfe}
.cqa-o{display:block;width:100%;border:0;background:none;text-align:left;padding:7px 12px 7px 36px;font:inherit;font-size:13px;color:#334155;cursor:pointer;line-height:1.3}
.cqa-o:hover{background:#f1f5f9;color:#0f172a}
.cqa-o.on{color:#4c1d95;font-weight:700;background:#ede9fe}
.cqa-form{display:grid;gap:8px;padding:8px 12px 10px 36px;background:#f5f3ff;border-bottom:1px solid #ede9fe}
.cqa-else{color:#5A27E0}
.cqa-added{display:flex;gap:6px;align-items:flex-start;font-size:12.5px;color:#15803d;font-weight:600}
.cqa-added svg{flex:none;margin-top:1px}
.cqa-task{display:block;color:#0f172a;font-weight:500;margin-top:2px}
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
  ['uncontactable', 'Cannot Reach The Client'], ['instructing_for_client', 'Someone Else Is Giving Instructions'], ['complaint', 'Client Complaint'], ['fee_dispute', 'Client Disputes The Bill'],
  ['gift_withdrawn', 'A Gift Is Withdrawn'], ['contributions_changed', 'What Each Buyer Puts In Has Changed'], ['refuses_to_sign', 'A Co-Owner Will Not Sign'], ['confidence', 'A Joint Client Told Us Something In Confidence'],
  ['withhold_from_lender', 'Client Asks Us Not To Tell The Lender'], ['third_party_payment', 'Client Asks Us To Pay Someone Else'], ['moving_firm', 'Client Moving To Another Firm'], ['ceasing_to_act', 'We Are Ceasing To Act'],
  ['cdd_refused', 'Client Will Not Give ID Or Source Of Funds'], ['cash_paid_in', 'Client Paid Cash In'], ['capacity_doubt', 'Doubt About Capacity'], ['capacity_lost', 'Someone Has Lost Capacity'],
  ['bankrupt', 'Someone Is Bankrupt'], ['company_insolvent', 'A Company Is In Liquidation Or Struck Off'], ['sanctions_designated', 'Someone Is Now On A Sanctions List'],
  ['died', 'Someone Has Died'], ['donor_died', 'The Donor Of A Power Of Attorney Has Died'], ['gift_donor_died', 'Someone Giving Money Has Died'],
];

export function CaseQuickActions({ api, matterId, onChanged, lazy = false }: { api: Api; matterId: string; onChanged?: () => void; /** Load the case only when a menu opens (the Tasks list has many cases). */ lazy?: boolean }) {
  const [state, setState] = useState<EngineState | null>(null);
  const [open, setOpen] = useState<'issue' | 'manual' | 'other' | null>(null);
  const [what, setWhat] = useState<string>('');
  /** What the last record put on the Tasks list. */
  const [added, setAdded] = useState<string[] | null>(null);
  const [who, setWho] = useState('');
  const [lpa, setLpa] = useState(false);
  const [until, setUntil] = useState('');
  const [fee, setFee] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement | null>(null);
  const load = async () => { const v = await api<{ state: EngineState }>(`/matters/${matterId}/engine`).catch(() => null); if (v) setState(v.state); return v?.state ?? null; };
  useEffect(() => { if (!lazy) void load(); }, [matterId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (lazy && open && !state) void load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Loaded after the menu opened (the Tasks list): fill in the client as the person it is about.
  useEffect(() => { if (open === 'issue' && !who && state?.partyNames?.[0]) setWho(state.partyNames[0]); }, [state, open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open !== 'manual' && open !== 'issue') return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(null); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const cmd = async (body: Record<string, unknown>) => {
    const r = await api<{ events?: Array<{ type: string; payload?: { title?: string } }> }>(`/matters/${matterId}/engine`, { method: 'POST', body: JSON.stringify(body) });
    const raised = (r?.events ?? []).filter((e) => e.type === 'issue_raised' && e.payload?.title).map((e) => e.payload!.title!);
    setAdded(body.type === 'sar_made' ? ['On hold for the NCA: nothing exchanges and no money moves until it answers'] : raised);
    await load(); onChanged?.(); window.dispatchEvent(new Event('conveyi:counts')); return true;
  };
  const manual = !!state?.manualHandling?.required;
  // The button's name, shown on hover or focus.
  const [tip, setTip] = useState<{ which: 'issue' | 'manual' } | null>(null);
  // Placed in the icons' own box, right under the icon it names: nothing about the page can move it.
  const showTip = (which: 'issue' | 'manual') => () => setTip({ which });
  const TIPS = { issue: 'Raise Issue', manual: manual ? 'Resume Automation' : 'Take Over Manually' };
  const holdPending = state?.amlHold?.status === 'awaiting';
  const isParty = PARTY_EVENTS.some(([v]) => v === what);
  const isShape = what.startsWith('shape:');
  const isIsa = what.startsWith('isa:');
  const isCe = what.startsWith('ce:');
  const side = state?.transactionType ? profileOf(state.transactionType).side : null;
  const shapeOptions = side ? CASE_SHAPES.map((id) => SHAPE_SPEC[id]).filter((sh) => sh.sides.includes(side) && !(state?.shapes ?? []).includes(sh.id)) : [];

  const completed = !!state?.completion?.confirmedAt;
  // What happened, in sections, each showing only what can happen on this case now (a 90-item list helps nobody).
  const [group, setGroup] = useState<string | null>(null);
  const exchanged = !!state?.exchange?.exchangedAt;
  const joint = (state?.partyNames?.length ?? 0) > 1 || (state?.parties ?? 1) > 1;
  const buying = side === 'buyer';
  const opt = (v: string, l: string, when = true): Array<[string, string]> => (when ? [[v, l]] : []);
  const groups: Array<{ id: string; label: string; options: Array<[string, string]> }> = [
    { id: 'client', label: 'Client', options: [
      ...opt('uncontactable', 'Cannot Reach The Client', !completed), ...opt('instructing_for_client', 'Someone Else Is Giving Instructions', !completed),
      ...opt('complaint', 'Client Complaint'), ...opt('fee_dispute', 'Client Disputes The Bill'), ...opt('third_party_payment', 'Client Asks Us To Pay Someone Else'),
      ...opt('gift_withdrawn', 'A Gift Is Withdrawn', buying && !completed), ...opt('contributions_changed', 'What Each Buyer Puts In Has Changed', buying && joint && !completed),
      ...opt('confidence', 'A Joint Client Told Us Something In Confidence', joint && !completed), ...opt('refuses_to_sign', 'A Co-Owner Will Not Sign', joint && !completed),
      ...opt('withhold_from_lender', 'Client Asks Us Not To Tell The Lender', !!state?.hasLender && !completed),
      ...opt('moving_firm', 'Client Moving To Another Firm', !completed), ...opt('ceasing_to_act', 'We Are Ceasing To Act'),
    ] },
    { id: 'death', label: 'Death Or Capacity', options: [
      ...opt('capacity_doubt', 'Doubt About Capacity', !completed), ...opt('capacity_lost', 'Someone Has Lost Capacity', !completed),
      ...opt('bankrupt', 'Someone Is Bankrupt', !completed), ...opt('company_insolvent', 'A Company Is In Liquidation Or Struck Off', !completed),
      ...opt('died', 'Someone Has Died'), ...opt('donor_died', 'The Donor Of A Power Of Attorney Has Died', !completed), ...opt('gift_donor_died', 'Someone Giving Money Has Died', buying && !completed),
    ] },
    { id: 'aml', label: 'Money Laundering', options: [
      ...opt('cdd_refused', 'Client Will Not Give ID Or Source Of Funds', !completed), ...opt('cash_paid_in', 'Client Paid Cash In', !completed), ...opt('sanctions_designated', 'Someone Is Now On A Sanctions List', !completed),
      ...opt('sar', 'Report Made To The NCA (Hold)', !holdPending), ...opt('daml_granted', 'NCA Consent Received', holdPending), ...opt('daml_refused', 'NCA Consent Refused', holdPending),
    ] },
    { id: 'property', label: 'The Property', options: completed ? [] : [
      ...opt('damaged', 'The Property Was Damaged'), ...opt('not_vacant', 'Vacant Possession Not Given', exchanged), ...opt('early_access', 'Early Access Before Completion'), ...opt('seller_stays', 'The Seller Stays On After Completion'),
      ...opt('boundary_mismatch', 'The Boundary Differs From The Plan'), ...opt('adverse_possession', 'Part Of It Is Held Without Title', !exchanged), ...opt('deeds_lost', 'The Deeds Are Lost', !exchanged),
      ...opt('land_charge_entry', 'The Land Charges Search Shows An Entry', !exchanged), ...opt('searches_declined', 'The Client Does Not Want Searches', buying && !exchanged),
    ] },
    { id: 'deal', label: 'The Deal', options: completed ? [] : exchanged ? [...opt('sitting_tenant', 'Tenant In The Property'), ...opt('nominee', 'Transfer To Someone Else Or An Extra Person', buying)] : [
      ...opt('contract_race', 'Contract Race'), ...opt('lockout', 'Lock-Out Agreed'), ...opt('reservation', 'New-Build Reservation', buying), ...opt('renegotiated', 'Terms Renegotiated'),
      ...opt('sitting_tenant', 'Tenant In The Property'), ...opt('nominee', 'Transfer To Someone Else Or An Extra Person', buying), ...opt('buy_out', 'Sale Replaced By A Buy-Out', side === 'seller'),
      ...opt('incentive', 'Incentive From The Seller', buying), ...opt('deposit_direct', 'Deposit Paid Directly To The Seller Or Agent'),
    ] },
    { id: 'completion', label: 'Completion', options: !exchanged ? [] : [
      ...opt('ce:completion_missed', 'Completion Did Not Happen Today', !completed), ...opt('ce:seller_unconfirmed', "Seller's Solicitor Has Not Confirmed Completion", !completed && buying),
      ...opt('ce:payment_misdirected', 'Money Sent To The Wrong Account'), ...opt('ce:keys_not_released', 'Keys Not Released', completed && buying),
      ...opt('ce:redemption_returned', 'Lender Returned The Redemption Money', completed), ...opt('ce:undertaking_chased', "Buyer's Solicitor Chasing Our Undertaking", completed && side === 'seller'),
      ...opt('sdlt_amend', 'The SDLT Return Was Amended', completed && buying), ...opt('ce:contract_retention', 'Retention Held Under The Contract'),
    ] },
    { id: 'isa', label: 'ISA', options: completed ? [] : [...opt('isa:lifetime_isa', 'Lifetime ISA Opened On', (state?.shapes ?? []).includes('lifetime_isa')), ...opt('isa:help_to_buy_isa', 'Help To Buy ISA Closed On', (state?.shapes ?? []).includes('help_to_buy_isa'))] },
    { id: 'shape', label: 'This Case Is Also', options: completed ? [] : shapeOptions.map((sh): [string, string] => [`shape:${sh.id}`, sh.label]) },
  ].filter((g) => g.options.length > 0);  // The warning before taking a case over, until the person says not to show it again (this browser only).
  const WARN_KEY = 'conveyi:manual-warning-hidden';
  const [warnHidden, setWarnHidden] = useState(false);
  useEffect(() => { try { setWarnHidden(localStorage.getItem(WARN_KEY) === '1'); } catch { /* storage blocked */ } }, []);
  // Saved at once, applied from the next time: the warning stays while it is being read.
  const [dontShow, setDontShow] = useState(false);
  const hideWarning = (on: boolean) => { setDontShow(on); try { if (on) localStorage.setItem(WARN_KEY, '1'); else localStorage.removeItem(WARN_KEY); } catch { /* storage blocked */ } };
  const hover = (which: 'issue' | 'manual') => ({ onMouseEnter: showTip(which), onFocus: showTip(which), onMouseLeave: () => setTip(null), onBlur: () => setTip(null) });
  const done = completed || !!state?.abandoned;
  const live = !state?.abandoned && !state?.closedAt;

  return (
    <span className="cqa" ref={box}>
      <style>{WORK_CSS + CSS}</style>
      {live && <button type="button" data-tour="case-raise-issue" className="cqa-b" aria-label="Raise Issue" {...hover('issue')} onClick={() => { setTip(null); setErr(null); setReason(''); setWho(state?.partyNames?.[0] ?? ''); setWhat(''); setGroup(holdPending ? 'aml' : null); setAdded(null); setOpen(open === 'issue' ? null : 'issue'); }}><AlertTriangle size={16} /></button>}
      {!done && <button type="button" data-tour="case-take-over" className={`cqa-b${manual ? ' on' : ''}`} aria-label={manual ? 'Resume Automation' : 'Take Over Manually'} {...hover('manual')} onClick={() => { setTip(null); setErr(null); setReason(''); try { setWarnHidden(localStorage.getItem(WARN_KEY) === '1'); } catch { /* storage blocked */ } setOpen(open === 'manual' ? null : 'manual'); }}><Hand size={16} /></button>}
      {tip && !open && <span className="cqa-tip" role="tooltip" style={tip.which === 'issue' && !done ? { right: 38 } : { right: 0 }}>{TIPS[tip.which]}</span>}
      {open === 'issue' && (
        <span className="cqa-pop" role="dialog" aria-label="Raise Issue">
          <b>Raise Issue</b>
          {!state ? <span className="cqa-added" style={{ color: '#64748b' }}>Loading…</span> : <span className="cqa-acc">
            {groups.map((g) => {
              const on = group === g.id;
              return (
                <span key={g.id} className={`cqa-sec${on ? ' open' : ''}`} style={{ display: 'block' }}>
                  <button type="button" className="cqa-h" aria-expanded={on} onClick={() => { setGroup(on ? null : g.id); setWhat(''); setAdded(null); setErr(null); }}>
                    {on ? <ChevronDown size={16} /> : <ChevronRight size={16} />}{g.label}<span className="n">{g.options.length}</span>
                  </button>
                  {on && (
                    <span className="cqa-opts">
                      {g.options.map(([v, l]) => (
                        <span key={v} style={{ display: 'contents' }}>
                          <button type="button" className={`cqa-o${what === v ? ' on' : ''}`} onClick={() => { setWhat(what === v ? '' : v); setAdded(null); setErr(null); }}>{l}</button>
                          {what === v && (
                            <span className="cqa-form">
                {isParty && (
                  <>
                    <input type="text" list="cqa-people" value={who} onChange={(e) => setWho(e.target.value)} placeholder="Who" aria-label="Who" />
                    <datalist id="cqa-people">{(state?.partyNames ?? []).map((n) => <option key={n} value={n} />)}</datalist>
                    {what === 'capacity_lost' && <label className="dont"><input type="checkbox" checked={lpa} onChange={(e) => setLpa(e.target.checked)} />A Registered Power Of Attorney Covers It</label>}
                  </>
                )}
                {isIsa && <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Date" />}
                {(what === 'lockout' || what === 'reservation') && <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label={what === 'lockout' ? 'Lock-out ends' : 'Exchange deadline'} />}
                {(what === 'ce:contract_retention' || what === 'ce:payment_misdirected' || what === 'ce:redemption_returned' || what === 'sdlt_amend') && <input type="text" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="£ Amount" aria-label="Amount" />}
                {what === 'ce:contract_retention' && <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Release by" />}
                {(what === 'lockout' || what === 'reservation' || what === 'incentive') && <input type="text" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder={what === 'reservation' ? '£ Reservation fee' : what === 'incentive' ? '£ Value' : '£ Paid for it'} aria-label="Amount" />}
                {what === 'sar' && <span className="warn"><AlertTriangle size={16} /><span>No money moves and nothing exchanges for seven working days, or until consent. Say nothing to the client about it.</span></span>}
                {!!what && !isShape && !isIsa && <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={isParty || isShape || isIsa || what === 'sar' || what.startsWith('daml') ? 'Note' : 'What happened'} aria-label="Note" />}
                {err && <span className="bad">{err}</span>}
                {added && <span className="cqa-added"><Check size={16} /><span>{added.length ? <>Added To Tasks:{added.map((a) => <span key={a} className="cqa-task">{a}</span>)}</> : 'Recorded on the case.'}</span></span>}
                <span className="f">
                  <button type="button" className="ep-btn" style={{ margin: 0 }} onClick={() => { setWhat(''); setAdded(null); }}>{added ? 'Close' : 'Cancel'}</button>
                  {!!what && <BusyButton disabled={!what || (isIsa && !until) || (isParty && !who.trim()) || (!isParty && !isShape && !isIsa && !['sar', 'daml_granted', 'daml_refused'].includes(what) && !reason.trim())} busyLabel="Recording…" doneLabel="Recorded" onClick={async () => {
                    setErr(null);
                    const deal = ['contract_race', 'lockout', 'reservation', 'renegotiated', 'sitting_tenant', 'nominee', 'buy_out', 'incentive', 'deposit_direct'].includes(what);
                    const body = what === 'sdlt_amend' ? { type: 'sdlt_amended', newAmountPennies: Math.round(Number(fee.replace(/[£,\s]/g, '') || 0) * 100), reason: reason.trim() } : isCe ? { type: 'record_completion_event', event: what.slice(3), detail: reason.trim(), amountPennies: fee.trim() ? Math.round(Number(fee.replace(/[£,\s]/g, '')) * 100) : null, until: until || null } : isIsa ? { type: 'record_isa', isa: what.slice(4), ...(what === 'isa:lifetime_isa' ? { openedOn: until } : { closedOn: until }) } : isShape ? { type: 'add_shape', shape: what.slice(6) } : deal ? { type: 'record_deal_event', event: what, detail: reason.trim(), until: until || null, amountPennies: fee.trim() ? Math.round(Number(fee.replace(/[£,\s]/g, '')) * 100) : null } : ['damaged', 'not_vacant', 'early_access', 'seller_stays', 'boundary_mismatch', 'adverse_possession', 'deeds_lost', 'land_charge_entry', 'searches_declined'].includes(what) ? { type: 'record_property_event', event: what, detail: reason.trim() } : what === 'sar' ? { type: 'sar_made', note: reason.trim() || null } : what === 'daml_granted' || what === 'daml_refused' ? { type: 'daml_response', decision: what === 'daml_granted' ? 'granted' : 'refused', note: reason.trim() || null } : { type: 'record_party_event', event: what, party: who.trim(), hasAttorney: what === 'capacity_lost' ? lpa : null, note: reason.trim() || null };
                    try { await cmd(body); setReason(''); return true; }
                    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'It did not save.'); return false; }
                  }}>Record</BusyButton>}
                </span>
                            </span>
                          )}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              );
            })}
            {!done && (
              <span className="cqa-sec" style={{ display: 'block' }}>
                <button type="button" className="cqa-h cqa-else" onClick={() => { setTip(null); setOpen('other'); }}><ChevronRight size={16} />Another Problem On The File</button>
              </span>
            )}
          </span>}
        </span>
      )}
      {open === 'other' && state && (
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
