/**
 * A tiny dependency-free PDF writer: one or more pages of monospaced text lines.
 * Used by the demo seed to produce real, openable "search results" and "offers" so the
 * source-document viewer has something to show. Not for production documents.
 */
export function textPdf(lines: string[], opts: { title?: string; linesPerPage?: number } = {}): Buffer {
  const perPage = opts.linesPerPage ?? 48;
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, lines.length); i += perPage) pages.push(lines.slice(i, i + perPage));
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // 1-based object number
  };
  const fontNo = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  const pagesNo = objects.length + 1 + pages.length * 2; // reserved after page+content objects
  const pageNos: number[] = [];
  for (const page of pages) {
    const content = ['BT', '/F1 10 Tf', '12 TL', '40 800 Td', ...page.map((l, i) => `${i ? 'T* ' : ''}(${esc(l)}) Tj`), 'ET'].join('\n');
    const contentNo = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    const pageNo = add(`<< /Type /Page /Parent ${pagesNo} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontNo} 0 R >> >> /Contents ${contentNo} 0 R >>`);
    pageNos.push(pageNo);
  }
  const realPagesNo = add(`<< /Type /Pages /Kids [${pageNos.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNos.length} >>`);
  if (realPagesNo !== pagesNo) throw new Error('pdf object numbering mismatch');
  const catalogNo = add(`<< /Type /Catalog /Pages ${pagesNo} 0 R >>`);
  const infoNo = add(`<< /Title (${esc(opts.title ?? 'Document')}) /Producer (CONVEYi demo) >>`);

  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `).join('\n')}\n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNo} 0 R /Info ${infoNo} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
