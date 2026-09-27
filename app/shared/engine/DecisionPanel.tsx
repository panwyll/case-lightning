'use client';
import { paths } from '@/lib/paths';
import { CheckedDraft } from './CheckedDraft';
import { PdfView, PDF_CSS } from './PdfView';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { ENGINE_CSS } from './ui';
import { KIND_LABEL, OPTION_HELP, OPTION_LABEL, OPTION_LABEL_BY_KIND, STAGE_LABEL, VERIFICATION_METHOD_LABEL, fmtWhen, pretty, type Citation, type DecisionDetail, type Engagement, type SourceDoc } from './types';
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
.dp{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(320px,1fr);height:calc(100vh - 56px);margin:-18px -24px -14px;background:#fff;min-height:0}
.dp.solo{grid-template-columns:minmax(0,1fr)}
.dp.inline{height:min(72vh,760px);margin:0;border-top:1px solid #e6e8ee;border-radius:0 0 12px 12px;overflow:hidden}
.dp.inline .dp-scroll{padding:14px 18px 18px}
.dp.inline .dp-actions{padding-left:18px;padding-right:18px}
.dp-brief{display:grid;grid-template-rows:minmax(0,1fr) auto;border-right:1px solid #e6e8ee;min-height:0;min-width:0}
.dp-scroll{overflow:auto;min-height:0;min-width:0;padding:18px 24px 24px}
.dp-actions{border-top:1px solid #e6e8ee;padding:10px 24px calc(10px + env(safe-area-inset-bottom,0px));background:#fff;display:flex;flex-direction:column;gap:8px}
.dp-src{min-height:0;min-width:0;display:grid;grid-template-rows:auto minmax(0,1fr);background:#fafafa}
.dp-srcbar{background:#fff;padding:8px 14px;font-size:12px;color:#64748b;display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #e6e8ee;min-height:44px;box-sizing:border-box}
.dp-pick{font:inherit;font-size:12.5px;font-weight:700;color:#0f172a;border:1px solid #e2e8f0;border-radius:8px;padding:5px 8px;background:#fff;min-width:0;width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dp-srcbody{overflow:auto;min-height:0;padding:14px 16px;position:relative}
.dp-srcbody.pdf{padding:0}
.dp-frame{width:100%;height:100%;border:0;background:#fff;display:block}
.dp-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.dp-kind{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#5A27E0}
.dp-lead{font-size:16px;font-weight:800;line-height:1.35;margin:4px 0 0;color:#0f172a;max-width:60ch}
.dp-case{font-size:12px;color:#64748b;white-space:nowrap}
.dp-case a{color:#5A27E0;text-decoration:none;font-weight:700}
.dp-checks{list-style:none;margin:18px 0 0;padding:0;display:grid;gap:8px}
.dp-check{border:1px solid #e6e8ee;border-radius:12px;padding:10px 14px 10px 12px;background:#fff;display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:4px 10px;align-items:start}
.dp-check.flag{border-color:#fde68a;background:#fffdf5}
.dp-check.ok{background:#fff}
.dp-check .g{width:20px;height:20px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;margin-top:1px}
.dp-check.ok .g{background:#dcfce7;color:#15803d}
.dp-check.flag .g{background:#fef3c7;color:#b45309}
.dp-check.open .g{background:#f1f5f9;color:#94a3b8}
.dp-check .t{font-size:14px;font-weight:700;line-height:1.4;color:#0f172a}
.dp-check.done .t{color:#94a3b8;text-decoration:line-through}
.dp-check .tick{margin:2px 0 0;accent-color:#5A27E0;width:16px;height:16px;cursor:pointer}
.dp-ev{grid-column:2 / span 2;list-style:none;margin:2px 0 0;padding:0;display:grid;gap:3px}
.dp-ev li{font-size:12.5px;line-height:1.45;color:#475569;display:flex;gap:6px;align-items:baseline}
.dp-ev li.warn{color:#92400e}
.dp-ev li::before{content:'·';color:#cbd5e1;flex-shrink:0}
.dp-ev button{border:0;background:none;padding:0;font:inherit;color:#5A27E0;cursor:pointer;text-decoration:underline dotted;white-space:nowrap}
.dp-ev .links{display:inline-flex;gap:4px;flex-wrap:wrap}
.dp-ev .links button{border:1px solid #ddd6fe;background:#f5f3ff;border-radius:6px;padding:0 6px;font-size:11.5px;text-decoration:none}
.dp-ev .links button.on{background:#5A27E0;color:#fff;border-color:#5A27E0}
.dp-quiet{margin-top:16px;border-top:1px solid #eef2f7;padding-top:10px;list-style:none;padding-left:0;display:grid;gap:6px}
.dp-quiet li{font-size:13px;color:#334155}
.dp-quiet li b{font-weight:700;color:#15803d;margin-right:4px}
.dp-quiet .dp-ev{margin-left:22px}
.dp-sub{font-size:13px;font-weight:700;color:#334155;margin:10px 0 0}
.dp-files{display:grid;gap:8px;margin-top:14px}
.dp-file{border:1px solid #e6e8ee;border-radius:12px;background:#fff}
.dp-file.warn{border-color:#fde68a;background:#fffdf5}
.dp-file > summary{cursor:pointer;list-style:none;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:2px 10px;padding:10px 14px;align-items:baseline}
.dp-file > summary::-webkit-details-marker{display:none}
.dp-file > summary .name{font-size:13.5px;font-weight:800;color:#0f172a}
.dp-file > summary .what{font-size:12.5px;color:#475569;grid-column:2}
.dp-file > summary .tw{font-size:11px;color:#94a3b8;white-space:nowrap}
.dp-file > summary::before{content:'';width:6px;height:6px;border-right:2px solid #64748b;border-bottom:2px solid #64748b;transform:rotate(-45deg);transition:transform .15s;margin-right:4px;align-self:center}
.dp-file[open] > summary::before{transform:rotate(45deg)}
.dp-file .dp-narr{margin:0;padding:0 14px 12px 34px}
.dp-passed{margin-top:18px;border-top:1px solid #eef2f7;padding-top:10px}
.dp-passed > summary{cursor:pointer;list-style:none;font-size:12.5px;font-weight:700;color:#15803d;display:flex;align-items:center;gap:8px}
.dp-passed > summary::-webkit-details-marker{display:none}
.dp-passed > summary::before{content:'';width:6px;height:6px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg);transition:transform .15s;margin-left:2px}
.dp-passed[open] > summary::before{transform:rotate(45deg)}
.dp-passed ul{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:3px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
.dp-passed li{font-size:12.5px;color:#475569}
.dp-passed li::before{content:'✓ ';color:#15803d;font-weight:800}
.dp-msg{margin-top:12px;border:1px solid #e6e8ee;border-radius:12px;background:#fff;padding:12px 14px}
.dp-msg.warn{border-color:#fbbf24;background:#fffbeb}
.dp-msg .h{font-size:13px;font-weight:700;color:#0f172a}
.dp-msg .s{margin-top:8px;font-size:13.5px;font-weight:700;color:#0f172a}
.dp-msg .b{margin:6px 0 0;font:inherit;font-size:13.5px;line-height:1.55;color:#0f172a;white-space:pre-wrap}
.dp-msg p{margin:6px 0 0;font-size:13px;color:#475569}
.dp-msg p.warn{color:#92400e}
.dp-narr{list-style:none;margin:14px 0 0;padding:0;display:grid;gap:4px}
.dp-narr li{font-size:13.5px;line-height:1.5;color:#0f172a;display:flex;gap:8px;align-items:baseline;white-space:pre-wrap}
.dp-narr li.warn{color:#92400e}
.dp-narr li.sub{color:#475569;font-size:13px}
.dp-narr li button{border:0;background:none;padding:0;font:inherit;color:#5A27E0;cursor:pointer;text-decoration:underline dotted;white-space:nowrap}
.dp-narr li button.on{color:#fff;background:#5A27E0;border-radius:6px;padding:0 6px;text-decoration:none}
.dp-btn{border:1px solid #5A27E0;background:#fff;color:#5A27E0;border-radius:8px;padding:6px 12px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap}
.dp-btn:hover{background:#f5f3ff}
.dp-btn.primary{background:#5A27E0;color:#fff}
.dp-btn.primary:hover{background:#4c1fc4}
.dp-btn.on{background:#ede9fe}
.dp-btn.primary.on{background:#4c1fc4}
.dp-btn:disabled{opacity:.4;cursor:not-allowed;background:#fff;color:#5A27E0}
.dp-btn.primary:disabled{background:#5A27E0;color:#fff}
.dp-opts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dp-gate{font-size:12px;color:#64748b;display:flex;gap:8px;align-items:center}
.dp-gate .bar{height:4px;width:90px;background:#e2e8f0;border-radius:4px;overflow:hidden}
.dp-gate .bar i{display:block;height:100%;background:#5A27E0;transition:width .3s}
.dp-pre{white-space:pre-wrap;font-size:12.5px;line-height:1.55;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}
.dp-pre mark{background:#fef08a;border-radius:3px;padding:1px 2px;box-shadow:0 0 0 2px #fef08a}
.dp-pre mark.on{background:#fde047;box-shadow:0 0 0 3px #fde047}
.dp-prose{white-space:pre-wrap;font-size:13.5px;line-height:1.55;color:#0f172a;margin:14px 0 0}
.dp-out{background:#f8fafc;border:1px solid #e6e8ee;border-radius:10px;padding:10px 12px;font-size:13px}
.dp-out b{font-weight:800}
.dp-lock{background:#fffbeb;border:1px solid #fde68a;color:#78350f;border-radius:8px;padding:8px 10px;font-size:12.5px}
.dp-shadow{background:#312e81;color:#fff;border-radius:8px;padding:8px 10px;font-size:12.5px}
.dp-lines{display:flex;flex-direction:column;gap:6px;margin-top:14px}
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
  .dp-actions{position:sticky;bottom:0;z-index:3;box-shadow:0 -2px 10px rgba(16,24,40,.06);padding:8px 12px calc(8px + env(safe-area-inset-bottom,0px))}
  .dp-opts{flex-wrap:nowrap;overflow-x:auto;padding-bottom:2px}
  .dp-src{height:72vh}
}

.dp.solo,.dp.inline.solo{height:auto}
.dp.solo .dp-brief{grid-template-rows:auto auto;border-right:0}
.dp.solo .dp-scroll,.dp.inline.solo .dp-scroll{overflow:visible;padding-bottom:6px}
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

export function DecisionPanel({ eventId, inline = false, onResolved }: { eventId: string; inline?: boolean; onResolved?: () => void }) {
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
  const openQueries = detail?.openQueries ?? 0;
  const needsReason = (o: string) => (o !== 'approve' && o !== 'verify') || (o === 'approve' && openQueries > 0);
  const msg = detail?.message ?? null;
  const optionLabel = (o: string) => {
    return (OPTION_LABEL_BY_KIND[d?.kind ?? '']?.[o] ?? OPTION_LABEL[o] ?? pretty(o)).replace(/\s+[—(].*$/, '');
  };
  const parsed = useMemo(() => (d ? parseSummary(d.summary) : { intro: [], points: [], rest: [] }), [d]);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const toggleTick = (i: number) => setTicked((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  // The file picker: the decision's source first, then every other document the brief cites; another document is fetched raw.
  const [pickedDoc, setPickedDoc] = useState<string | null>(null);
  const [other, setOther] = useState<{ id: string; content: string | null; rawUrl: string | null; pdf?: boolean } | null>(null);
  const [pdfFound, setPdfFound] = useState<boolean | null>(null);
  const [focusQuote, setFocusQuote] = useState<string | null>(null);
  const [focusAlts, setFocusAlts] = useState<string[]>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const showDoc = useCallback(async (id: string, pageNo: number | null, quote: string | null = null, index = 0, alts: string[] = []) => {
    setPickedDoc(id);
    setPage(pageNo ?? 1);
    setFocusQuote(quote);
    setFocusAlts(alts);
    setFocusIndex(index);
    if (!source || id === source.id) { setOther(null); return; }
    try {
      const r = await fetch(`/api/v1/documents/${id}/raw`);
      const type = r.headers.get('content-type') ?? '';
      if (r.ok && /^text\//.test(type)) setOther({ id, content: await r.text(), rawUrl: null });
      else setOther({ id, content: null, rawUrl: `/api/v1/documents/${id}/raw`, pdf: /pdf/i.test(type) });
    } catch { setOther({ id, content: null, rawUrl: `/api/v1/documents/${id}/raw`, pdf: true }); }
  }, [source]);

  /** Jump the source to a citation: PDF → page; text → highlighted passage. */
  const jump = useCallback(
    (i: number) => {
      if (!d) return;
      const c = d.citations[i];
      setActiveCite(i);
      if (source && c.documentId !== source.id) { void showDoc(c.documentId, c.locator?.page ?? null); return; }
      setPickedDoc(source?.id ?? null);
      setOther(null);
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
    [d, source, showDoc]
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

  // A quoted line: wrap it in a mark and bring it into view, whichever text document is showing.
  const withQuote = useCallback((content: string): Array<string | { text: string; cite: number }> => {
    if (!focusQuote) return [content];
    const needle = focusQuote.toLowerCase().slice(0, 100);
    const lower = content.toLowerCase();
    let at = -1;
    for (let k = 0; k <= focusIndex; k++) { at = lower.indexOf(needle, at + 1); if (at < 0) break; }
    if (at < 0) at = lower.indexOf(needle);
    if (at < 0) return [content];
    const len = Math.min(focusQuote.length, 100);
    return [content.slice(0, at), { text: content.slice(at, at + len), cite: -2 }, content.slice(at + len)];
  }, [focusQuote, focusIndex]);
  useEffect(() => {
    if (!focusQuote) return;
    const t = setTimeout(() => { const el = document.querySelector('.dp-srcbody mark.on') as HTMLElement | null; el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 60);
    return () => clearTimeout(t);
  }, [focusQuote, focusIndex, other, source]);

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
      window.dispatchEvent(new Event('conveyi:counts'));
      onResolved?.();
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
  const checklist = ctx?.checklist ?? (ctx?.checks ?? []).map((text) => ({ text, status: 'open' as const, evidence: [] }));
  const lead = ctx?.headline ?? parsed.intro[0] ?? '';
  const docLabel = (id: string): string => (source && id === source.id ? source.fileName ?? 'Source' : d.citations.find((c) => c.documentId === id)?.label.replace(/^[A-Z0-9_]+ — /, '') ?? checklist.flatMap((c) => c.evidence).find((e) => e.documentId === id)?.text.split(' · ')[0] ?? 'Document');
  const docIds = Array.from(new Set([...(source ? [source.id] : []), ...d.citations.map((c) => c.documentId), ...checklist.flatMap((c) => c.evidence.map((e) => e.documentId)).filter((x): x is string => !!x)]));
  const showing = pickedDoc ?? source?.id ?? null;
  const shownOther = other && other.id === showing ? other : null;
  const shownPdf = shownOther ? shownOther.rawUrl : pdfSrc;
  const shownPdfSrc = shownOther?.rawUrl ? `${shownOther.rawUrl}#page=${page ?? 1}&view=FitH` : pdfSrc;
  const flagged = checklist.filter((c) => c.status === 'flag').length;
  // A proposal is its message: no file cards, no narrative, no summary text under it.
  const isProposal = d?.kind === 'proposal';
  const narrative = isProposal ? [] : ctx?.narrative ?? [];
  const files = isProposal ? [] : ctx?.files ?? [];
  const passed = isProposal ? [] : ctx?.passed ?? [];
  const renderLines = (lines: typeof narrative) => (
    <ul className="dp-narr">
      {lines.map((e, j) => (
        <li key={j} className={`${e.warn ? 'warn' : ''}${/^\s/.test(e.text) ? ' sub' : ''}`}>
          <span>{e.text}</span>
          {e.documentId && (e.quote || e.page || showing !== e.documentId) && evLink(e, e.quote ? 'show' : e.page ? `p.${e.page}` : 'open')}
        </li>
      ))}
    </ul>
  );
  const live = checklist.map((c, i) => ({ c, i })).filter(({ c }) => c.status === 'flag');
  const quiet = checklist.map((c, i) => ({ c, i })).filter(({ c }) => c.status === 'ok');
  const evLink = (e: { text?: string; documentId?: string | null; page?: number | null; quote?: string | null; quoteIndex?: number }, label: string) => e.documentId ? <button type="button" className={showing === e.documentId && !!e.quote && focusQuote === e.quote && focusIndex === (e.quoteIndex ?? 0) ? 'on' : ''} onClick={() => void showDoc(e.documentId!, e.page ?? null, e.quote ?? null, e.quoteIndex ?? 0, e.text ? [e.text.replace(/^[\d.]+\s*/, '').split(/[;:—(]/)[0].trim().split(/\s+/).slice(0, 6).join(' ')] : [])} title={docLabel(e.documentId)}>{label}</button> : null;
  const renderEv = (c: { evidence: Array<{ text: string; documentId?: string | null; page?: number | null; quote?: string | null; warn?: boolean; links?: Array<{ label: string; documentId: string; page?: number | null; quote?: string | null }> }> }) => c.evidence.length > 0 && (
    <ul className="dp-ev">
      {c.evidence.map((e, j) => (
        <li key={j} className={e.warn ? 'warn' : ''}>
          <span>{e.text.trim()}</span>
          {e.links?.length ? <span className="links">{e.links.map((l, k) => <button key={k} type="button" className={showing === l.documentId && focusQuote === (l.quote ?? null) && l.quote ? 'on' : ''} onClick={() => void showDoc(l.documentId, l.page ?? null, l.quote ?? null)} title={docLabel(l.documentId)}>{l.label}</button>)}</span> : null}
          {!e.links?.length && e.documentId && (showing !== e.documentId || e.page || e.quote) && evLink(e, e.quote ? 'show' : e.page ? `p.${e.page}` : 'open')}
        </li>
      ))}
    </ul>
  );

  return (
    <div className={`eg dp${inline ? ' inline' : ''}${d.kind === 'proposal' ? ' solo' : ''}`}>
      <style>{ENGINE_CSS + CSS + PDF_CSS}</style>

      {/* ── The brief: the checks, each with what the file says; the decision pinned underneath ── */}
      <div className="dp-brief">
        <div className="dp-scroll">
          <div className="dp-head" style={inline ? { display: 'none' } : undefined}>
            <div style={{ minWidth: 0 }}>
              <div className="dp-kind">{KIND_LABEL[d.kind] ?? pretty(d.kind)}{d.subject && !/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(d.subject) ? ` · ${d.subject.replace(/^[a-z_]+:/, '')}` : ''}</div>
              <p className="dp-lead">{detail.matter?.propertyAddress ?? d.propertyAddress ?? d.matterRef}</p>
              {ctx?.submitted ? <p className="dp-sub">{ctx.submitted.by}{ctx.submitted.at ? ` · ${fmtWhen(ctx.submitted.at)}` : ''}</p> : lead ? <p className="dp-sub">{lead}</p> : null}
            </div>
            <div className="dp-case" style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
              {detail.shadowed && <span className="eg-chip shadow">shadow</span>}
              <span className={`eg-chip ${d.status === 'pending' ? 'pending' : d.status === 'actioned' ? 'ok' : 'info'}`}>{d.status}</span>
              <a href={`/conveyi/engine/${d.matterId}`}>{detail.matter?.matterRef ?? d.matterRef} →</a>
            </div>
          </div>

          {inline && ctx?.submitted && <p className="dp-sub" style={{ marginTop: 0 }}>{ctx.submitted.by}{ctx.submitted.at ? ` · ${fmtWhen(ctx.submitted.at)}` : ''}</p>}
          {msg && (
            <div className={`dp-msg${msg.kind !== 'action' && msg.channel === 'none' ? ' warn' : ''}`} aria-label="What would be sent">
              {msg.kind === 'action' ? (
                <>
                  <div className="h">{msg.title}</div>
                  {msg.lines.map((l, i) => <p key={i}>{l}</p>)}
                </>
              ) : (
                <>
                  <div className="h">{msg.kind === 'form' ? 'The proof-of-funds form goes to' : msg.channel === 'whatsapp' ? 'WhatsApp to' : msg.channel === 'draft' ? 'Email drafted in Outlook to' : 'Email to'} {msg.to}</div>
                  {msg.channel === 'none' && <p className="warn">There is no address for them on the case, so this cannot go until one is added.</p>}
                  <div className="s">{msg.subject}</div>
                  <pre className="b">{msg.body}</pre>
                </>
              )}
            </div>
          )}
          {narrative.length > 0 && renderLines(narrative)}
          {files.length > 0 && (
            <div className="dp-files" aria-label="Documents read">
              {files.map((f) => (
                <details key={f.documentId} className={`dp-file${f.warn ? ' warn' : ''}`} open={!!f.warn}>
                  <summary>
                    <span className="name">{source && f.documentId === source.id && source.fileName && f.title !== 'Form responses' ? source.fileName : f.title}</span>
                    <span className="tw">{showing === f.documentId ? 'shown' : <button type="button" style={{ border: 0, background: 'none', padding: 0, font: 'inherit', color: '#5A27E0', cursor: 'pointer' }} onClick={(e) => { e.preventDefault(); void showDoc(f.documentId, null); }}>open</button>}</span>
                    <span className="what">{f.summary}</span>
                  </summary>
                  {(() => { const said = new Set(live.flatMap(({ c }) => c.evidence.map((e) => e.text))); const lines = f.lines.filter((l) => !said.has(l.text)); return lines.length > 0 ? renderLines(lines) : null; })()}
                </details>
              ))}
            </div>
          )}
          {checklist.length > 0 || narrative.length > 0 ? (
            <>
              {live.length > 0 && (
                <ul className="dp-checks" aria-label="Checks">
                  {live.map(({ c, i }) => (
                    <li key={i} className={`dp-check ${c.status}${ticked.has(i) ? ' done' : ''}`}>
                      <span className="g" aria-label={c.status}>{c.status === 'flag' ? '!' : '○'}</span>
                      <span className="t">{c.text}</span>
                      {pending ? <input className="tick" type="checkbox" checked={ticked.has(i)} onChange={() => toggleTick(i)} aria-label="Checked" /> : <span />}
                      {renderEv(c)}
                    </li>
                  ))}
                </ul>
              )}
              {quiet.length > 0 && (
                <ul className="dp-quiet" aria-label="Checked">
                  {quiet.map(({ c, i }) => (<li key={i}><b>✓</b>{c.text}{renderEv(c)}</li>))}
                </ul>
              )}
              {passed.length > 0 && (
                <details className="dp-passed">
                  <summary>{passed.length} checks passed</summary>
                  <ul>{passed.map((t, k) => <li key={k}>{t}</li>)}</ul>
                </details>
              )}
            </>
          ) : isProposal ? null : (
            <p className="dp-prose">{[...parsed.intro.slice(1), ...parsed.points.map((p) => `${p.n}. ${p.text}`), ...parsed.rest].join('\n')}</p>
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
          {err && <div className="eg-err" style={{ margin: 0 }}>{err}</div>}
          {detail.shadowed && <div className="dp-shadow">Shadow mode ({detail.shadowed === 'matter' ? 'this case' : 'this sub-flow'}): logged for comparison only. <a href={`/conveyi/engine/${d.matterId}/shadow`} style={{ color: '#c7d2fe' }}>Shadow queue →</a></div>}
          {!detail.shadowed && !pending && (
            <div className="dp-out">
              {res ? (
                <>
                  <b>{OPTION_LABEL[res.option ?? ''] ?? pretty(res.option ?? d.resolution ?? d.status)}</b> · {who(res.by)} · {fmtWhen(res.at)}
                  {res.note && <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>Reason: {res.note}</div>}
                  {res.verification && <div style={{ marginTop: 4 }}>Verified via {VERIFICATION_METHOD_LABEL[res.verification.method] ?? res.verification.method}{res.verification.reference ? ` (${res.verification.reference})` : ''}</div>}
                  {detail.escalation && <div style={{ marginTop: 4 }}><a href={`/conveyi/decisions/${detail.escalation.eventId}`}>Escalation raised {fmtWhen(detail.escalation.at)} →</a></div>}
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
                <div>
                  <label style={{ fontSize: 12.5, fontWeight: 700 }}>Reason for “{optionLabel(choice)}”</label>
                  <textarea className="eg-ta" rows={2} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked, and why this is the right call…" />
                </div>
              )}
              {choice && !needsReason(choice) && <textarea className="eg-ta" rows={1} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note for the record…" />}
              <div className="dp-opts">
                {d.options.map((o) => (
                  <button
                    key={o}
                    className={`dp-btn${o === 'approve' || o === 'verify' ? ' primary' : ''}${choice === o ? ' on' : ''}`}
                    disabled={busy || !engaged || (isBank && o === 'verify' && !method) || (!!noteLines && o === 'approve' && !picked?.size)}
                    title={!engaged ? 'Read the source first' : isBank && o === 'verify' && !method ? 'Choose the verification method first' : noteLines && o === 'approve' && !picked?.size ? 'Tick at least one line, or reject the reading with a reason' : OPTION_HELP[o] ?? ''}
                    onClick={() => setChoice(o)}
                  >
                    {optionLabel(o)}
                  </button>
                ))}
                {choice && (
                  <button className="dp-btn primary" disabled={busy || !engaged || (needsReason(choice) && !note.trim())} onClick={() => resolve(choice)}>
                    {busy ? 'Recording…' : `Confirm: ${optionLabel(choice)}${choice === 'approve' && openQueries > 0 ? ` (withdraws ${openQueries} open ${openQueries === 1 ? 'query' : 'queries'})` : ''}`}
                  </button>
                )}
                {flagged > 0 && <span className="dp-gate" style={{ marginLeft: 'auto' }}>{flagged} to look at</span>}
              </div>
              {!engaged && <div className="dp-gate">Unlocks once the source has been read.</div>}
            </>
          )}
        </div>
      </div>

      {/* ── The source: one document at a time, picked from what the checks cite ── */}
      {d.kind !== 'proposal' && (
      <section className="dp-src" ref={srcRef} aria-label="Source document">
        <div className="dp-srcbar">
          {docIds.length > 1 ? (
            <select className="dp-pick" value={showing ?? ''} onChange={(e) => void showDoc(e.target.value, null)} aria-label="Document">
              {docIds.map((id) => <option key={id} value={id}>{docLabel(id)}</option>)}
            </select>
          ) : <strong style={{ color: '#0f172a', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{source?.fileName ?? 'Source'}</strong>}
          {showing && <a href={`/api/v1/documents/${showing}/raw`} target="_blank" rel="noopener noreferrer">open ↗</a>}
          {focusQuote && pdfFound === false && <span style={{ color: '#b45309', fontWeight: 700 }}>line not found on this copy (a scan has no text to search)</span>}
          {pending && (
            <span className="dp-gate">
              {engaged ? <span style={{ color: '#15803d', fontWeight: 700 }}><Check size={12} /></span> : <span className="bar"><i style={{ width: `${Math.min(100, (dwell / UI_DWELL_MS) * 100)}%` }} /></span>}
            </span>
          )}
        </div>
        <div className={`dp-srcbody${shownPdf ? ' pdf' : ''}`} onScroll={(e) => { if ((e.currentTarget as HTMLElement).scrollTop > 40) setScrolled(true); }}>
          {!source && <div className="eg-sub">{detail.shadowed ? 'The source is available from the timeline once this case or sub-flow leaves shadow mode.' : 'Loading the source…'}</div>}
          {shownOther && shownOther.content != null && <pre className="dp-pre">{withQuote(shownOther.content).map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <mark key={i} className="on">{p.text}</mark>))}</pre>}
          {shownOther && shownOther.content == null && shownOther.rawUrl && (shownOther.pdf ? <PdfView key={shownOther.id} url={shownOther.rawUrl} page={page} quote={focusQuote} quotes={focusAlts} quoteIndex={focusIndex} onFound={setPdfFound} /> : <iframe key={shownPdfSrc ?? ''} className="dp-frame" title="Document" src={shownPdfSrc ?? shownOther.rawUrl} />)}
          {!shownOther && pdfSrc && source?.rawUrl && <PdfView key={source.id} url={source.rawUrl} page={page} quote={focusQuote} quotes={focusAlts} quoteIndex={focusIndex} onFound={setPdfFound} />}
          {!shownOther && source && !pdfSrc && source.draftCheck && <CheckedDraft check={source.draftCheck} />}
          {!shownOther && source && !pdfSrc && !source.draftCheck && highlighted && (
            <pre className="dp-pre" ref={preRef}>
              {(focusQuote && source.content ? withQuote(source.content) : highlighted).map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <mark key={i} className={p.cite === -2 ? 'on' : undefined} data-cite={p.cite}>{p.text}</mark>))}
            </pre>
          )}
          {!shownOther && source && !pdfSrc && !source.draftCheck && !highlighted && (source.webUrl ? <iframe className="dp-frame" title="Source document" src={source.webUrl} /> : <div className="dp-lock">No inline preview is available for this document. Open the file itself.</div>)}
        </div>
      </section>
      )}
    </div>
  );
}
