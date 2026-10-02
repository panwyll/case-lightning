'use client';
/**
 * The client's chain on a case page: the linked sale or purchase, where it is, what holds its
 * exchange, and when it completes, beside this case's own. Linking picks the other case from a
 * list (this firm's open cases on the other side); both are linked, and unlinked, together.
 */
import { useState } from 'react';
import { stageLabel, fmtDay, type Api, type EngineView } from './types';
import { ChainPicker, type ChainOption } from './ChainPicker';

type Candidate = ChainOption;

const CSS = `
.ch{margin-top:12px}
.ch-h{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.ch-h b{font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#64748b;margin-right:auto}
.ch-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ch-side{border:1px solid #e6e8ee;border-radius:10px;padding:9px 11px;min-width:0}
.ch-side .k{font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em}
.ch-side .a{display:block;font-size:13px;font-weight:700;color:#0f172a;margin:2px 0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none}
.ch-side a.a{color:#5A27E0}
.ch-side .l{font-size:12px;color:#475569;line-height:1.5}
.ch-side .l.ok{color:#15803d}
.ch-side .l.warn{color:#b45309}
.ch-btn{border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:7px;padding:4px 10px;font:inherit;font-size:12px;font-weight:700;cursor:pointer}
.ch-btn.go{border-color:#5A27E0;background:#5A27E0;color:#fff}
.ch-btn:disabled{opacity:.55;cursor:default}
.ch-sel{width:100%;border:1px solid #cbd5e1;border-radius:7px;padding:6px 8px;font:inherit;font-size:13px;margin:6px 0}
.ch-err{color:#b91c1c;font-size:12px;margin-top:4px}
.ch-links{margin-top:8px;display:flex;flex-direction:column;gap:4px}
.ch-link{display:flex;align-items:center;gap:8px;font-size:13px;color:#0f172a}
.ch-link span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ch-link select{border:1px solid #cbd5e1;border-radius:7px;padding:3px 6px;font:inherit;font-size:12px;font-weight:700}
.ch-link select.ready{color:#15803d;border-color:#86efac}
.ch-link select.not_ready{color:#b45309;border-color:#fcd34d}
.ch-add{display:flex;gap:6px}
.ch-add input{flex:1;border:1px solid #cbd5e1;border-radius:7px;padding:4px 8px;font:inherit;font-size:13px}
`;

const date = (iso: string | null | undefined) => (iso ? fmtDay(iso) : null);

export function ChainCard({ matterId, api, view, busy, cmd }: { matterId: string; api: Api; view: EngineView; busy: boolean; cmd: (body: Record<string, unknown>) => Promise<unknown> }) {
  const s = view.state;
  const side = view.profile?.side;
  const chain = view.chain ?? null;
  const [picking, setPicking] = useState<Candidate[] | null>(null);
  const [pick, setPick] = useState('');
  const [unlinking, setUnlinking] = useState(false);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const exchanged = !!s.exchange?.exchangedAt;
  if (side !== 'buyer' && side !== 'seller') return null;
  if (!chain && exchanged) return null;
  const want = side === 'buyer' ? 'Sale' : 'Purchase';

  const openPicker = async () => {
    setErr(null);
    try {
      const c = (await api<{ candidates: Candidate[] }>(`/matters/${matterId}/chain`)).candidates;
      setPicking(c);
      // The one case for this client is the likely answer: chosen, ready to link.
      const same = c.filter((x) => x.sameClient);
      if (same.length === 1) setPick(same[0].matterId);
    }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not load cases.'); }
  };
  const link = async () => {
    if (!pick) return;
    const ok = await cmd({ type: 'link_related_matter', relatedMatterId: pick });
    if (ok !== false) { setPicking(null); setPick(''); }
  };
  const unlink = async () => {
    if (!reason.trim()) return;
    const ok = await cmd({ type: 'unlink_related_matter', reason: reason.trim() });
    if (ok !== false) { setUnlinking(false); setReason(''); }
  };

  const ownHolding = view.blockers.slice(0, 3);
  const ownReady = exchanged || (s.stage === 'pre_exchange' && !!s.exchange?.conditionsMet);
  const ownCompletion = s.exchange?.completionDate ?? s.targetCompletionDate ?? null;
  const theirCompletion = chain ? chain.completionDate ?? chain.targetCompletion : null;
  const datesDiffer = !!(chain && ownCompletion && theirCompletion && ownCompletion.slice(0, 10) !== theirCompletion.slice(0, 10));

  return (
    <div className="ch">
      <style>{CSS}</style>
      <div className="ch-h">
        <b>Chain</b>
        {chain && !exchanged && !unlinking && <button type="button" className="ch-btn" disabled={busy} onClick={() => setUnlinking(true)}>Unlink</button>}
        {!chain && !picking && <button type="button" className="ch-btn go" disabled={busy} onClick={() => void openPicker()}>Link {want}</button>}
        {!exchanged && adding === null && <button type="button" className="ch-btn" disabled={busy} onClick={() => setAdding('')}>Add Link</button>}
      </div>
      {!chain && picking && (
        <div>
          {picking.length ? <ChainPicker options={picking} value={pick} onChange={setPick} want={want === 'Sale' ? 'sale' : 'purchase'} /> : <div className="ch-side"><span className="l">No open {want.toLowerCase()} on the system to link.</span></div>}
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            {picking.length > 0 && <button type="button" className="ch-btn go" disabled={busy || !pick} onClick={() => void link()}>Link</button>}
            <button type="button" className="ch-btn" onClick={() => { setPicking(null); setPick(''); }}>Cancel</button>
          </div>
        </div>
      )}
      {chain && (
        <div className="ch-grid">
          <div className="ch-side">
            <span className="k">This {side === 'buyer' ? 'purchase' : 'sale'}</span>
            <span className="a">{stageLabel(s.stage, view.profile)}</span>
            <span className={`l ${ownReady ? 'ok' : 'warn'}`}>{exchanged ? `Exchanged ${date(s.exchange.exchangedAt)}` : ownReady ? 'Ready to exchange' : `Held by: ${ownHolding.join('; ') || 'nothing listed'}`}</span>
            <span className="l" style={{ display: 'block' }}>{s.completion?.confirmedAt ? `Completed ${date(s.completion.confirmedAt)}` : ownCompletion ? `Completes ${date(ownCompletion)}${s.exchange?.completionDate ? '' : ' (target)'}` : 'No completion date yet'}</span>
          </div>
          <div className="ch-side">
            <span className="k">Linked {chain.relation}</span>
            <a className="a" href={`/conveyi/matters/${chain.matterId}`}>{chain.propertyAddress ?? chain.matterRef ?? 'the linked case'}</a>
            {!chain.readable ? <span className="l warn">Cannot be read from here.</span> : (
              <>
                <span className={`l ${chain.exchangeReady ? 'ok' : 'warn'}`}>{chain.abandoned ? 'Abandoned: this chain is broken' : chain.exchangedAt ? `Exchanged ${date(chain.exchangedAt)}` : chain.exchangeReady ? 'Ready to exchange' : `${stageLabel(chain.stage ?? '', undefined)} · held by: ${chain.holding.join('; ') || 'nothing listed'}`}</span>
                <span className={`l${datesDiffer ? ' warn' : ''}`} style={{ display: 'block' }}>{chain.completedAt ? `Completed ${date(chain.completedAt)}` : theirCompletion ? `Completes ${date(theirCompletion)}${chain.completionDate ? '' : ' (target)'}${datesDiffer ? ': not the same day as this one' : ''}` : 'No completion date yet'}</span>
              </>
            )}
          </div>
        </div>
      )}
      {!exchanged && ((s.chainLinks?.length ?? 0) > 0 || adding !== null) && (
        <div className="ch-links">
          {(s.chainLinks ?? []).map((l) => (
            <div key={l.id} className="ch-link">
              <span title={l.note ?? undefined}>{l.label}</span>
              <select className={l.status} aria-label={`${l.label}: status`} value={l.status} disabled={busy} onChange={(e) => void cmd({ type: 'record_chain_link', linkId: l.id, label: l.label, status: e.target.value })}>
                <option value="ready">Ready</option>
                <option value="not_ready">Not Ready</option>
                <option value="unknown">Unknown</option>
                <option value="removed">Remove</option>
              </select>
            </div>
          ))}
          {adding !== null && (
            <div className="ch-add">
              <input autoFocus placeholder="Who (e.g. the buyer of our seller's buyer)" value={adding} onChange={(e) => setAdding(e.target.value)} />
              <button type="button" className="ch-btn go" disabled={busy || !adding.trim()} onClick={async () => { const ok = await cmd({ type: 'record_chain_link', label: adding.trim(), status: 'unknown' }); if (ok !== false) setAdding(null); }}>Add</button>
              <button type="button" className="ch-btn" onClick={() => setAdding(null)}>Cancel</button>
            </div>
          )}
        </div>
      )}
      {chain && unlinking && (
        <div style={{ marginTop: 6 }}>
          <input className="ch-sel" autoFocus placeholder="Why (linked in error, it fell through)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="ch-btn go" disabled={busy || !reason.trim()} onClick={() => void unlink()}>Unlink Both</button>
            <button type="button" className="ch-btn" onClick={() => { setUnlinking(false); setReason(''); }}>Cancel</button>
          </div>
        </div>
      )}
      {err && <div className="ch-err">{err}</div>}
    </div>
  );
}
