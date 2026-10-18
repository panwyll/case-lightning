'use client';
/**
 * Which case an email belongs to: the cases it could be (with what points to each), File Here, a search for a different
 * case, and Not A Case. The Email page and Outlook's pane both show this, so filing reads and behaves the same in both.
 */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Home, Mail, X } from '@/app/shared/icons';

export const PICKER_CSS = `
.ef-cases{display:grid;gap:8px;margin-top:12px}
.ef-case{display:grid;grid-template-columns:auto 1fr auto;gap:3px 12px;align-items:center;border:1px solid #e6e8ee;border-radius:12px;padding:10px 12px;background:#fff}
.ef-case.top{border-color:#c4b5fd;background:#faf8ff}
.ef-case .ic{color:#7c3aed;display:flex;grid-row:span 2;align-self:start;margin-top:2px}
.ef-case .addr{font-size:14px;font-weight:800;color:#0f172a;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.ef-case .ref{font-size:11px;font-weight:600;color:#94a3b8}
.ef-case .who{font-size:12.5px;color:#475569;grid-column:2}
.ef-case .side{grid-row:1 / span 2;grid-column:3;display:flex;gap:8px;align-items:center}
.ef-case ul{grid-column:2 / -1;list-style:none;margin:3px 0 0;padding:0;display:flex;gap:3px 14px;flex-wrap:wrap}
.ef-case li{display:inline-flex;gap:5px;align-items:center;font-size:12px;color:#166534}
.ef-case li.amber{color:#b45309}
.ef-pct{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:800;border-radius:99px;padding:2px 8px;font-variant-numeric:tabular-nums;white-space:nowrap}
.ef-pct i{width:7px;height:7px;border-radius:99px;display:inline-block}
.ef-file{display:inline-flex;gap:6px;align-items:center;border:1px solid #5A27E0;background:#5A27E0;color:#fff;border-radius:9px;padding:7px 12px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap}
.ef-file.ghost{background:#fff;color:#5A27E0}
.ef-file:disabled{opacity:.5;cursor:not-allowed}
.ef-acts{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
.ef-alt{border:1px solid #e2e8f0;background:#fff;border-radius:9px;padding:7px 11px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;color:#334155;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.ef-alt:hover{background:#f8fafc}
.ef-alt:disabled{opacity:.5;cursor:not-allowed}
.ef-warn{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;margin-top:10px;border:1px solid #fecaca;background:#fef2f2;color:#991b1b;border-radius:12px;padding:10px 12px;font-size:12.5px;line-height:1.45}
.ef-warn b{font-size:13px}
.ef-pick{margin-top:10px;background:#f8fafc;border:1px solid #e6e8ee;border-radius:12px;padding:10px}
.ef-pick input{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #cbd5e1;border-radius:9px;font-size:13.5px;font-family:inherit;background:#fff}
.ef-hit{display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;text-align:left;border:1px solid transparent;background:#fff;border-radius:9px;padding:8px 12px;font-size:13px;cursor:pointer;font-family:inherit;margin-top:6px;color:#0f172a}
.ef-hit:hover{border-color:#c4b5fd;background:#f5f3ff}
.ef-hit .who{display:block;font-size:12px;color:#64748b;margin-top:2px}
`;

/**
 * The matching engine's own verdict, as a percentage and a colour. Green is AUTO — a
 * linked thread, our reference, or two independent signals agree; amber is STRONG; red
 * is WEAK, worth a look before filing.
 */
export const RAG: Record<string, { fg: string; bg: string; dot: string }> = {
  AUTO: { fg: '#166534', bg: '#dcfce7', dot: '#16a34a' },
  STRONG: { fg: '#92400e', bg: '#fef3c7', dot: '#d97706' },
  WEAK: { fg: '#991b1b', bg: '#fee2e2', dot: '#dc2626' },
};

export interface CaseCard { matterId: string; matterRef: string; propertyAddress: string | null; type: string; clients: string[]; stage: string | null; handler: string | null; otherSide: string | null; closed: boolean }
export interface Suggestion { matterId: string; matterRef: string; propertyAddress: string; band: string; score: number; case: CaseCard | null; matched: string[]; onThread?: boolean; senderOnCase?: 'contact' | 'firm' | 'seen' | 'none' }
interface Person { name: string | null; address: string | null }
export interface Item {
  id: string;
  conversationId: string | null;
  subject: string;
  from: Person;
  receivedDateTime: string | null;
  bodyPreview: string;
  forwardedFrom?: string | null;
  notCaseMail?: string | null;
  hasAttachments: boolean;
  webLink: string | null;
  suggestions: Suggestion[];
  sender?: { verdict: 'ok' | 'unverified' | 'suspicious'; warnings: string[] };
}
export interface MatterHit { id: string; matterRef: string; propertyAddress: string; case: CaseCard | null }

/** "Purchase for Priya Shah · Searches & enquiries · Alice Okafor" */
export const describe = (c: CaseCard | null) =>
  c ? [`${c.type}${c.clients.length ? ` for ${c.clients.join(' & ')}` : ''}`, c.closed ? 'Closed' : c.stage, c.handler].filter(Boolean).join(' · ') : '';

export function Pct({ s }: { s: Suggestion }) {
  const c = RAG[s.band] ?? RAG.WEAK;
  return <span className="ef-pct" style={{ color: c.fg, background: c.bg }}><i style={{ background: c.dot }} />{Math.round(s.score * 100)}%</span>;
}


export function CasePicker({ item, busy, onFile, onNotACase, searchCases, showOutlook = true }: {
  item: Item;
  busy: boolean;
  onFile: (matterId: string) => void;
  onNotACase: () => void;
  searchCases: (q: string) => Promise<MatterHit[]>;
  /** A link to the email in Outlook (not inside Outlook itself). */
  showOutlook?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<MatterHit[]>([]);
  // The latest search function, without re-running the search each time the caller re-renders.
  const search = useRef(searchCases);
  search.current = searchCases;
  useEffect(() => {
    if (!picking || q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(async () => { try { setHits(await search.current(q.trim())); } catch { setHits([]); } }, 220);
    return () => clearTimeout(t);
  }, [picking, q]);
  return (
    <>
      {item.sender?.verdict === 'suspicious' && (
        <div className="ef-warn" role="alert">
          <AlertTriangle size={16} />
          <b>Check this sender before acting on it</b>
          <span />
          <span>{item.sender.warnings.join(' ')} The sender has not been counted towards matching a case.</span>
        </div>
      )}
      {item.suggestions.length > 0 && (
        <div className="ef-cases">
          {item.suggestions.map((s, i) => (
            <div key={s.matterId} className={`ef-case${i === 0 ? ' top' : ''}`}>
              <span className="ic"><Home size={16} /></span>
              <span className="addr">{s.case?.propertyAddress ?? s.propertyAddress}<span className="ref">{s.matterRef}</span></span>
              <span className="side"><Pct s={s} /><button className={`ef-file${i === 0 && item.sender?.verdict !== 'suspicious' ? '' : ' ghost'}`} disabled={busy} onClick={() => onFile(s.matterId)}><Check size={16} /> File Here</button></span>
              <span className="who">{describe(s.case)}{s.case?.otherSide ? ` · other side ${s.case.otherSide}` : ''}</span>
              {(s.matched.length > 0 || (s.senderOnCase === 'none' && !s.onThread)) && (
                <ul>
                  {s.matched.map((m) => <li key={m}><Check size={16} />{m}</li>)}
                  {/* Names and addresses are public: say so when that is all there is. */}
                  {s.senderOnCase === 'none' && !s.onThread && <li className="amber"><AlertTriangle size={16} />Not from anyone on this case: only what it says matches</li>}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="ef-acts">
        <button className={item.suggestions.length ? 'ef-alt' : 'ef-file'} disabled={busy} onClick={() => setPicking((p) => !p)}>{picking ? 'Cancel' : item.suggestions.length ? 'A Different Case…' : 'Choose A Case…'}</button>
        <button className="ef-alt" disabled={busy} onClick={onNotACase}><X size={16} /> Not A Case</button>
        {showOutlook && item.webLink && <a className="ef-alt" href={item.webLink} target="_blank" rel="noopener noreferrer"><Mail size={16} /> Outlook</a>}
      </div>
      {picking && (
        <div className="ef-pick">
          <input autoFocus placeholder="Address, client's name or reference" value={q} onChange={(e) => setQ(e.target.value)} />
          {hits.map((m) => (
            <button key={m.id} className="ef-hit" disabled={busy} onClick={() => onFile(m.id)}>
              <span style={{ minWidth: 0 }}><b>{m.propertyAddress}</b><span className="who">{describe(m.case)}</span></span>
              <span style={{ color: '#94a3b8', fontSize: 11.5, whiteSpace: 'nowrap' }}>{m.matterRef}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
