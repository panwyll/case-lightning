'use client';
import { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from '@/app/shared/icons';

/**
 * A PDF drawn page by page with pdf.js, so a quoted line can be found in the text layer and
 * highlighted where it sits on the page. Falls back to the browser's own viewer if pdf.js
 * cannot load. A scanned PDF with no text layer draws, but nothing can be found on it: the
 * caller is told, and says so.
 */
type Box = { page: number; x: number; y: number; w: number; h: number };
type Pdfjs = typeof import('pdfjs-dist');

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function PdfView({ url, page, quote, quotes, quoteIndex = 0, onFound }: { url: string; page: number | null; quote: string | null; /** Fallbacks tried in order when `quote` is not on the page (a section number, the first words of the finding). */ quotes?: string[]; quoteIndex?: number; onFound?: (found: boolean | null) => void }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [pages, setPages] = useState<Array<{ n: number; w: number; h: number }>>([]);
  const docRef = useRef<import('pdfjs-dist').PDFDocumentProxy | null>(null);
  // Zoom (redrawn sharp at each level) and drag to move around a zoomed page.
  const [zoom, setZoom] = useState(1);
  const ZOOMS = [0.75, 1, 1.25, 1.5, 2, 2.5, 3];
  const step = (dir: 1 | -1) => setZoom((z) => { const i = ZOOMS.findIndex((x) => x >= z - 0.001); const next = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? 1 : i) + dir))]; return next; });
  const drag = useRef<{ x: number; y: number; left: number; top: number; el: HTMLElement } | null>(null);
  const scrollerOf = () => (host.current?.closest('.dp-srcbody') as HTMLElement | null) ?? host.current;
  const libRef = useRef<Pdfjs | null>(null);

  // Load the document once and draw every page at the pane's width.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const lib = await import('pdfjs-dist');
        // The worker is served from /public (copied from node_modules/pdfjs-dist/build by `npm run pdf:worker`); the bundler will not inline an ESM worker.
        lib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
        libRef.current = lib;
        const doc = await lib.getDocument({ url, withCredentials: true }).promise;
        if (!live) return;
        docRef.current = doc;
        const width = Math.max(320, (host.current?.clientWidth ?? 640) - 8);
        const list: Array<{ n: number; w: number; h: number }> = [];
        for (let n = 1; n <= Math.min(doc.numPages, 60); n++) {
          const p = await doc.getPage(n);
          const v0 = p.getViewport({ scale: 1 });
          const scale = width / v0.width;
          const vp = p.getViewport({ scale });
          list.push({ n, w: vp.width, h: vp.height });
        }
        if (live) setPages(list);
      } catch (err) {
        console.warn('[pdf] could not render with pdf.js; falling back to the browser viewer', err);
        if (live) setFailed(true);
      }
    })();
    return () => { live = false; };
  }, [url]);

  // Draw each page onto its canvas once the layout knows its size.
  useEffect(() => {
    const doc = docRef.current;
    if (!doc || !pages.length) return;
    let live = true;
    (async () => {
      for (const pg of pages) {
        const canvas = host.current?.querySelector<HTMLCanvasElement>(`canvas[data-page="${pg.n}"]`);
        if (!canvas || canvas.dataset.drawn === String(zoom)) continue;
        const p = await doc.getPage(pg.n);
        const vp = p.getViewport({ scale: (pg.w * zoom) / p.getViewport({ scale: 1 }).width });
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${vp.width}px`; canvas.style.height = `${vp.height}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        await p.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
        if (!live) return;
        canvas.dataset.drawn = String(zoom);
      }
    })();
    return () => { live = false; };
  }, [pages, zoom]);

  // Find the quote in the text layer: the n-th run of items whose text contains it, on the cited page first, then anywhere.
  useEffect(() => {
    const doc = docRef.current; const lib = libRef.current;
    if (!doc || !lib || !pages.length) return;
    let live = true;
    (async () => {
      // A quote may be abridged with an ellipsis ("ENFORCEMENT NOTICE served … remains OUTSTANDING"): search each run of it, longest first.
      const candidates = [quote, ...(quotes ?? [])].filter((q): q is string => !!q && q.trim().length > 1).flatMap((q) => { const runs = q.split(/\u2026|\.\.\./).map((r) => r.trim()).filter((r) => r.length >= 3); return runs.length > 1 ? runs.sort((x, y) => y.length - x.length) : [q]; });
      if (!candidates.length) { setBoxes([]); onFound?.(null); scrollToPage(page); return; }
      const order = [...(page ? [page] : []), ...pages.map((p) => p.n).filter((n) => n !== page)];
      // Text layers split words and even numbers into separate items: match with every space removed, and map back to the items.
      const layers = new Map<number, { items: import('pdfjs-dist/types/src/display/api').TextItem[]; compact: string; owner: number[]; vp: import('pdfjs-dist').PageViewport; unit: number }>();
      for (const n of order) {
        const p = await doc.getPage(n);
        const pg = pages.find((x) => x.n === n)!;
        const unit = pg.w / p.getViewport({ scale: 1 }).width;
        const vp = p.getViewport({ scale: unit });
        const tc = await p.getTextContent();
        const items = tc.items.filter((it): it is import('pdfjs-dist/types/src/display/api').TextItem => 'str' in it && typeof (it as { str?: string }).str === 'string');
        let compact = ''; const owner: number[] = [];
        items.forEach((it, i) => { for (const ch of it.str.toLowerCase()) { if (!/\s/.test(ch)) { compact += ch; owner.push(i); } } });
        layers.set(n, { items, compact, owner, vp, unit });
        if (!live) return;
      }
      for (const cand of candidates) {
      const needle = norm(cand).slice(0, 80).replace(/\s+/g, '');
      if (!needle) continue;
      let seen = 0;
      for (const n of order) {
        const L = layers.get(n)!; const { items, compact, owner, vp } = L; const pg = pages.find((x) => x.n === n)!; const p = await doc.getPage(n);
        let at = compact.indexOf(needle);
        while (at >= 0) {
          if (seen === quoteIndex) {
            const end = at + needle.length;
            const ids = new Set(owner.slice(at, end));
            const hit = items.filter((_, i) => ids.has(i));
            const out: Box[] = hit.map((it) => {
              const t = lib.Util.transform(vp.transform, it.transform);
              const h = Math.hypot(t[2], t[3]) || it.height * (pg.w / p.getViewport({ scale: 1 }).width);
              return { page: n, x: t[4], y: t[5] - h, w: it.width * (pg.w / p.getViewport({ scale: 1 }).width), h: h * 1.15 };
            });
            if (!live) return;
            setBoxes(out);
            onFound?.(out.length > 0);
            scrollToPage(n, out[0]?.y ?? null);
            return;
          }
          seen += 1;
          at = compact.indexOf(needle, at + 1);
        }
      }
      }
      if (!live) return;
      setBoxes([]);
      onFound?.(false);
      scrollToPage(page);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, quote, quotes?.join('|'), quoteIndex, page]);

  const scrollToPage = (n: number | null, y: number | null = null) => {
    if (!n) return;
    const el = host.current?.querySelector<HTMLElement>(`[data-pg="${n}"]`);
    if (!el) return;
    const scroller = host.current?.closest('.dp-srcbody') as HTMLElement | null;
    if (scroller) scroller.scrollTo({ top: el.offsetTop + (y ?? 0) * zoom - 80, behavior: 'smooth' });
    else el.scrollIntoView({ block: 'start' });
  };

  if (failed) return <iframe className="dp-frame" title="Source document" src={`${url}#page=${page ?? 1}&view=FitH`} />;
  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || zoom <= 1) return;
    const el = scrollerOf();
    if (!el) return;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, el };
    e.preventDefault();
  };
  const onMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    d.el.scrollLeft = d.left - (e.clientX - d.x);
    d.el.scrollTop = d.top - (e.clientY - d.y);
  };
  const onUp = () => { drag.current = null; };
  const onWheel = (e: React.WheelEvent) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); step(e.deltaY < 0 ? 1 : -1); } };
  return (
    <div ref={host} className={`pdfv${zoom > 1 ? ' pan' : ''}`} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onWheel={onWheel}>
      {pages.length > 0 && (
        <div className="pdfv-zoom" onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" aria-label="Zoom out" disabled={zoom <= ZOOMS[0]} onClick={() => step(-1)}><Minus size={16} /></button>
          <button type="button" className="pct" onClick={() => setZoom(1)} title="Fit to width">{Math.round(zoom * 100)}%</button>
          <button type="button" aria-label="Zoom in" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => step(1)}><Plus size={16} /></button>
        </div>
      )}
      {pages.length === 0 && <div className="eg-sub" style={{ padding: 12 }}>Drawing the document…</div>}
      {pages.map((pg) => (
        <div key={pg.n} className="pdfv-page" data-pg={pg.n} style={{ width: pg.w * zoom, height: pg.h * zoom }}>
          <canvas data-page={pg.n} />
          {boxes.filter((b) => b.page === pg.n).map((b, i) => <div key={i} className="pdfv-hl" style={{ left: b.x * zoom, top: b.y * zoom, width: b.w * zoom, height: b.h * zoom }} />)}
          <span className="pdfv-n">{pg.n}</span>
        </div>
      ))}
    </div>
  );
}

export const PDF_CSS = `
.pdfv{display:grid;gap:10px;padding:8px;position:relative;justify-content:start}
.pdfv.pan{cursor:grab}
.pdfv.pan:active{cursor:grabbing}
.pdfv-zoom{position:sticky;top:6px;left:6px;z-index:5;justify-self:start;display:inline-flex;align-items:center;background:#fff;border:1px solid #e2e8f0;border-radius:9px;box-shadow:0 4px 14px rgba(15,23,42,.12);overflow:hidden;margin-bottom:-38px}
.pdfv-zoom button{border:0;background:#fff;color:#334155;height:30px;min-width:30px;padding:0 6px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font:inherit;font-size:12px;font-weight:700}
.pdfv-zoom button:hover:not(:disabled){background:#f5f3ff;color:#5A27E0}
.pdfv-zoom button:disabled{color:#cbd5e1;cursor:default}
.pdfv-zoom .pct{min-width:48px;border-left:1px solid #f1f5f9;border-right:1px solid #f1f5f9}
.pdfv-page{position:relative;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.12);margin:0 auto}
.pdfv-page canvas{display:block;width:100%;height:100%}
.pdfv-hl{position:absolute;background:rgba(255,221,0,.42);mix-blend-mode:multiply;border-radius:1px;pointer-events:none}
.pdfv-n{position:absolute;right:6px;bottom:4px;font-size:10px;color:#94a3b8}
`;
