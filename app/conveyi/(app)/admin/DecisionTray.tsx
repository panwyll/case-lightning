'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/app/shared/engine/api';
import { KIND_LABEL, pretty } from '@/app/shared/engine/types';
import { paths } from '@/lib/paths';
import { Check, ChevronRight, X } from '@/app/shared/icons';

/**
 * The decision tray. What a conveyancer opens instead of browsing cases: each card is one
 * thing only they can decide, pre-digested, with what approving it does. Approve → next.
 *
 * The source gate stands: Approve opens the source here on the card and comes alive once
 * it has been read (a scroll, or a few seconds), which is what the server checks too.
 * Anything that needs a reason, a method or a line-by-line pick goes to Review.
 */
interface Row {
  eventId: string;
  kind: string;
  subject: string | null;
  summary: string;
  options: string[];
  citations: Array<{ documentId: string; label: string; quote?: string | null }>;
  matterId: string;
  matterRef: string | null;
  propertyAddress: string | null;
  assignedTo?: string | null;
  createdAt: string;
  sourceOpenedByMe: boolean;
}
interface SourceDoc { id: string; fileName: string | null; webUrl: string | null; content: string | null; rawUrl: string | null }

/** What "approve" does, in the reader's words, by decision kind. */
const PROPOSED: Record<string, string[]> = {
  enquiry: ['Mark the reply satisfactory', 'Close the enquiry', 'Outstanding enquiries go down by one'],
  search: ['Mark the search satisfactory', 'Clear it from the exchange gate', 'Note it for the report on title'],
  mortgage: ['Accept the offer as it stands', 'Mark the mortgage workstream satisfactory'],
  title: ['Mark the title satisfactory', 'Unblock the report on title'],
  id_check: ['Accept the ID / AML result', 'Clear it from the exchange gate'],
  report_on_title: ['Approve the draft', 'Queue it to send to the client'],
  escalation: ['Accept the position as it stands', 'Close the escalation'],
  proof_of_funds: ['Sign off the source of funds', 'Clear it from the exchange gate'],
  management_pack: ['Mark the management pack satisfactory'],
  requisition: ["Accept HM Land Registry's point", 'Send the reply'],
  auto_clear: ["Confirm the engine's reading"],
  proposal: ['Perform the proposed action'],
};
/** These need more than a button: a method, a reason or a pick. */
const REVIEW_ONLY = new Set(['bank_details', 'note_actions']);
const DWELL_MS = 6000;

const CSS = `
.dt{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.dt-head{display:flex;align-items:baseline;gap:10px}
.dt-head h2{font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#64748b;margin:0}
.dt-head .n{font-size:12px;color:#94a3b8;font-variant-numeric:tabular-nums}
.dt-card{display:grid;grid-template-columns:1fr auto;gap:8px 16px;align-items:center;background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:12px 16px;transition:opacity .18s,transform .18s}
.dt-card.going{opacity:0;transform:translateX(24px)}
.dt-main{min-width:0}
.dt-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dt-addr{font-size:14px;font-weight:800;color:#0f172a}
.dt-kind{font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#5A27E0;background:#ede9fe;border-radius:999px;padding:2px 8px}
.dt-sum{font-size:13px;color:#334155;margin:4px 0 0;line-height:1.45}
.dt-prop{display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;font-size:12px;color:#475569}
.dt-prop span{display:inline-flex;align-items:center;gap:4px}
.dt-prop svg{color:#16a34a}
.dt-acts{display:flex;gap:8px;align-items:center}
.dt-btn{border:1px solid #cbd5e1;background:#fff;border-radius:9px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;color:#0f172a;text-decoration:none;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.dt-btn.go{background:#5A27E0;color:#fff;border-color:#5A27E0}
.dt-btn:disabled{opacity:.45;cursor:not-allowed}
.dt-src{grid-column:1 / -1;position:relative;border:1px solid #e6e8ee;border-radius:10px;background:#fafafa;max-height:300px;overflow:auto;padding:12px 14px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;color:#334155}
.dt-src iframe{width:100%;height:280px;border:0;background:#fff}
.dt-x{position:sticky;top:0;float:right;border:1px solid #e2e8f0;background:#fff;border-radius:7px;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:#64748b}
.dt-err{color:#b91c1c;font-size:12.5px;margin-top:6px}
@media (max-width:760px){.dt-card{grid-template-columns:1fr}}
`;

function Card({ d, onDone }: { d: Row; onDone: (id: string) => void }) {
  const [source, setSource] = useState<SourceDoc | null>(null);
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [dwell, setDwell] = useState(0);
  const [going, setGoing] = useState(false);
  const shownAt = useRef<number | null>(null);
  const quick = d.options.includes('approve') && !REVIEW_ONLY.has(d.kind);
  const engaged = scrolled || dwell >= DWELL_MS;

  // Time spent with the source in view is the second way through the gate.
  useEffect(() => {
    if (!source) return;
    shownAt.current = Date.now();
    const t = setInterval(() => { if (shownAt.current) setDwell(Date.now() - shownAt.current); }, 500);
    return () => clearInterval(t);
  }, [source]);

  const openSource = async () => {
    setOpening(true); setErr(null);
    try {
      const r = await api<{ document: SourceDoc }>(`/decisions/${d.eventId}/open-source`, { method: 'POST', body: '{}' });
      setSource(r.document);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not open the source.');
    } finally {
      setOpening(false);
    }
  };

  const approve = async () => {
    setBusy(true); setErr(null);
    try {
      await api(`/decisions/${d.eventId}/resolve`, { method: 'POST', body: JSON.stringify({ option: 'approve', note: null, verification: null, engagement: { scrolledSource: scrolled, dwellMs: dwell }, selection: null }) });
      setGoing(true);
      setTimeout(() => onDone(d.eventId), 190);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not record the decision.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`dt-card${going ? ' going' : ''}`}>
      <div className="dt-main">
        <div className="dt-top">
          <span className="dt-addr">{d.propertyAddress ?? d.matterRef ?? 'Case'}</span>
          <span className="dt-kind">{KIND_LABEL[d.kind] ?? pretty(d.kind)}{subjectLabel(d.subject)}</span>
        </div>
        <p className="dt-sum">{headline(d.summary)}</p>
        {quick && PROPOSED[d.kind] && (
          <div className="dt-prop">{PROPOSED[d.kind].map((line) => <span key={line}><Check size={12} />{line}</span>)}</div>
        )}
        {err && <div className="dt-err">{err}</div>}
      </div>
      <div className="dt-acts">
        {quick && !source && <button className="dt-btn go" disabled={opening} onClick={openSource}>Approve</button>}
        {quick && source && <button className="dt-btn go" disabled={!engaged || busy} onClick={approve} title={engaged ? '' : 'Read the source first'}><Check size={14} /> Approve</button>}
        <a className="dt-btn" href={paths.decision(d.eventId)}>Review <ChevronRight size={14} /></a>
      </div>
      {source && (
        <div className="dt-src" onScroll={() => setScrolled(true)}>
          <button className="dt-x" onClick={() => setSource(null)} aria-label="Hide source"><X size={13} /></button>
          {source.rawUrl ? <iframe title={source.fileName ?? 'Source'} src={source.rawUrl} /> : source.content ? source.content : source.webUrl ? <a href={source.webUrl} target="_blank" rel="noopener noreferrer">{source.fileName ?? 'Open the source'}</a> : null}
        </div>
      )}
    </div>
  );
}

/** A subject worth showing (E2, LLC1, POF-4); internal ids are not. */
function subjectLabel(subject: string | null): string {
  const s = subject?.replace(/^[a-z_]+:/, '') ?? '';
  return s && !/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) ? ` · ${s}` : '';
}

/**
 * The one line that says what is wrong. Engine summaries lead with a count ("1 item needs a
 * decision"), number their points and tag severity; the first point, clean, is the news.
 */
function headline(summary: string): string {
  const lines = summary.split('\n').map((l) => l.trim()).filter(Boolean);
  const point = lines.find((l) => /^\d+\.\s/.test(l)) ?? lines[0] ?? '';
  return point
    .replace(/^\d+\.\s*/, '')
    .replace(/\[(LOW|MEDIUM|HIGH|CRITICAL)\]\s*/gi, '')
    .replace(/\s*\((see [^)]*)\)/gi, '')
    .trim();
}

export default function DecisionTray({ userId, all }: { userId: string; all: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<{ decisions: Row[] }>('/decisions?limit=100');
      // Advisory auto-clear reviews do not require anyone; they stay on the matter's own page.
      setRows(r.decisions.filter((d) => d.kind !== 'auto_clear' && (all || !d.assignedTo || d.assignedTo === userId)));
    } catch { setRows([]); }
  }, [all, userId]);
  useEffect(() => { void load(); }, [load]);
  if (!rows || rows.length === 0) return null;
  return (
    <div className="dt">
      <style>{CSS}</style>
      <div className="dt-head"><h2>Needs you</h2><span className="n">{rows.length}</span></div>
      {rows.map((d) => <Card key={d.eventId} d={d} onDone={(id) => setRows((cur) => (cur ?? []).filter((x) => x.eventId !== id))} />)}
    </div>
  );
}
