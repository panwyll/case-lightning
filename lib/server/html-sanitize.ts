/**
 * An allowlist HTML cleaner for pasted email signatures. Keeps what a signature is made of
 * (text formatting, tables for layout, links, images) and drops everything else: scripts,
 * styles blocks, frames, forms, comments, event handlers, and any link or image that is not
 * http(s), mailto, tel or an inline raster image. Anything it does not recognise is removed,
 * not escaped into view.
 */
const TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'br', 'p', 'div', 'span', 'font', 'small', 'big', 'sub', 'sup', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'col', 'colgroup', 'img', 'hr', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'center']);
const VOID = new Set(['br', 'img', 'hr', 'col']);
/** Elements dropped with everything inside them. */
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'svg', 'math', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'base', 'frame', 'frameset', 'applet', 'audio', 'video', 'canvas']);
const ATTRS = new Set(['href', 'src', 'alt', 'title', 'width', 'height', 'style', 'align', 'valign', 'colspan', 'rowspan', 'cellpadding', 'cellspacing', 'border', 'color', 'face', 'size', 'bgcolor', 'target', 'dir']);

const safeUrl = (v: string, attr: 'href' | 'src'): boolean => {
  const u = v.trim().replace(/[\u0000-\u001f\s]+/g, '').toLowerCase();
  if (attr === 'src') return /^https?:\/\//.test(u) || /^data:image\/(png|jpe?g|gif|webp);base64,/.test(u) || /^cid:/.test(u);
  return /^(https?:\/\/|mailto:|tel:|#)/.test(u);
};
const safeStyle = (v: string): string | null => {
  const s = v.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/expression\s*\(|javascript:|vbscript:|behavio(u)?r\s*:|-moz-binding|@import|url\s*\(/i.test(s)) return s.split(';').filter((d) => !/expression\s*\(|javascript:|vbscript:|behavio(u)?r\s*:|-moz-binding|@import|url\s*\(/i.test(d)).join(';').trim() || null;
  return s.trim() || null;
};
const escAttr = (v: string) => v.replace(/&(?!(#\d+|#x[0-9a-f]+|[a-z]+);)/gi, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escText = (v: string) => v.replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cleanAttrs(tag: string, raw: string): string {
  const out: string[] = [];
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase();
    let val = m[2] ?? m[3] ?? m[4] ?? '';
    if (!ATTRS.has(name)) continue;
    val = val.replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    if ((name === 'href' || name === 'src') && !safeUrl(val, name)) continue;
    if (name === 'href' && tag !== 'a') continue;
    if (name === 'src' && tag !== 'img') continue;
    if (name === 'style') { const st = safeStyle(val); if (!st) continue; val = st; }
    if (name === 'target') val = '_blank';
    out.push(`${name}="${escAttr(val)}"`);
  }
  if (tag === 'a' && out.some((a) => a.startsWith('target='))) out.push('rel="noopener noreferrer"');
  return out.length ? ` ${out.join(' ')}` : '';
}

export function sanitizeSignatureHtml(input: string): string {
  let html = input.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!doctype[^>]*>/gi, '').replace(/<\?[\s\S]*?\?>/g, '');
  // Drop whole elements that must never survive, contents and all.
  for (const t of DROP) html = html.replace(new RegExp(`<${t}\\b[\\s\\S]*?<\\/${t}\\s*>`, 'gi'), '').replace(new RegExp(`<${t}\\b[^>]*>`, 'gi'), '');
  const out: string[] = [];
  const open: string[] = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push(escText(html.slice(last, m.index)));
    last = re.lastIndex;
    const tag = m[1].toLowerCase();
    const closing = m[0][1] === '/';
    if (!TAGS.has(tag)) continue;
    if (closing) {
      const i = open.lastIndexOf(tag);
      if (i === -1) continue;
      while (open.length > i) out.push(`</${open.pop()}>`);
      continue;
    }
    out.push(`<${tag}${cleanAttrs(tag, m[2] ?? '')}>`);
    if (!VOID.has(tag)) open.push(tag);
  }
  out.push(escText(html.slice(last)));
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('').trim();
}
