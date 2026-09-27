'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * A PDF drawn page by page with pdf.js, so a quoted line can be found in the text layer and
 * highlighted where it sits on the page. Falls back to the browser's own viewer if pdf.js
 * cannot load. A scanned PDF with no text layer draws, but nothing can be found on it: the
 * caller is told, and says so.
 */
type Box = { page: number; x: number; y: number; w: number; h: number };
type Pdfjs = typeof import('pdfjs-dist');

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function PdfView({ url, page, quote, quoteIndex = 0, onFound }: { url: string; page: number | null; quote: string | null; quoteIndex?: number; onFound?: (found: boolean | null) => void }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [pages, setPages] = useState<Array<{ n: number; w: number; h: number }>>([]);
  const docRef = useRef<import('pdfjs-dist').PDFDocumentProxy | null>(null);
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
        if (!canvas || canvas.dataset.drawn) continue;
        const p = await doc.getPage(pg.n);
        const vp = p.getViewport({ scale: pg.w / p.getViewport({ scale: 1 }).width });
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${vp.width}px`; canvas.style.height = `${vp.height}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        await p.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
        if (!live) return;
        canvas.dataset.drawn = '1';
      }
    })();
    return () => { live = false; };
  }, [pages]);

  // Find the quote in the text layer: the n-th run of items whose text contains it, on the cited page first, then anywhere.
  useEffect(() => {
    const doc = docRef.current; const lib = libRef.current;
    if (!doc || !lib || !pages.length) return;
    let live = true;
    (async () => {
      if (!quote) { setBoxes([]); onFound?.(null); scrollToPage(page); return; }
      const needle = norm(quote).slice(0, 80);
      const order = [...(page ? [page] : []), ...pages.map((p) => p.n).filter((n) => n !== page)];
      let seen = 0;
      for (const n of order) {
        const p = await doc.getPage(n);
        const pg = pages.find((x) => x.n === n)!;
        const vp = p.getViewport({ scale: pg.w / p.getViewport({ scale: 1 }).width });
        const tc = await p.getTextContent();
        const items = tc.items.filter((it): it is import('pdfjs-dist/types/src/display/api').TextItem => 'str' in it && typeof (it as { str?: string }).str === 'string');
        // Join items in reading order with single spaces, remember where each begins.
        let text = ''; const starts: number[] = [];
        for (const it of items) { starts.push(text.length); text += norm(it.str) + ' '; }
        let at = text.indexOf(needle);
        while (at >= 0) {
          if (seen === quoteIndex) {
            const end = at + needle.length;
            const hit = items.filter((_, i) => starts[i] < end && starts[i] + norm(items[i].str).length + 1 > at);
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
          at = text.indexOf(needle, at + 1);
        }
      }
      if (!live) return;
      setBoxes([]);
      onFound?.(false);
      scrollToPage(page);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, quote, quoteIndex, page]);

  const scrollToPage = (n: number | null, y: number | null = null) => {
    if (!n) return;
    const el = host.current?.querySelector<HTMLElement>(`[data-pg="${n}"]`);
    if (!el) return;
    const scroller = host.current?.closest('.dp-srcbody') as HTMLElement | null;
    if (scroller) scroller.scrollTo({ top: el.offsetTop + (y ?? 0) - 80, behavior: 'smooth' });
    else el.scrollIntoView({ block: 'start' });
  };

  if (failed) return <iframe className="dp-frame" title="Source document" src={`${url}#page=${page ?? 1}&view=FitH`} />;
  return (
    <div ref={host} className="pdfv">
      {pages.length === 0 && <div className="eg-sub" style={{ padding: 12 }}>Drawing the document…</div>}
      {pages.map((pg) => (
        <div key={pg.n} className="pdfv-page" data-pg={pg.n} style={{ width: pg.w, height: pg.h }}>
          <canvas data-page={pg.n} />
          {boxes.filter((b) => b.page === pg.n).map((b, i) => <div key={i} className="pdfv-hl" style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />)}
          <span className="pdfv-n">{pg.n}</span>
        </div>
      ))}
    </div>
  );
}

export const PDF_CSS = `
.pdfv{display:grid;gap:10px;padding:8px}
.pdfv-page{position:relative;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.12);margin:0 auto}
.pdfv-page canvas{display:block}
.pdfv-hl{position:absolute;background:rgba(253,224,71,.55);outline:2px solid rgba(202,138,4,.8);border-radius:2px;pointer-events:none}
.pdfv-n{position:absolute;right:6px;bottom:4px;font-size:10px;color:#94a3b8}
`;
