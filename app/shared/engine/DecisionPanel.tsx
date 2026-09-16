'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { ENGINE_CSS } from './ui';
import { KIND_LABEL, OPTION_LABEL, STAGE_LABEL, VERIFICATION_METHOD_LABEL, fmtWhen, pretty, type Citation, type DecisionDetail, type Engagement, type SourceDoc } from './types';

/**
 * Addendum 3 §3 — the decision panel. A fixed three-part vertical layout:
 *
 *   1. the AI summary, with inline citation markers that jump to the cited place in
 *      the source (page for a PDF, highlighted passage for text);
 *   2. the source, rendered INLINE and visible without a click — auto-scrolled to the
 *      cited locator and highlighted;
 *   3. the action row: the decision's options. Anything other than approve/verify asks
 *      for a reason, stored on the resolving event.
 *
 * No action is enabled until the handler has engaged with the source section: scrolled
 * it, or dwelt on it while it is in view. The engagement is sent with the resolution
 * and checked again server-side (412). Opening the panel on a pending decision logs
 * decision_source_opened (the source IS shown); a resolved decision is read-only.
 */
const CSS = `
.dp{display:grid;grid-template-rows:auto minmax(0,1fr) auto;height:100dvh;height:100vh;box-sizing:border-box}
.dp-part{padding:12px 16px;border-bottom:1px solid #e6e8ee;background:#fff}
.dp-part.summary{max-height:42vh;overflow:auto}
.dp-part.source{min-height:0;overflow:auto;background:#fafafa;border-bottom:1px solid #e6e8ee;position:relative}
.dp-part.actions{border-bottom:0;box-shadow:0 -2px 10px rgba(16,24,40,.06);padding-bottom:calc(12px + env(safe-area-inset-bottom,0px))}
.dp-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap;margin-bottom:8px}
.dp-kind{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#b45309}
.dp-title{font-size:16px;font-weight:800;margin:2px 0 0}
.dp-sum{white-space:pre-wrap;font-size:14px;line-height:1.55;max-width:72ch}
.dp-cite{display:inline-block;font-size:10.5px;font-weight:800;vertical-align:super;line-height:1;margin-left:2px;color:#5A27E0;background:#ede9fe;border-radius:4px;padding:2px 5px;cursor:pointer;border:0;font-family:inherit}
.dp-cite.on{background:#5A27E0;color:#fff}
.dp-cites{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.dp-cites button{font-size:12px;border:1px solid #ddd6fe;background:#f5f3ff;color:#4c1d95;border-radius:8px;padding:4px 8px;cursor:pointer;font-family:inherit}
.dp-srcbar{position:sticky;top:0;z-index:2;background:rgba(250,250,250,.95);backdrop-filter:blur(4px);padding:8px 16px;font-size:12px;color:#64748b;display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #eef2f7}
.dp-srcbody{padding:12px 16px}
.dp-pre{white-space:pre-wrap;font-size:12.5px;line-height:1.55;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;max-width:90ch}
.dp-pre mark{background:#fef08a;border-radius:3px;padding:1px 2px;box-shadow:0 0 0 2px #fef08a}
.dp-pre mark.on{background:#fde047;box-shadow:0 0 0 3px #fde047}
.dp-frame{width:100%;height:calc(100% - 4px);min-height:520px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}
.dp-gate{font-size:12px;color:#64748b;display:flex;gap:8px;align-items:center}
.dp-gate .bar{height:4px;width:120px;background:#e2e8f0;border-radius:4px;overflow:hidden}
.dp-gate .bar i{display:block;height:100%;background:#5A27E0;transition:width .3s}
.dp-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dp-out{background:#f8fafc;border:1px solid #e6e8ee;border-radius:10px;padding:10px 12px;font-size:13px}
.dp-out b{font-weight:800}
.dp-lock{background:#fffbeb;border:1px solid #fde68a;color:#78350f;border-radius:8px;padding:8px 10px;font-size:12.5px}
.dp-shadow{background:#312e81;color:#fff;border-radius:8px;padding:8px 10px;font-size:12.5px}
`;

const UI_DWELL_MS = 8000;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Attach a citation marker to the first summary line that mentions it (section, label word, or a piece of the quote). */
function attachCitations(summary: string, citations: Citation[]): Array<{ line: string; marks: number[] }> {
  const lines = summary.split('\n');
  const out = lines.map((line) => ({ line, marks: [] as number[] }));
  citations.forEach((c, i) => {
    const needles = [c.locator?.section, c.locator?.quote?.slice(0, 40), c.label.replace(/^[A-Z ·]+/, '').trim()].filter((x): x is string => !!x && x.length > 2).map(norm);
    const idx = out.findIndex(({ line }) => {
      const l = norm(line);
      return needles.some((n) => l.includes(n) || n.includes(l.slice(0, 30)) && l.length > 10);
    });
    if (idx >= 0) out[idx].marks.push(i);
  });
  return out;
}

export function DecisionPanel({ eventId }: { eventId: string }) {
  const [detail, setDetail] = useState<DecisionDetail | null>(null);
  const [source, setSource] = useState<SourceDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [activeCite, setActiveCite] = useState<number | null>(null);
  const [page, setPage] = useState<number | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // engagement
  const [scrolled, setScrolled] = useState(false);
  const [dwell, setDwell] = useState(0);
  const srcRef = useRef<HTMLDivElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const visibleRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const d = await api<DecisionDetail>(`/decisions/${eventId}`);
      setDetail(d);
      setErr(null);
      if (d.decision.status === 'pending' && !d.shadowed) {
        // The source is shown, so the opening is logged (this is the spec's "open the source" precondition).
        const r = await api<{ document: SourceDoc }>(`/decisions/${eventId}/open-source`, { method: 'POST', body: '{}' });
        setSource(r.document);
      } else {
        setSource(d.source);
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load the decision.');
    }
  }, [eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Dwell: count time while the source section is at least half in view and the tab is visible.
  useEffect(() => {
    const el = srcRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => (visibleRef.current = entries.some((x) => x.intersectionRatio >= 0.5)), { threshold: [0, 0.5, 1] });
    io.observe(el);
    const t = setInterval(() => {
      if (visibleRef.current && document.visibilityState === 'visible') setDwell((d) => d + 250);
    }, 250);
    return () => {
      io.disconnect();
      clearInterval(t);
    };
  }, [detail]);

  const d = detail?.decision ?? null;
  const pending = d?.status === 'pending' && !detail?.shadowed && !done;
  const engaged = scrolled || dwell >= UI_DWELL_MS;
  const isBank = d?.kind === 'bank_details';
  const needsReason = (o: string) => o !== 'approve' && o !== 'verify';
  const lines = useMemo(() => (d ? attachCitations(d.summary, d.citations) : []), [d]);
  const unplaced = useMemo(() => (d ? d.citations.map((_, i) => i).filter((i) => !lines.some((l) => l.marks.includes(i))) : []), [d, lines]);

  /** Jump the source to a citation: PDF → page; text → highlighted passage. */
  const jump = useCallback(
    (i: number) => {
      if (!d) return;
      const c = d.citations[i];
      setActiveCite(i);
      if (source?.rawUrl) {
        setPage(c.locator?.page ?? 1);
        return;
      }
      const pre = preRef.current;
      if (!pre) return;
      const marks = Array.from(pre.querySelectorAll('mark')) as HTMLElement[];
      marks.forEach((m) => m.classList.remove('on'));
      const target = marks.find((m) => m.dataset.cite === String(i)) ?? marks[0];
      if (target) {
        target.classList.add('on');
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    },
    [d, source]
  );

  // Highlighted text source: wrap each citation's quote/section in <mark data-cite>.
  const highlighted = useMemo(() => {
    if (!d || !source?.content) return null;
    const content = source.content;
    const spans: Array<{ start: number; end: number; cite: number }> = [];
    const locs: Array<{ cite: number; text: string }> = [];
    const primary = d.sourceLocator;
    if (primary?.quote) locs.push({ cite: -1, text: primary.quote });
    else if (primary?.section) locs.push({ cite: -1, text: primary.section });
    d.citations.forEach((c, i) => {
      if (c.documentId !== source.id) return;
      if (c.locator?.quote) locs.push({ cite: i, text: c.locator.quote });
      else if (c.locator?.section) locs.push({ cite: i, text: c.locator.section });
    });
    const lower = content.toLowerCase();
    for (const l of locs) {
      const needle = l.text.toLowerCase().slice(0, 120);
      const at = lower.indexOf(needle);
      if (at >= 0 && !spans.some((s) => at < s.end && at + needle.length > s.start)) spans.push({ start: at, end: at + needle.length, cite: l.cite });
    }
    spans.sort((a, b) => a.start - b.start);
    const parts: Array<string | { text: string; cite: number }> = [];
    let cur = 0;
    for (const s of spans) {
      parts.push(content.slice(cur, s.start));
      parts.push({ text: content.slice(s.start, s.end), cite: s.cite });
      cur = s.end;
    }
    parts.push(content.slice(cur));
    return parts;
  }, [d, source]);

  // On load: auto-scroll to the primary locator (page for PDFs, first mark for text).
  useEffect(() => {
    if (!d || !source) return;
    if (source.rawUrl) setPage(d.sourceLocator?.page ?? 1);
    else {
      const t = setTimeout(() => {
        const first = preRef.current?.querySelector('mark') as HTMLElement | null;
        first?.classList.add('on');
        first?.scrollIntoView({ block: 'center' });
      }, 50);
      return () => clearTimeout(t);
    }
  }, [d, source]);

  const resolve = async (option: string) => {
    if (!d) return;
    setBusy(true);
    setErr(null);
    try {
      const engagement: Engagement = { scrolledSource: scrolled, dwellMs: dwell };
      await api(`/decisions/${eventId}/resolve`, { method: 'POST', body: JSON.stringify({ option, note: note.trim() || null, verification: isBank && option === 'verify' ? { method, reference: reference || null } : null, engagement }) });
      setDone(option);
      await load();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not record the decision.');
    } finally {
      setBusy(false);
    }
  };

  if (!detail || !d) {
    return (
      <div className="eg" style={{ padding: 24 }}>
        <style>{ENGINE_CSS + CSS}</style>
        {err ? <div className="eg-err">{err}</div> : <div className="eg-sub">Loading…</div>}
      </div>
    );
  }
  const who = (id: string | null | undefined) => (id ? detail.people[id] ?? (id === 'system' ? 'engine' : id === 'ai' ? 'AI' : id.slice(0, 8)) : '—');
  const res = detail.resolution;
  const pdfSrc = source?.rawUrl ? `${source.rawUrl}#page=${page ?? 1}&view=FitH` : null;

  return (
    <div className="eg dp">
      <style>{ENGINE_CSS + CSS}</style>
      {/* ── 1. AI summary ── */}
      <section className="dp-part summary" aria-label="AI summary">
        <div className="dp-head">
          <div style={{ minWidth: 0 }}>
            <div className="dp-kind">{KIND_LABEL[d.kind] ?? pretty(d.kind)}{d.subject ? ` · ${d.subject.replace(/^[a-z_]+:/, '')}` : ''}</div>
            <h1 className="dp-title">{detail.matter?.propertyAddress ?? d.propertyAddress ?? d.matterRef}</h1>
            <div className="eg-sub">
              <a href={`/engine/${d.matterId}`}>{detail.matter?.matterRef ?? d.matterRef} · {STAGE_LABEL[d.stage] ?? d.stage} · timeline</a> · raised {fmtWhen(d.createdAt)} by {who(detail.raised?.actor)} · summary by {d.summarisedBy}
              {detail.raised?.confidenceScore != null ? ` · extraction confidence ${Math.round(detail.raised.confidenceScore * 100)}%` : ''}
            </div>
          </div>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {detail.shadowed && <span className="eg-chip shadow">shadow · not actionable</span>}
            <span className={`eg-chip ${d.status === 'pending' ? 'pending' : d.status === 'actioned' ? 'ok' : 'info'}`}>{d.status}</span>
          </span>
        </div>
        <div className="dp-sum">
          {lines.map(({ line, marks }, i) => (
            <span key={i}>
              {line}
              {marks.map((m) => (
                <button key={m} className={`dp-cite${activeCite === m ? ' on' : ''}`} title={d.citations[m].label} onClick={() => jump(m)}>{m + 1}</button>
              ))}
              {i < lines.length - 1 ? '\n' : ''}
            </span>
          ))}
        </div>
        {d.citations.length > 0 && (
          <div className="dp-cites">
            {d.citations.map((c, i) => (
              <button key={i} onClick={() => jump(i)} style={activeCite === i ? { background: '#5A27E0', color: '#fff' } : undefined} title={unplaced.includes(i) ? 'Cited by this decision' : 'Referenced above'}>
                [{i + 1}] {c.label}{c.locator?.page && !/p\.\s*\d/.test(c.label) ? ` · p.${c.locator.page}` : ''}{c.locator?.section && !c.label.includes(c.locator.section) ? ` · ${c.locator.section}` : ''}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ── 2. Source, inline ── */}
      <section className="dp-part source" ref={srcRef} onScroll={(e) => { if ((e.currentTarget as HTMLElement).scrollTop > 40) setScrolled(true); }} aria-label="Source document">
        <div className="dp-srcbar">
          <strong style={{ color: '#0f172a' }}>{source?.fileName ?? 'Source'}</strong>
          {source?.docType ? <span>{pretty(source.docType.toLowerCase())}</span> : null}
          {d.sourceLocator?.page ? <span>· page {d.sourceLocator.page}{d.sourceLocator.section ? `, ${d.sourceLocator.section}` : ''}</span> : d.sourceLocator?.section ? <span>· {d.sourceLocator.section}</span> : null}
          {source?.rawUrl && <a href={source.rawUrl} target="_blank" rel="noopener noreferrer">open file ↗</a>}
          {source?.webUrl && <a href={source.webUrl} target="_blank" rel="noopener noreferrer">open in OneDrive ↗</a>}
          {pending && (
            <span className="dp-gate" style={{ marginLeft: 'auto' }}>
              {engaged ? <span style={{ color: '#15803d', fontWeight: 700 }}>Source read ✓</span> : (
                <>
                  <span>Reading the source…</span>
                  <span className="bar"><i style={{ width: `${Math.min(100, (dwell / UI_DWELL_MS) * 100)}%` }} /></span>
                </>
              )}
            </span>
          )}
        </div>
        <div className="dp-srcbody" style={pdfSrc ? { height: 'calc(100% - 44px)', padding: 8 } : undefined}>
          {!source && <div className="eg-sub">{detail.shadowed ? 'The source is available from the timeline once this matter or sub-flow leaves shadow mode.' : 'Loading the source…'}</div>}
          {pdfSrc && <iframe key={pdfSrc} className="dp-frame" title="Source document" src={pdfSrc} onLoad={() => { /* the PDF plugin swallows scroll events: dwell is the gate here */ }} />}
          {source && !pdfSrc && highlighted && (
            <pre className="dp-pre" ref={preRef}>
              {highlighted.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <mark key={i} data-cite={p.cite}>{p.text}</mark>))}
            </pre>
          )}
          {source && !pdfSrc && !highlighted && (source.webUrl ? <iframe className="dp-frame" title="Source document" src={source.webUrl} /> : <div className="dp-lock">No inline preview is available for this document. Open the file itself before deciding.</div>)}
        </div>
      </section>

      {/* ── 3. Actions ── */}
      <section className="dp-part actions" aria-label="Actions">
        {err && <div className="eg-err" style={{ marginTop: 0 }}>{err}</div>}
        {detail.shadowed && <div className="dp-shadow">Shadow mode ({detail.shadowed === 'matter' ? 'this matter' : 'this sub-flow'}): the engine's conclusion is logged for comparison only. Nothing to action here. <a href={`/engine/${d.matterId}/shadow`} style={{ color: '#c7d2fe' }}>Comparison view →</a></div>}
        {!detail.shadowed && !pending && (
          <div className="dp-out">
            {res ? (
              <>
                <b>{OPTION_LABEL[res.option ?? ''] ?? pretty(res.option ?? d.resolution ?? d.status)}</b> · by {who(res.by)} · {fmtWhen(res.at)}
                {res.note && <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>Reason: {res.note}</div>}
                {res.verification && <div style={{ marginTop: 4 }}>Verified via {VERIFICATION_METHOD_LABEL[res.verification.method] ?? res.verification.method}{res.verification.reference ? ` (${res.verification.reference})` : ''}</div>}
                {detail.escalation && <div style={{ marginTop: 4 }}><a href={`/decisions/${detail.escalation.eventId}`}>Escalation raised {fmtWhen(detail.escalation.at)} →</a></div>}
                <div style={{ marginTop: 6, fontSize: 11.5, color: '#64748b' }}>
                  Source opened by {detail.opens.length ? Array.from(new Set(detail.opens.map((o) => who(o.by)))).join(', ') : 'nobody'}
                  {res.engagement ? ` · engagement: ${res.engagement.scrolledSource ? 'scrolled' : 'did not scroll'}, ${Math.round(res.engagement.dwellMs / 1000)}s on the source` : ''} · read-only
                </div>
              </>
            ) : (
              <>
                <b>{pretty(d.status)}</b>{d.resolvedBy ? ` by ${who(d.resolvedBy)} · ${fmtWhen(d.resolvedAt)}` : ''} · read-only
              </>
            )}
          </div>
        )}
        {pending && (
          <>
            {isBank && (
              <div className="dp-lock" style={{ marginBottom: 8, background: '#fef2f2', borderColor: '#fecaca', color: '#7f1d1d' }}>
                <strong>Hard stop.</strong> Verify on a channel the sender does not control. A reply on the same channel is not offered.
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  <select className="eg-sel" value={method} onChange={(e) => setMethod(e.target.value)}>
                    <option value="">How did you verify?</option>
                    {Object.entries(VERIFICATION_METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <input className="eg-in" style={{ width: 260 }} placeholder="Check reference (who you spoke to, Lawyer Checker id)…" value={reference} onChange={(e) => setReference(e.target.value)} />
                </div>
              </div>
            )}
            {choice && needsReason(choice) && (
              <div style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 12.5, fontWeight: 700 }}>Reason for “{OPTION_LABEL[choice] ?? pretty(choice)}” (required — recorded on the decision)</label>
                <textarea className="eg-ta" rows={2} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked, and why this is the right call…" />
              </div>
            )}
            {choice && !needsReason(choice) && (
              <div style={{ marginBottom: 8 }}>
                <textarea className="eg-ta" rows={1} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note for the record…" />
              </div>
            )}
            <div className="dp-actions">
              {d.options.map((o) => (
                <button
                  key={o}
                  className={`eg-btn${choice === o ? ' on' : o === 'approve' || o === 'verify' ? ' primary' : ''}`}
                  disabled={busy || !engaged || (isBank && o === 'verify' && !method)}
                  title={!engaged ? 'Read the source section first' : isBank && o === 'verify' && !method ? 'Choose the verification method first' : ''}
                  onClick={() => setChoice(o)}
                >
                  {OPTION_LABEL[o] ?? pretty(o)}
                </button>
              ))}
              {choice && (
                <button className="eg-btn accent" disabled={busy || !engaged || (needsReason(choice) && !note.trim())} onClick={() => resolve(choice)}>
                  {busy ? 'Recording…' : `Confirm: ${OPTION_LABEL[choice] ?? pretty(choice)}`}
                </button>
              )}
              {!engaged && <span className="dp-gate">Actions unlock once you have scrolled the source or spent a few seconds on it.</span>}
            </div>
          </>
        )}
        {done && <div className="dp-out" style={{ marginTop: 8 }}>Recorded. <a href={`/engine/${d.matterId}`}>Back to the timeline →</a> · <a href="/decisions">Queue →</a></div>}
      </section>
    </div>
  );
}
