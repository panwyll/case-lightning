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
