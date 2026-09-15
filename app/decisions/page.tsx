'use client';
import { useCallback, useEffect, useState } from 'react';

/**
 * Case-handler decision feed — the thinnest real version of component #6 ("Spark
 * Notes"). It lists ONLY the engine's pending decision events, each with the
 * pre-digested summary, the source it cites and the options. The resolve buttons stay
 * disabled until the handler has opened the source document: that friction is the
 * point (it stops rubber-stamping), and the server enforces it too (412 otherwise).
 *
 * Deliberately minimal — the Outlook add-in / admin board will host this later.
 */

interface Citation { documentId: string; label: string; locator?: { page?: number; section?: string } }
interface DecisionRow {
  eventId: string;
  matterId: string;
  matterRef: string | null;
  propertyAddress: string | null;
  stage: string;
  kind: string;
  subject: string | null;
  summary: string;
  sourceDocumentId: string;
  citations: Citation[];
  options: string[];
  createdAt: string;
  summarisedBy: string;
  sourceOpenedByMe: boolean;
}
interface SourceDoc { id: string; fileName: string | null; webUrl: string | null; docType: string | null; content: string | null }

const OPTION_LABEL: Record<string, string> = {
  approve: 'Approve — proceed as standard',
  refer_to_client: 'Refer to client',
  request_further: 'Request further search / enquiry',
  escalate: 'Escalate to senior',
  reject: 'Reject',
};

const KIND_LABEL: Record<string, string> = {
  search: 'Search result',
  enquiry: 'Enquiry reply',
  mortgage: 'Mortgage offer',
  title: 'Title register',
  id_check: 'ID / AML',
  report_on_title: 'Report on title — approve draft',
  escalation: 'Escalation',
};

const CSS = `
.dc-wrap{max-width:900px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a}
.dc-h1{font-size:22px;font-weight:800;margin:0 0 4px}
.dc-sub{color:#64748b;font-size:13px;margin:0 0 20px}
.dc-card{background:#fff;border:1px solid #e6e8ee;border-left:4px solid #f59e0b;border-radius:12px;padding:16px;margin-bottom:14px;box-shadow:0 1px 3px rgba(16,24,40,.06)}
.dc-card.opened{border-left-color:#16a34a}
.dc-top{display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap}
.dc-kind{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#b45309}
.dc-ref{font-size:14px;font-weight:700}
.dc-meta{font-size:12px;color:#94a3b8}
.dc-sum{white-space:pre-wrap;font-size:13.5px;line-height:1.5;margin:12px 0;background:#f8fafc;border-radius:8px;padding:10px 12px}
.dc-cite{font-size:12.5px;color:#475569;margin:4px 0}
.dc-btn{border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:7px 11px;font-size:13px;cursor:pointer;margin:4px 6px 0 0}
.dc-btn.primary{background:#0f172a;color:#fff;border-color:#0f172a}
.dc-btn:disabled{opacity:.45;cursor:not-allowed}
.dc-src{border:1px dashed #cbd5e1;border-radius:8px;padding:10px 12px;margin:10px 0;font-size:12.5px;background:#fffbeb}
.dc-src pre{white-space:pre-wrap;font-size:12px;max-height:260px;overflow:auto;margin:8px 0 0}
.dc-note{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font-size:13px;margin-top:8px;font-family:inherit}
.dc-warn{font-size:12px;color:#b45309;margin-top:8px}
.dc-err{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px;font-size:13px}
.dc-empty{color:#64748b;font-size:14px;padding:30px;text-align:center;border:1px dashed #e2e8f0;border-radius:12px}
`;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, { credentials: 'include', headers: { 'content-type': 'application/json' }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body as T;
}

export default function DecisionsPage() {
  const [rows, setRows] = useState<DecisionRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, SourceDoc>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<{ decisions: DecisionRow[] }>('/decisions');
      setRows(d.decisions);
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load decisions.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openSource = async (d: DecisionRow) => {
    setBusy(d.eventId);
    try {
      const r = await api<{ document: SourceDoc }>(`/decisions/${d.eventId}/open-source`, { method: 'POST', body: '{}' });
      setSources((s) => ({ ...s, [d.eventId]: r.document }));
      setRows((rs) => (rs ? rs.map((x) => (x.eventId === d.eventId ? { ...x, sourceOpenedByMe: true } : x)) : rs));
      if (r.document.webUrl) window.open(r.document.webUrl, '_blank', 'noopener');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not open the source.');
    } finally {
      setBusy(null);
    }
  };

  const resolve = async (d: DecisionRow, option: string) => {
    setBusy(d.eventId);
    try {
      await api(`/decisions/${d.eventId}/resolve`, { method: 'POST', body: JSON.stringify({ option, note: notes[d.eventId] || null }) });
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not resolve.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dc-wrap">
      <style>{CSS}</style>
      <h1 className="dc-h1">Decisions</h1>
      <p className="dc-sub">Only what needs a person. Everything routine has already been handled and logged. Open the source before you decide — the buttons unlock once you have.</p>
      {err && <div className="dc-err">{err}</div>}
      {rows === null && !err && <div className="dc-empty">Loading…</div>}
      {rows && rows.length === 0 && <div className="dc-empty">Nothing waiting on you.</div>}
      {rows?.map((d) => {
        const src = sources[d.eventId];
        const opened = d.sourceOpenedByMe;
        return (
          <div key={d.eventId} className={`dc-card${opened ? ' opened' : ''}`}>
            <div className="dc-top">
              <div>
                <div className="dc-kind">{KIND_LABEL[d.kind] ?? d.kind}{d.subject ? ` · ${d.subject}` : ''}</div>
                <div className="dc-ref">{d.matterRef ?? d.matterId}{d.propertyAddress ? ` — ${d.propertyAddress}` : ''}</div>
              </div>
              <div className="dc-meta">stage {d.stage.replace(/_/g, ' ')} · raised {new Date(d.createdAt).toLocaleString('en-GB')} · summary by {d.summarisedBy}</div>
            </div>
            <div className="dc-sum">{d.summary}</div>
            <div>
              {d.citations.map((c, i) => (
                <div key={i} className="dc-cite">
                  ↳ {c.label}
                  {c.locator?.page ? ` (page ${c.locator.page}${c.locator.section ? `, ${c.locator.section}` : ''})` : ''}
                </div>
              ))}
            </div>
            <button className="dc-btn primary" disabled={busy === d.eventId} onClick={() => openSource(d)}>
              {opened ? 'Source opened ✓ — open again' : 'Open source document'}
            </button>
            {src && (
              <div className="dc-src">
                <strong>{src.fileName ?? src.id}</strong> {src.docType ? `· ${src.docType}` : ''} {src.webUrl ? <a href={src.webUrl} target="_blank" rel="noopener noreferrer">open file</a> : null}
                {src.content ? <pre>{src.content}</pre> : <div className="dc-warn">No inline preview — read the file itself before deciding.</div>}
              </div>
            )}
            <textarea className="dc-note" rows={2} placeholder="Note for the record (what you checked, why)…" value={notes[d.eventId] ?? ''} onChange={(e) => setNotes((n) => ({ ...n, [d.eventId]: e.target.value }))} />
            <div>
              {d.options.map((o) => (
                <button key={o} className="dc-btn" disabled={!opened || busy === d.eventId} title={opened ? '' : 'Open the source document first'} onClick={() => resolve(d, o)}>
                  {OPTION_LABEL[o] ?? o}
                </button>
              ))}
            </div>
            {!opened && <div className="dc-warn">Decisions are recorded against you by name. Open the source first.</div>}
          </div>
        );
      })}
    </div>
  );
}
