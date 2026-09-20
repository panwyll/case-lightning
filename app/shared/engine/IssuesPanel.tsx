'use client';
import { useEffect, useMemo, useState } from 'react';
import { fmtDay, pretty, type Api, type EngineState, type IssueCatalogue, type IssueRow } from './types';

/**
 * The issues layer on a matter (docs/engine-issues.md): what has gone wrong, what it is
 * holding, and the realistic ways out. The catalogue (kinds by group, each kind's
 * resolutions and default gate) comes from /engine/spec so the panel can never offer an
 * outcome the machine would refuse.
 */
const GATE_CHIP: Record<string, { bg: string; fg: string; label: string }> = {
  exchange: { bg: '#fee2e2', fg: '#7f1d1d', label: 'holds exchange' },
  completion: { bg: '#fee2e2', fg: '#7f1d1d', label: 'holds completion' },
  none: { bg: '#f1f5f9', fg: '#475569', label: 'holds nothing' },
};
const STATUS_CHIP: Record<string, { bg: string; fg: string }> = {
  open: { bg: '#fef3c7', fg: '#78350f' },
  negotiating: { bg: '#e0e7ff', fg: '#3730a3' },
  resolved: { bg: '#dcfce7', fg: '#14532d' },
  withdrawn: { bg: '#f1f5f9', fg: '#94a3b8' },
  fatal: { bg: '#fee2e2', fg: '#7f1d1d' },
};
const chip = (c: { bg: string; fg: string }, text: string) => <span className="ep-pill" style={{ background: c.bg, color: c.fg, marginRight: 4 }}>{text}</span>;
const gbp = (p: number) => `£${(p / 100).toLocaleString('en-GB')}`;

export function IssuesPanel({ api, state, busy, cmd }: { api: Api; state: EngineState; busy: boolean; cmd: (body: Record<string, unknown>) => Promise<void> }) {
  const [cat, setCat] = useState<IssueCatalogue | null>(null);
  const [kind, setKind] = useState('survey_defect');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [gate, setGate] = useState<'default' | 'exchange' | 'completion' | 'none'>('default');
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolution, setResolution] = useState('');
  const [note, setNote] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [showClosed, setShowClosed] = useState(false);

  useEffect(() => {
    api<{ issues: IssueCatalogue }>('/engine/spec').then((s) => setCat(s.issues)).catch(() => setCat(null));
  }, [api]);

  const kinds = useMemo(() => cat?.kinds ?? [], [cat]);
  const byKind = useMemo(() => Object.fromEntries(kinds.map((k) => [k.kind, k])), [kinds]);
  const issues = Object.values(state.issues ?? {});
  const open = issues.filter((i) => i.status === 'open' || i.status === 'negotiating').sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
  const closed = issues.filter((i) => !(i.status === 'open' || i.status === 'negotiating')).sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));
  const exchanged = !!state.exchange.exchangedAt;
  const done = !!state.completion.confirmedAt || !!state.abandoned;
  const sel = byKind[kind];

  const startResolve = (i: IssueRow) => {
    setResolving(i.id);
    setResolution(byKind[i.kind]?.resolutions[0] ?? 'other');
    setNote('');
    setNewPrice('');
  };
  const submitResolve = async (i: IssueRow) => {
    const body: Record<string, unknown> = { type: 'resolve_issue', issueId: i.id, resolution, note: note || null };
    if (resolution === 'price_reduced') body.newPricePennies = Math.round(Number(newPrice.replace(/[^0-9.]/g, '')) * 100);
    await cmd(body);
    setResolving(null);
  };

  return (
    <>
      <div className="ep-sec">Issues — what is wrong and what it holds ({open.length} open{open.some((i) => i.gate !== 'none') ? ` · ${open.filter((i) => i.gate !== 'none').length} holding ${exchanged ? 'completion' : 'exchange'}` : ''})</div>
      <div className="ep-block" style={{ background: '#fff', borderColor: '#e6e8ee' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12.5, marginBottom: open.length ? 8 : 0 }}>
          <span><b>Price:</b> {state.purchasePricePennies != null ? gbp(state.purchasePricePennies) : 'not recorded'}</span>
          {!exchanged && !done && <button className="ep-btn" style={{ margin: 0 }} disabled={busy} onClick={() => { const p = window.prompt(state.purchasePricePennies != null ? 'New agreed price (£). A change on a lender-funded purchase will raise a lender-approval issue.' : 'Agreed purchase price (£)'); if (!p) return; const reason = state.purchasePricePennies != null ? window.prompt('Why did the price change?') : 'Agreed price'; if (!reason) return; void cmd({ type: 'record_price_change', toPennies: Math.round(Number(p.replace(/[^0-9.]/g, '')) * 100), reason }); }}>{state.purchasePricePennies != null ? 'Record price change' : 'Record agreed price'}</button>}
          <span><b>Ready to exchange?</b> {state.readiness?.contractApprovedAt ? `contract approved ${fmtDay(state.readiness.contractApprovedAt)}` : 'contract not yet approved'} · {state.readiness?.signedContractHeldAt ? `signed contract held ${fmtDay(state.readiness.signedContractHeldAt)}` : 'signed contract not held'}</span>
          {!exchanged && !done && ['contract_review', 'pre_exchange'].includes(state.stage) && !state.readiness?.contractApprovedAt && <button className="ep-btn" style={{ margin: 0 }} disabled={busy} onClick={() => cmd({ type: 'contract_approved' })}>Contract approved</button>}
          {!exchanged && !done && ['contract_review', 'pre_exchange'].includes(state.stage) && !state.readiness?.signedContractHeldAt && <button className="ep-btn" style={{ margin: 0 }} disabled={busy} onClick={() => cmd({ type: 'signed_contract_held' })}>Signed contract held</button>}
        </div>

        {open.map((i) => {
          const k = byKind[i.kind];
          const last = i.history[i.history.length - 1];
          return (
            <div key={i.id} style={{ borderTop: '1px solid #f1f5f9', padding: '8px 0', fontSize: 12.5 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <b>{i.id} · {k?.label ?? pretty(i.kind)}</b>
                {chip(STATUS_CHIP[i.status], i.status)}
                {chip(GATE_CHIP[i.gate], GATE_CHIP[i.gate].label)}
                <span style={{ color: '#64748b' }}>raised {fmtDay(i.raisedAt)} at {pretty(i.raisedAtStage)}{i.raisedBy === 'system' ? ' by the engine' : ''} · last touched {fmtDay(i.updatedAt)}</span>
              </div>
              <div style={{ marginTop: 2 }}>{i.title}{i.detail ? <span style={{ color: '#64748b' }}> — {i.detail}</span> : null}</div>
              {last && <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 2 }}>{last.what}</div>}
              {k?.note && i.status === 'open' && <div style={{ fontSize: 11.5, color: '#94a3b8', marginTop: 2 }}>{k.note}</div>}
              {resolving === i.id ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
                  <select className="ep-input" value={resolution} onChange={(e) => setResolution(e.target.value)}>
                    {(k?.resolutions ?? ['other']).map((r) => <option key={r} value={r}>{cat?.resolutions.find((x) => x.id === r)?.label ?? pretty(r)}</option>)}
                  </select>
                  {resolution === 'price_reduced' && <input className="ep-input" placeholder="New price (£)" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} style={{ width: 130 }} />}
                  <input className="ep-input" placeholder={resolution === 'other' || resolution === 'accepted_as_is' ? 'Note (required)' : 'Note'} value={note} onChange={(e) => setNote(e.target.value)} style={{ width: 280 }} />
                  <button className="ep-btn primary" style={{ margin: 0 }} disabled={busy || ((resolution === 'other' || resolution === 'accepted_as_is') && !note.trim()) || (resolution === 'price_reduced' && !newPrice)} onClick={() => void submitResolve(i)}>Resolve</button>
                  <button className="ep-btn" style={{ margin: 0 }} onClick={() => setResolving(null)}>Cancel</button>
                  {cat?.resolutions.find((x) => x.id === resolution)?.effects.length ? <div style={{ width: '100%', fontSize: 11.5, color: '#64748b' }}>Effect: {cat.resolutions.find((x) => x.id === resolution)!.effects.join('; ')}</div> : null}
                </div>
              ) : (
                <div style={{ marginTop: 4 }}>
                  {i.status === 'open' && <button className="ep-btn" disabled={busy} onClick={() => { const n = window.prompt('What is happening? (e.g. "client asked for £10k off; agent relaying")'); if (n) void cmd({ type: 'update_issue', issueId: i.id, status: 'negotiating', note: n }); }}>Negotiating…</button>}
                  <button className="ep-btn" disabled={busy} onClick={() => { const n = window.prompt('Progress note'); if (n) void cmd({ type: 'update_issue', issueId: i.id, status: i.status, note: n }); }}>Add note</button>
                  <button className="ep-btn primary" disabled={busy} onClick={() => startResolve(i)}>Resolve…</button>
                  {i.gate !== 'none' && <button className="ep-btn" disabled={busy} onClick={() => { const n = window.prompt(`Release the hold on ${i.gate}? Say why (the client accepts the risk, the lender is content…). The issue stays open.`); if (n) void cmd({ type: 'update_issue', issueId: i.id, status: i.status, gate: 'none', note: n }); }}>Release hold</button>}
                  {i.gate === 'none' && !exchanged && <button className="ep-btn" disabled={busy} onClick={() => { const n = window.prompt('Hold exchange again? Say why.'); if (n) void cmd({ type: 'update_issue', issueId: i.id, status: i.status, gate: 'exchange', note: n }); }}>Hold exchange</button>}
                  <button className="ep-btn" disabled={busy} onClick={() => { const n = window.prompt('Withdraw the issue (raised in error / overtaken)? Say why.'); if (n) void cmd({ type: 'withdraw_issue', issueId: i.id, reason: n }); }}>Withdraw</button>
                  <button className="ep-btn" style={{ color: '#b91c1c' }} disabled={busy} onClick={() => { const n = window.prompt('This ends the transaction: the issue is marked fatal and the matter abandoned. Say why.'); if (n && window.confirm('Abandon the matter over this issue?')) void cmd({ type: 'mark_issue_fatal', issueId: i.id, reason: n }); }}>Fatal — abandon</button>
                </div>
              )}
            </div>
          );
        })}
        {open.length === 0 && <div style={{ fontSize: 12.5, color: '#64748b', borderTop: '1px solid #f1f5f9', paddingTop: 8 }}>No open issues. Raise one when something the matter has to wait for comes up: a survey finding, a down-valuation, missing building regs, a chain that is not ready, probate, a gifted deposit…</div>}

        {!done && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 10, borderTop: '1px solid #f1f5f9', paddingTop: 8 }}>
            <select className="ep-input" value={kind} onChange={(e) => { setKind(e.target.value); setGate('default'); }} style={{ maxWidth: 260 }}>
              {(cat?.groups ?? []).map((g) => (
                <optgroup key={g.id} label={g.label}>
                  {kinds.filter((k) => k.group === g.id && k.kind !== 'lender_approval').map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                </optgroup>
              ))}
              {!cat && <option value="survey_defect">Survey defect</option>}
            </select>
            <input className="ep-input" placeholder="What is wrong (one line)" value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: 300 }} />
            <input className="ep-input" placeholder="Detail (optional)" value={detail} onChange={(e) => setDetail(e.target.value)} style={{ width: 220 }} />
            <select className="ep-input" value={gate} onChange={(e) => setGate(e.target.value as typeof gate)}>
              <option value="default">{sel ? `holds ${exchanged && sel.gate === 'exchange' ? 'completion' : sel.gate === 'none' ? 'nothing' : sel.gate} (default)` : 'default hold'}</option>
              {!exchanged && <option value="exchange">holds exchange</option>}
              <option value="completion">holds completion</option>
              <option value="none">holds nothing (track only)</option>
            </select>
            <button className="ep-btn primary" style={{ margin: 0 }} disabled={busy || !title.trim()} onClick={() => { void cmd({ type: 'raise_issue', kind, title: title.trim(), detail: detail.trim() || null, gate: gate === 'default' ? null : gate }); setTitle(''); setDetail(''); }}>Raise issue</button>
            {sel && <div style={{ width: '100%', fontSize: 11.5, color: '#64748b' }}>Arises from {sel.arisesFrom}.{sel.overlaps ? ` Already covered in part: ${sel.overlaps}.` : ''}</div>}
          </div>
        )}

        {closed.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <span style={{ cursor: 'pointer', color: '#64748b' }} onClick={() => setShowClosed((x) => !x)}>{showClosed ? '▾' : '▸'} {closed.length} closed issue{closed.length === 1 ? '' : 's'}</span>
            {showClosed && closed.map((i) => (
              <div key={i.id} style={{ borderTop: '1px solid #f1f5f9', padding: '5px 0', color: '#475569' }}>
                <b>{i.id} · {byKind[i.kind]?.label ?? pretty(i.kind)}</b> {chip(STATUS_CHIP[i.status], i.status)} {i.title}{i.resolution ? ` — ${cat?.resolutions.find((x) => x.id === i.resolution)?.label ?? pretty(i.resolution)}` : ''} <span style={{ color: '#94a3b8' }}>{fmtDay(i.resolvedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
