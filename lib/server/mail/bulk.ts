/**
 * Mail that is almost certainly not about a conveyancing case: newsletters, marketing,
 * notifications. The mailing systems that send it say so themselves (List-Unsubscribe,
 * List-Id, Precedence: bulk, Auto-Submitted), or the address does (no-reply, news@,
 * the big sending platforms).
 *
 * It is only set apart when nothing ties it to a case: a bulk-looking email that clearly
 * matches a case (a portal notification quoting our reference, say) stays in the queue.
 */
import { isNoiseAddress } from '../matching';

export function bulkReason(input: { headers: Array<{ name: string; value: string }> | null; fromAddress: string | null }): string | null {
  const h = (name: string) => input.headers?.find((x) => x.name.toLowerCase() === name)?.value?.toLowerCase() ?? null;
  if (h('list-unsubscribe') || h('list-id')) return 'mailing list';
  const precedence = h('precedence');
  if (precedence && /bulk|list|junk/.test(precedence)) return 'bulk mail';
  const auto = h('auto-submitted');
  if (auto && auto !== 'no') return 'automatic notification';
  if (input.fromAddress && isNoiseAddress(input.fromAddress)) return 'automatic sender';
  return null;
}

/**
 * The start of what the email actually says. A forwarded email opens with a rule and a
 * block of From: / Sent: / To: / Subject: lines; skip those, and say who it was from.
 */
export function readablePreview(body: string | null | undefined, fallback: string): { preview: string; forwardedFrom: string | null } {
  const text = (body ?? '').replace(/\r/g, '');
  if (!text.trim()) return { preview: fallback, forwardedFrom: null };
  const HEADER = /^\s*(from|sent|date|to|cc|bcc|subject|reply-to|importance)\s*:/i;
  const RULE = /^\s*([_\-=*]{5,}|-+\s*original message\s*-+|begin forwarded message:?|-+\s*forwarded message\s*-+)\s*$/i;
  let forwardedFrom: string | null = null;
  const kept: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || RULE.test(line)) continue;
    if (HEADER.test(line)) {
      if (!forwardedFrom && /^\s*from\s*:/i.test(line)) forwardedFrom = line.replace(/^\s*from\s*:\s*/i, '').replace(/\s*<[^>]*>\s*$/, '').trim() || null;
      continue;
    }
    kept.push(line);
    if (kept.join(' ').length > 260) break;
  }
  const preview = kept.join(' ').replace(/\s+/g, ' ').trim();
  return { preview: (preview || fallback).slice(0, 260), forwardedFrom };
}
