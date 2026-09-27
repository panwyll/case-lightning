'use client';
import { paths } from '@/lib/paths';
import { CheckedDraft } from './CheckedDraft';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { ENGINE_CSS } from './ui';
import { KIND_LABEL, OPTION_HELP, OPTION_LABEL, STAGE_LABEL, VERIFICATION_METHOD_LABEL, fmtWhen, pretty, type Citation, type DecisionDetail, type Engagement, type SourceDoc } from './types';
import { Check } from '@/app/shared/icons';

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
.dp{display:grid;grid-template-columns:minmax(380px,460px) minmax(0,1fr);height:calc(100vh - 56px);margin:-18px -24px -14px;background:#fff;min-height:0}
.dp-brief{display:grid;grid-template-rows:minmax(0,1fr) auto;border-right:1px solid #e6e8ee;min-height:0;min-width:0}
.dp-scroll{overflow:auto;min-height:0;min-width:0;padding:16px 20px 20px}
.dp-actions{border-top:1px solid #e6e8ee;padding:12px 20px calc(12px + env(safe-area-inset-bottom,0px));background:#fff}
.dp-src{min-height:0;min-width:0;display:grid;grid-template-rows:auto minmax(0,1fr);background:#fafafa}
.dp-srcbar{background:#fff;padding:10px 18px;font-size:12px;color:#64748b;display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #e6e8ee;min-height:44px;box-sizing:border-box}
.dp-srcbody{overflow:auto;min-height:0;padding:14px 18px;position:relative}
.dp-srcbody.pdf{padding:0}
.dp-frame{width:100%;height:100%;border:0;background:#fff;display:block}
.dp-kind{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#b45309}
.dp-title{font-size:17px;font-weight:800;margin:3px 0 2px;line-height:1.25}
.dp-meta{font-size:12px;color:#64748b;line-height:1.5}
.dp-meta a{color:#5A27E0;text-decoration:none;font-weight:600}
.dp-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.dp-lead{font-size:14.5px;font-weight:700;line-height:1.45;margin:14px 0 0;color:#0f172a}
.dp-strip{font-size:12.5px;color:#475569;margin:6px 0 0;line-height:1.5}
.dp-strip .hot{color:#92400e;font-weight:700}
.dp-task{display:grid;grid-template-columns:minmax(70px,max-content) minmax(0,1fr);gap:3px 12px;margin:12px 0 0;padding:10px 12px;border:1px solid #e6e8ee;border-radius:10px;background:#f8fafc;font-size:12.5px}
.dp-task dt{font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#64748b;padding-top:2px;max-width:110px;line-height:1.3}
.dp-task dd{margin:0;color:#0f172a;line-height:1.4;overflow-wrap:anywhere}
.dp-task .warn dd{color:#92400e;font-weight:600}
.dp-sec{margin-top:16px}
.dp-sec > h2{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#64748b;margin:0 0 8px}
.dp-point{border:1px solid #e6e8ee;border-radius:10px;padding:10px 12px;margin-bottom:8px;background:#fff}
.dp-point.high,.dp-point.critical{border-color:#fecaca;background:#fff7f7}
.dp-point.medium{border-color:#fde68a;background:#fffdf5}
.dp-point .sev{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;border-radius:999px;padding:2px 7px;margin-right:6px;vertical-align:middle;background:#f1f5f9;color:#475569}
.dp-point.high .sev,.dp-point.critical .sev{background:#fee2e2;color:#991b1b}
.dp-point.medium .sev{background:#fef3c7;color:#92400e}
.dp-point .txt{font-size:13.5px;line-height:1.5;color:#0f172a;overflow-wrap:anywhere}
.dp-point details{margin-top:6px;font-size:12.5px;color:#475569}
.dp-point summary{cursor:pointer;color:#5A27E0;font-weight:600;font-size:12px}
.dp-point details p{margin:6px 0 0;line-height:1.45}
.dp-prose{white-space:pre-wrap;font-size:13.5px;line-height:1.55;color:#0f172a;margin:0}
.dp-cite{display:inline-block;font-size:10.5px;font-weight:800;vertical-align:super;line-height:1;margin-left:3px;color:#5A27E0;background:#ede9fe;border-radius:4px;padding:2px 5px;cursor:pointer;border:0;font-family:inherit}
.dp-cite.on{background:#5A27E0;color:#fff}
.dp-cites{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.dp-cites button{font-size:12px;border:1px solid #ddd6fe;background:#f5f3ff;color:#4c1d95;border-radius:8px;padding:4px 8px;cursor:pointer;font-family:inherit;text-align:left}
.dp-cites button.on{background:#5A27E0;color:#fff;border-color:#5A27E0}
details.dp-fold{border:1px solid #e6e8ee;border-radius:10px;padding:0;margin-top:10px;background:#fff}
details.dp-fold > summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;padding:9px 12px;font-size:12.5px;font-weight:800;color:#0f172a}
details.dp-fold > summary::-webkit-details-marker{display:none}
details.dp-fold > summary::before{content:'';width:6px;height:6px;border-right:2px solid #64748b;border-bottom:2px solid #64748b;transform:rotate(-45deg);transition:transform .15s;margin-left:2px}
details.dp-fold[open] > summary::before{transform:rotate(45deg)}
details.dp-fold > summary .n{margin-left:auto;font-weight:600;color:#94a3b8;font-size:12px}
details.dp-fold > .body{padding:0 12px 12px;font-size:12.5px;line-height:1.5;color:#334155}
.dp-checks{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.dp-checks label{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.4;cursor:pointer;color:#0f172a}
.dp-checks label.done{color:#94a3b8;text-decoration:line-through}
.dp-checks input{margin:3px 0 0;accent-color:#5A27E0;flex-shrink:0}
.dp-list{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.dp-list li{display:flex;gap:8px;align-items:baseline}
.dp-list time{color:#94a3b8;white-space:nowrap;font-variant-numeric:tabular-nums;font-size:11.5px}
.dp-list li.warn{color:#92400e}
.dp-h3{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#64748b;margin:10px 0 5px}
.dp-facts{display:flex;flex-wrap:wrap;gap:6px}
.dp-fact{display:inline-flex;align-items:baseline;gap:5px;border:1px solid #e6e8ee;background:#f8fafc;border-radius:8px;padding:3px 8px;font-size:12px;line-height:1.35}
.dp-fact b{font-weight:700;color:#64748b;font-size:10.5px;letter-spacing:.03em;text-transform:uppercase;white-space:nowrap}
.dp-pre{white-space:pre-wrap;font-size:12.5px;line-height:1.55;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;max-width:96ch}
.dp-pre mark{background:#fef08a;border-radius:3px;padding:1px 2px;box-shadow:0 0 0 2px #fef08a}
.dp-pre mark.on{background:#fde047;box-shadow:0 0 0 3px #fde047}
.dp-gate{font-size:12px;color:#64748b;display:flex;gap:8px;align-items:center}
.dp-gate .bar{height:4px;width:100px;background:#e2e8f0;border-radius:4px;overflow:hidden}
.dp-gate .bar i{display:block;height:100%;background:#5A27E0;transition:width .3s}
.dp-opts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dp-out{background:#f8fafc;border:1px solid #e6e8ee;border-radius:10px;padding:10px 12px;font-size:13px}
.dp-out b{font-weight:800}
.dp-lock{background:#fffbeb;border:1px solid #fde68a;color:#78350f;border-radius:8px;padding:8px 10px;font-size:12.5px}
.dp-shadow{background:#312e81;color:#fff;border-radius:8px;padding:8px 10px;font-size:12.5px}
.dp-lines{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.dp-line{display:flex;gap:10px;align-items:flex-start;border:1px solid #e6e8ee;border-radius:10px;padding:8px 10px;background:#fff}
.dp-line.on{border-color:#c4b5fd;background:#faf8ff}
.dp-line.info{background:#f8fafc;color:#64748b}
.dp-line.refused{border-color:#fecaca;background:#fef2f2}
.dp-line input{margin-top:3px}
.dp-line q{display:block;font-style:italic;color:#475569;margin-top:3px;font-size:12.5px}
.dp-line .eff{display:block;font-size:12px;color:#334155;margin-top:3px}
@media (max-width:1000px){
  .dp{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto;height:auto;margin:-18px -16px -14px}
  .dp-brief{grid-template-rows:auto auto;border-right:0;border-bottom:1px solid #e6e8ee}
  .dp-scroll{overflow:visible;padding:14px 16px}
  .dp-actions{position:sticky;bottom:0;z-index:3;box-shadow:0 -2px 10px rgba(16,24,40,.06)}
  .dp-src{height:72vh}
  .dp-actions{padding:8px 12px calc(8px + env(safe-area-inset-bottom,0px))}
  .dp-opts{flex-wrap:nowrap;overflow-x:auto;padding-bottom:2px;-webkit-overflow-scrolling:touch}
  .dp-opts .eg-btn{white-space:nowrap;flex-shrink:0}
  .dp-gate{font-size:11px}
}
`;

type Point = { n: number; severity: string | null; text: string; help: string[] };
/**
 * The engine's summary has a shape: a count line, numbered points "[SEV] text (see p.1, 3.7)"
 * each followed by indented "What this usually means" lines, then an "Options:" line. Read it
 * into points so the panel can show each one once, with its help behind a fold, and leave
 * anything else (a template briefing, an escalation) as prose.
 */
function parseSummary(summary: string): { intro: string[]; points: Point[]; rest: string[] } {
  const intro: string[] = []; const points: Point[] = []; const rest: string[] = [];
  for (const raw of summary.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const m = line.match(/^(\d+)\.\s+(?:\[(LOW|MEDIUM|HIGH|CRITICAL|INFO)\]\s*)?(.*)$/i);
    if (m) { points.push({ n: Number(m[1]), severity: m[2]?.toLowerCase() ?? null, text: m[3].trim(), help: [] }); continue; }
    if (/^options:/i.test(line.trim())) continue;
    if (points.length && (/^\s/.test(raw) || /^what this usually means/i.test(line.trim()))) { points[points.length - 1].help.push(line.trim().replace(/^what this usually means:\s*/i, '')); continue; }
    if (points.length) rest.push(line.trim()); else intro.push(line.trim());
  }
  return { intro, points, rest };
}
const isCountLine = (s: string) => /\b(item|point|thing)s?\b.*\b(need|needs|for)\b|needs? a decision/i.test(s) && s.length < 90;

const UI_DWELL_MS = 5000;
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
  /** note_actions: which lines the person is applying. null until the decision loads. */
  const [picked, setPicked] = useState<Set<string> | null>(null);
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

  // Every line that would record something starts ticked; the person unticks what the
  // note does not actually say. Information-only lines are not selectable at all.
  useEffect(() => {
    if (picked || !detail?.noteActions) return;
    setPicked(new Set(detail.noteActions.actions.filter((a) => a.effect).map((a) => a.id)));
  }, [detail, picked]);

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
  // A proposal or a held clear is the engine's own text: nothing to read first. A document-backed decision waits for a scroll or a few seconds on the source.
  const engaged = d?.kind === 'proposal' || d?.kind === 'auto_clear' || scrolled || dwell >= UI_DWELL_MS;
  const isBank = d?.kind === 'bank_details';
  const noteLines = detail?.noteActions ?? null;
  const needsReason = (o: string) => o !== 'approve' && o !== 'verify';
  const parsed = useMemo(() => (d ? parseSummary(d.summary) : { intro: [], points: [], rest: [] }), [d]);
  // Citation markers sit on the point (or prose line) that mentions them; the rest are listed once below.
  const pointLines = useMemo(() => (d ? attachCitations([...parsed.intro, ...parsed.points.map((p) => p.text), ...parsed.rest].join('\n'), d.citations) : []), [d, parsed]);
  const marksFor = (text: string): number[] => pointLines.find((l) => l.line === text)?.marks ?? [];
  const unplaced = useMemo(() => (d ? d.citations.map((_, i) => i).filter((i) => !pointLines.some((l) => l.marks.includes(i))) : []), [d, pointLines]);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const toggleCheck = (i: number) => setChecked((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });

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
      const selection = detail?.noteActions && option === 'approve' ? [...(picked ?? [])] : null;
      await api(`/decisions/${eventId}/resolve`, { method: 'POST', body: JSON.stringify({ option, note: note.trim() || null, verification: isBank && option === 'verify' ? { method, reference: reference || null } : null, engagement, selection }) });
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

  const ctx = detail.context;
  const strip = ctx ? ['Client', 'Seller', 'Transaction', 'Price', 'Target exchange', 'Target completion', 'Lender'].map((k) => ctx.facts.find((f) => f.k === k)).filter((f): f is { k: string; v: string } => !!f) : [];
  const hotFacts = ctx ? ctx.facts.filter((f) => /^(Offer expires|Open issues|Arrears)$/.test(f.k) || (/^Target/.test(f.k) && /passed|expired/.test(f.v))) : [];
  const otherFacts = ctx ? ctx.facts.filter((f) => !strip.includes(f) && !hotFacts.includes(f)) : [];
  const taskRows = ctx ? ctx.task.filter((f) => f.k !== 'Points' || parsed.points.length === 0) : [];
  const intro = parsed.intro.filter((l) => !(ctx?.headline && isCountLine(l)));
  const cite = (text: string) => marksFor(text).map((m) => <button key={m} className={`dp-cite${activeCite === m ? ' on' : ''}`} title={d.citations[m].label} onClick={() => jump(m)}>{m + 1}</button>);
  const caseSide = ctx && (ctx.related.length > 0 || ctx.history.length > 0 || !!ctx.unblocks || otherFacts.length > 0);

  return (
    <div className="eg dp">
      <style>{ENGINE_CSS + CSS}</style>

      {/* ── The brief: what this is, what the engine found, what to check; the decision pinned underneath ── */}
      <div className="dp-brief">
        <div className="dp-scroll">
          <div className="dp-head">
            <div style={{ minWidth: 0 }}>
              <div className="dp-kind">{KIND_LABEL[d.kind] ?? pretty(d.kind)}{d.subject && !/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(d.subject) ? ` · ${d.subject.replace(/^[a-z_]+:/, '')}` : ''}</div>
              <h1 className="dp-title">{detail.matter?.propertyAddress ?? d.propertyAddress ?? d.matterRef}</h1>
              <div className="dp-meta">
                <a href={`/conveyi/engine/${d.matterId}`}>{detail.matter?.matterRef ?? d.matterRef}</a> · {STAGE_LABEL[d.stage] ?? d.stage} · raised {fmtWhen(d.createdAt)} by {who(detail.raised?.actor)}
              </div>
            </div>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
              {detail.shadowed && <span className="eg-chip shadow">shadow</span>}
              <span className={`eg-chip ${d.status === 'pending' ? 'pending' : d.status === 'actioned' ? 'ok' : 'info'}`}>{d.status}</span>
            </span>
          </div>

          {ctx?.headline ? <p className="dp-lead">{ctx.headline}</p> : intro.length > 0 ? <p className="dp-lead">{intro[0]}</p> : null}
          {(strip.length > 0 || hotFacts.length > 0) && (
            <p className="dp-strip">
              {strip.map((f) => f.v).join(' · ')}
              {hotFacts.map((f) => <span key={f.k}> · <span className="hot">{f.k}: {f.v}</span></span>)}
            </p>
          )}

          {taskRows.length > 0 && (
            <dl className="dp-task" aria-label="This task">
              {taskRows.map((f) => (<div key={f.k} className={f.warn ? 'warn' : ''} style={{ display: 'contents' }}><dt>{f.k}</dt><dd>{f.v}</dd></div>))}
            </dl>
          )}

          {parsed.points.length > 0 && (
            <section className="dp-sec" aria-label="Points">
              <h2>{parsed.points.length === 1 ? 'The point' : `${parsed.points.length} points`}</h2>
              {parsed.points.map((p) => (
                <div key={p.n} className={`dp-point${p.severity ? ` ${p.severity}` : ''}`}>
                  <div className="txt">{p.severity && <span className="sev">{p.severity}</span>}{p.text.replace(/\s*\((?:see|at) [^)]*\)\s*$/i, '')}{cite(p.text)}</div>
                  {p.help.length > 0 && <details><summary>What this usually means</summary>{p.help.map((h, i) => <p key={i}>{h}</p>)}</details>}
                </div>
              ))}
            </section>
          )}
          {parsed.points.length === 0 && (intro.length > (ctx?.headline ? 0 : 1) || parsed.rest.length > 0) && (
            <section className="dp-sec" aria-label="Summary">
              <h2>What the engine found</h2>
              <p className="dp-prose">{[...(ctx?.headline ? intro : intro.slice(1)), ...parsed.rest].map((l, i) => <span key={i}>{l}{cite(l)}{'\n'}</span>)}</p>
            </section>
          )}
          {parsed.points.length > 0 && (intro.length > (ctx?.headline ? 0 : 1) || parsed.rest.length > 0) && (
            <details className="dp-fold">
              <summary>More from the summary</summary>
              <div className="body"><p className="dp-prose" style={{ fontSize: 12.5 }}>{[...(ctx?.headline ? intro : intro.slice(1)), ...parsed.rest].join('\n')}</p></div>
            </details>
          )}
          {d.citations.length > 0 && (
            <div className="dp-cites">
              {d.citations.map((c, i) => (
                <button key={i} className={activeCite === i ? 'on' : ''} onClick={() => jump(i)} title={unplaced.includes(i) ? 'Cited by this decision' : 'Referenced above'}>
                  [{i + 1}] {/^[A-Z0-9_]+$/.test(c.label.split(' — ')[0]) ? pretty(c.label.split(' — ')[0].toLowerCase()) + (c.label.includes(' — ') ? ` — ${c.label.split(' — ').slice(1).join(' — ')}` : '') : c.label}{c.locator?.page && !/p\.\s*\d/.test(c.label) ? ` · p.${c.locator.page}` : ''}{c.locator?.section && !c.label.includes(c.locator.section) ? ` · ${c.locator.section}` : ''}
                </button>
              ))}
            </div>
          )}

          {ctx && ctx.checks.length > 0 && (
            <details className="dp-fold" open={ctx.checks.length <= 6}>
              <summary>Check before deciding<span className="n">{checked.size}/{ctx.checks.length}</span></summary>
              <div className="body">
                <ul className="dp-checks">
                  {ctx.checks.map((c, i) => (<li key={i}><label className={checked.has(i) ? 'done' : ''}><input type="checkbox" checked={checked.has(i)} onChange={() => toggleCheck(i)} />{c}</label></li>))}
                </ul>
              </div>
            </details>
          )}
          {caseSide && ctx && (
            <details className="dp-fold">
              <summary>On this case<span className="n">{ctx.related.length + ctx.history.length}</span></summary>
              <div className="body">
                {ctx.related.length > 0 && <><div className="dp-h3">Also open</div><ul className="dp-list">{ctx.related.map((r, i) => <li key={i} className={/expire|passed|Also waiting/.test(r) ? 'warn' : ''}>{r}</li>)}</ul></>}
                {ctx.history.length > 0 && <><div className="dp-h3">So far on this subject</div><ul className="dp-list">{ctx.history.map((h, i) => <li key={i}><time dateTime={h.at}>{fmtWhen(h.at)}</time><span>{h.what}</span></li>)}</ul></>}
                {ctx.unblocks && <><div className="dp-h3">What this unblocks</div><div>{ctx.unblocks}</div></>}
                {otherFacts.length > 0 && <><div className="dp-h3">Case facts</div><div className="dp-facts">{otherFacts.map((f) => <span key={f.k} className="dp-fact"><b>{f.k}</b><span>{f.v}</span></span>)}</div></>}
              </div>
            </details>
          )}

          {pending && isBank && (
            <div className="dp-lock" style={{ marginTop: 14, background: '#fef2f2', borderColor: '#fecaca', color: '#7f1d1d' }}>
              <strong>Hard stop.</strong> Verify on a channel the sender does not control. A reply on the same channel is not offered.
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                <select className="eg-sel" value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="">How did you verify?</option>
                  {Object.entries(VERIFICATION_METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <input className="eg-in" style={{ width: 240 }} placeholder="Check reference (who you spoke to, Lawyer Checker id)…" value={reference} onChange={(e) => setReference(e.target.value)} />
              </div>
            </div>
          )}
          {pending && noteLines && (
            <div className="dp-lines">
              <div style={{ fontSize: 12.5, fontWeight: 700 }}>Tick what the {noteLines.noteKind === 'call' ? 'call' : 'note'} actually says. Only ticked lines are recorded.</div>
              {noteLines.actions.map((a) => {
                const on = !!picked?.has(a.id);
                return (
                  <label key={a.id} className={`dp-line${a.effect ? (on ? ' on' : '') : ' info'}`}>
                    <input type="checkbox" checked={on} disabled={!a.effect || busy} onChange={(e) => setPicked((prev) => { const next = new Set(prev ?? []); if (e.target.checked) next.add(a.id); else next.delete(a.id); return next; })} />
                    <span style={{ minWidth: 0 }}><b>{a.summary}</b><q>{a.quote}</q><span className="eff">{a.effect ?? 'For information only — nothing would be recorded.'}</span></span>
                  </label>
                );
              })}
            </div>
          )}
          {!pending && !detail.shadowed && noteLines && (
            <div className="dp-lines">
              {noteLines.actions.map((a) => {
                const refused = noteLines.refused.find((r) => r.id === a.id);
                const landed = !refused && (noteLines.applied ?? []).includes(a.id);
                return (
                  <div key={a.id} className={`dp-line${refused ? ' refused' : landed ? ' on' : ' info'}`}>
                    <span style={{ minWidth: 0 }}><b>{landed ? 'Recorded' : refused ? 'Refused' : 'Not recorded'} — {a.summary}</b><q>{a.quote}</q>{refused && <span className="eff">The machine would not take it: {refused.reason}</span>}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── The decision, always in reach ── */}
        <div className="dp-actions" aria-label="Actions">
          {err && <div className="eg-err" style={{ marginTop: 0, marginBottom: 8 }}>{err}</div>}
          {detail.shadowed && <div className="dp-shadow">Shadow mode ({detail.shadowed === 'matter' ? 'this case' : 'this sub-flow'}): logged for comparison only. <a href={`/conveyi/engine/${d.matterId}/shadow`} style={{ color: '#c7d2fe' }}>Shadow queue →</a></div>}
          {!detail.shadowed && !pending && (
            <div className="dp-out">
              {res ? (
                <>
                  <b>{OPTION_LABEL[res.option ?? ''] ?? pretty(res.option ?? d.resolution ?? d.status)}</b> · {who(res.by)} · {fmtWhen(res.at)}
                  {res.note && <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>Reason: {res.note}</div>}
                  {res.verification && <div style={{ marginTop: 4 }}>Verified via {VERIFICATION_METHOD_LABEL[res.verification.method] ?? res.verification.method}{res.verification.reference ? ` (${res.verification.reference})` : ''}</div>}
                  {detail.escalation && <div style={{ marginTop: 4 }}><a href={`/conveyi/decisions/${detail.escalation.eventId}`}>Escalation raised {fmtWhen(detail.escalation.at)} →</a></div>}
                  <div style={{ marginTop: 6, fontSize: 11.5, color: '#64748b' }}>
                    Source opened by {detail.opens.length ? Array.from(new Set(detail.opens.map((o) => who(o.by)))).join(', ') : 'nobody'}
                    {res.engagement ? ` · ${res.engagement.scrolledSource ? 'scrolled' : 'did not scroll'}, ${Math.round(res.engagement.dwellMs / 1000)}s on the source` : ''}
                  </div>
                </>
              ) : (
                <><b>{pretty(d.status)}</b>{d.resolvedBy ? ` by ${who(d.resolvedBy)} · ${fmtWhen(d.resolvedAt)}` : ''}</>
              )}
              {done && <div style={{ marginTop: 6 }}><a href={`${paths.matter(d.matterId)}?tab=timeline`}>Back to the case →</a> · <a href={paths.tasks}>Tasks →</a></div>}
            </div>
          )}
          {pending && (
            <>
              {choice && needsReason(choice) && (
                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 12.5, fontWeight: 700 }}>Reason for “{OPTION_LABEL[choice] ?? pretty(choice)}”</label>
                  <textarea className="eg-ta" rows={2} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked, and why this is the right call…" />
                </div>
              )}
              {choice && !needsReason(choice) && (
                <div style={{ marginBottom: 8 }}>
                  <textarea className="eg-ta" rows={1} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note for the record…" />
                </div>
              )}
              <div className="dp-opts">
                {d.options.map((o) => (
                  <button
                    key={o}
                    className={`eg-btn${choice === o ? ' on' : o === 'approve' || o === 'verify' ? ' primary' : ''}`}
                    disabled={busy || !engaged || (isBank && o === 'verify' && !method) || (!!noteLines && o === 'approve' && !picked?.size)}
                    title={!engaged ? 'Read the source first' : isBank && o === 'verify' && !method ? 'Choose the verification method first' : noteLines && o === 'approve' && !picked?.size ? 'Tick at least one line, or reject the reading with a reason' : OPTION_HELP[o] ?? ''}
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
              </div>
              {!engaged && <div className="dp-gate" style={{ marginTop: 8 }}>Unlocks once the source has been read (scroll it, or a few seconds on it).</div>}
            </>
          )}
        </div>
      </div>

      {/* ── The source, full height ── */}
      <section className="dp-src" ref={srcRef} aria-label="Source document">
        <div className="dp-srcbar">
          <strong style={{ color: '#0f172a' }}>{source?.fileName ?? 'Source'}</strong>
          {source?.docType ? <span>{pretty(source.docType.toLowerCase())}</span> : null}
          {d.sourceLocator?.page ? <span>· page {d.sourceLocator.page}{d.sourceLocator.section ? `, ${d.sourceLocator.section}` : ''}</span> : d.sourceLocator?.section ? <span>· {d.sourceLocator.section}</span> : null}
          {source?.rawUrl && <a href={source.rawUrl} target="_blank" rel="noopener noreferrer">open file ↗</a>}
          {source?.webUrl && <a href={source.webUrl} target="_blank" rel="noopener noreferrer">open in OneDrive ↗</a>}
          {pending && (
            <span className="dp-gate" style={{ marginLeft: 'auto' }}>
              {engaged ? <span style={{ color: '#15803d', fontWeight: 700 }}>Source read <Check size={12} /></span> : (
                <><span>Reading…</span><span className="bar"><i style={{ width: `${Math.min(100, (dwell / UI_DWELL_MS) * 100)}%` }} /></span></>
              )}
            </span>
          )}
        </div>
        <div className={`dp-srcbody${pdfSrc ? ' pdf' : ''}`} onScroll={(e) => { if ((e.currentTarget as HTMLElement).scrollTop > 40) setScrolled(true); }}>
          {!source && <div className="eg-sub">{detail.shadowed ? 'The source is available from the timeline once this case or sub-flow leaves shadow mode.' : 'Loading the source…'}</div>}
          {pdfSrc && <iframe key={pdfSrc} className="dp-frame" title="Source document" src={pdfSrc} />}
          {source && !pdfSrc && source.draftCheck && <CheckedDraft check={source.draftCheck} />}
          {source && !pdfSrc && !source.draftCheck && highlighted && (
            <pre className="dp-pre" ref={preRef}>
              {highlighted.map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <mark key={i} data-cite={p.cite}>{p.text}</mark>))}
            </pre>
          )}
          {source && !pdfSrc && !source.draftCheck && !highlighted && (source.webUrl ? <iframe className="dp-frame" title="Source document" src={source.webUrl} /> : <div className="dp-lock">No inline preview is available for this document. Open the file itself.</div>)}
        </div>
      </section>
    </div>
  );
}
