const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', pound: '£', euro: '€' };
const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** An email's HTML as a person would read it: paragraphs and line breaks kept, entities decoded. */
export function htmlToText(html?: string): string {
  if (!html) return '';
  if (!/<[a-z][\s\S]*>/i.test(html)) return decodeEntities(html).replace(/\r\n/g, '\n').trim();
  return decodeEntities(
    html
      .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, '\n')
      .replace(/<hr[^>]*>/gi, '\n________________\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The words this email adds, as text: Exchange's uniqueBody when it gave one, otherwise the
 * HTML cut at the reply markers Outlook, Gmail and Apple Mail put in, then the text markers.
 */
export function newWordsOf(message: { uniqueBody?: { content?: string } | null; body?: { content?: string } | null; bodyPreview?: string | null }): string {
  const unique = htmlToText(message.uniqueBody?.content ?? '');
  if (unique.trim()) return unique.trim();
  let html = message.body?.content ?? '';
  const cut = html.search(/<div[^>]+id=["']?(divRplyFwdMsg|appendonsend)|<div[^>]+class=["'][^"']*gmail_quote|<blockquote[^>]+type=["']?cite|<hr[^>]+id=["']?stopSpelling/i);
  if (cut > 0) html = html.slice(0, cut);
  const text = stripQuotedReply(htmlToText(html));
  return text.trim() || (message.bodyPreview ?? '').trim();
}

/** Strip HTML to plain text for AI consumption and email-body persistence. */
export function stripHtml(html?: string): string {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Flatten a list of Graph messages into a readable transcript. */
export function threadToText(messages: any[]): string {
  return messages
    .map((m) => {
      const at = m.receivedDateTime ?? m.sentDateTime ?? '';
      const from = m.from?.emailAddress?.address ?? 'unknown';
      const body = stripHtml(m.body?.content);
      return `[${at}] ${from}: ${body}`;
    })
    .join('\n\n');
}

/**
 * Return `desired` if it's free, else the first free `base_N` (macOS-style: name_1, name_2…).
 * `taken` is compared case-insensitively. If `desired` already ends in `_N`, we keep its base
 * and count up from there.
 */
export function uniqueName(taken: Iterable<string>, desired: string): string {
  const set = new Set([...taken].map((s) => s.toLowerCase()));
  const d = (desired || '').trim() || 'Untitled';
  if (!set.has(d.toLowerCase())) return d;
  const m = d.match(/^(.*?)_(\d+)$/);
  const base = m ? m[1] : d;
  let n = m ? parseInt(m[2], 10) : 0;
  let cand: string;
  do { n += 1; cand = `${base}_${n}`; } while (set.has(cand.toLowerCase()));
  return cand;
}

export function rowToSafeTemplate(row: any) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    subjectTemplate: row.subject_template,
    bodyTemplate: row.body_template,
    styleTag: row.style_tag,
    policyTags: row.policy_tags,
    attachDocTemplateIds: row.attach_doc_template_ids ?? [],
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}


/**
 * The new words in a reply: everything before the quoted history ("From: … Sent: …",
 * "-----Original Message-----", "On … wrote:", "> " lines). What was said before is already on
 * the case; reading it again would propose it again.
 */
export function stripQuotedReply(text: string): string {
  const t = text.replace(/\r\n/g, '\n');
  const markers = [
    /\n\s*-{2,}\s*Original Message\s*-{2,}/i,
    /\n\s*From:\s.+\n(?:\s*.+\n){0,4}?\s*(?:Sent|Date):\s/i,
    /\n\s*From:\s[^\n]*<[^>]+>\s*\n/i,
    /\n\s*On\s.{6,120}?\bwrote:\s*\n/i,
    /\n\s*Le\s.{6,120}?\ba écrit\s*:/i,
    /\n\s*>\s?[^\n]*\n(?:\s*>[^\n]*\n?){2,}/,
    /\n_{5,}\s*\n/,
  ];
  let cut = t.length;
  for (const m of markers) {
    const i = t.search(m);
    if (i >= 0 && i < cut) cut = i;
  }
  const head = t.slice(0, cut).trim();
  return head.length ? head : t.trim();
}
