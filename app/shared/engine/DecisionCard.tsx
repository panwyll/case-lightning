'use client';
import { useState } from 'react';
import { KIND_LABEL, OPTION_LABEL, fmtWhen, pretty, type Api, type DecisionRow, type SourceDoc } from './types';

/**
 * One decision, the way the spec wants it seen: the pre-digested summary, the source
 * it cites, and the options — with the options LOCKED until the handler has opened the
 * source. The lock is also enforced server-side (412), so this is UX for an invariant,
 * not the invariant itself. Inline preview shows engine-generated text (report drafts,
 * escalation dossiers) or embeds the OneDrive file when a web URL exists.
 */
export const DECISION_CSS = `
.dc-card{background:#fff;border:1px solid #e6e8ee;border-left:4px solid #f59e0b;border-radius:12px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(16,24,40,.06);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a}
.dc-card.opened{border-left-color:#16a34a}
.dc-card.compact{padding:10px 12px;margin-bottom:8px}
.dc-top{display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap}
.dc-kind{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#b45309}
.dc-ref{font-size:14px;font-weight:700}
.dc-meta{font-size:12px;color:#94a3b8}
.dc-sum{white-space:pre-wrap;font-size:13.5px;line-height:1.5;margin:10px 0;background:#f8fafc;border-radius:8px;padding:10px 12px;max-height:340px;overflow:auto}
.dc-cite{font-size:12.5px;color:#475569;margin:3px 0}
.dc-btn{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:7px 11px;font-size:13px;cursor:pointer;margin:4px 6px 0 0;font-family:inherit}
.dc-btn.primary{background:#0f172a;color:#fff;border-color:#0f172a}
.dc-btn:disabled{opacity:.45;cursor:not-allowed}
.dc-src{border:1px dashed #cbd5e1;border-radius:8px;padding:10px 12px;margin:10px 0;font-size:12.5px;background:#fffbeb}
.dc-src pre{white-space:pre-wrap;font-size:12px;max-height:320px;overflow:auto;margin:8px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dc-src iframe{width:100%;height:420px;border:1px solid #e2e8f0;border-radius:6px;margin-top:8px;background:#fff}
.dc-note{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font-size:13px;margin-top:8px;font-family:inherit}
.dc-warn{font-size:12px;color:#b45309;margin-top:8px}
.dc-err{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 10px;font-size:12.5px;margin-top:8px}
.dc-quote{font-style:italic;color:#64748b}
`;

export function DecisionCard({ decision: d, api, onResolved, compact = false, showMatter = true }: { decision: DecisionRow; api: Api; onResolved?: (d: DecisionRow) => void; compact?: boolean; showMatter?: boolean }) {
  const [opened, setOpened] = useState(!!d.sourceOpenedByMe);
  const [source, setSource] = useState<SourceDoc | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(!compact);

  const openSource = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ document: SourceDoc }>(`/decisions/${d.eventId}/open-source`, { method: 'POST', body: '{}' });
      setSource(r.document);
      setOpened(true);
      if (r.document.webUrl && !r.document.content) window.open(r.document.webUrl, '_blank', 'noopener');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not open the source.');
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (option: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/decisions/${d.eventId}/resolve`, { method: 'POST', body: JSON.stringify({ option, note: note || null }) });
      onResolved?.(d);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not resolve.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`dc-card${opened ? ' opened' : ''}${compact ? ' compact' : ''}`}>
      <div className="dc-top" onClick={() => compact && setExpanded((x) => !x)} style={compact ? { cursor: 'pointer' } : undefined}>
        <div>
          <div className="dc-kind">{KIND_LABEL[d.kind] ?? pretty(d.kind)}{d.subject ? ` · ${d.subject}` : ''}</div>
          {showMatter && <div className="dc-ref">{d.matterRef ?? d.matterId}{d.propertyAddress ? ` — ${d.propertyAddress}` : ''}</div>}
        </div>
        <div className="dc-meta">{pretty(d.stage)} · {fmtWhen(d.createdAt)} · by {d.summarisedBy}</div>
      </div>
      {expanded && (
        <>
          <div className="dc-sum">{d.summary}</div>
          <div>
            {d.citations.map((c, i) => (
              <div key={i} className="dc-cite">
                ↳ {c.label}
                {c.locator?.page ? ` (page ${c.locator.page}${c.locator.section ? `, ${c.locator.section}` : ''})` : ''}
                {c.locator?.quote ? <span className="dc-quote"> — “{c.locator.quote}”</span> : null}
              </div>
            ))}
          </div>
          <button className="dc-btn primary" disabled={busy} onClick={openSource}>{opened ? 'Source opened ✓ — open again' : 'Open source document'}</button>
          {source && (
            <div className="dc-src">
              <strong>{source.fileName ?? source.id}</strong> {source.docType ? `· ${pretty(source.docType.toLowerCase())}` : ''}{' '}
              {source.webUrl ? <a href={source.webUrl} target="_blank" rel="noopener noreferrer">open in OneDrive</a> : null}
              {source.content ? <pre>{source.content}</pre> : source.webUrl ? <iframe title="source document" src={source.webUrl} /> : <div className="dc-warn">No inline preview — read the file itself before deciding.</div>}
            </div>
          )}
          <textarea className="dc-note" rows={2} placeholder="Note for the record (what you checked, why)…" value={note} onChange={(e) => setNote(e.target.value)} />
          <div>
            {d.options.map((o) => (
              <button key={o} className="dc-btn" disabled={!opened || busy} title={opened ? '' : 'Open the source document first'} onClick={() => resolve(o)}>
                {OPTION_LABEL[o] ?? pretty(o)}
              </button>
            ))}
          </div>
          {!opened && <div className="dc-warn">Decisions are recorded against you by name. Open the source first — the buttons unlock once you have.</div>}
          {err && <div className="dc-err">{err}</div>}
        </>
      )}
    </div>
  );
}
