/** Only ever redirect within this site — never to an attacker-supplied origin. */
export function safeNext(next: unknown, fallback = '/'): string {
  if (typeof next !== 'string' || next.length === 0) return fallback;
  if (!next.startsWith('/')) return fallback;
  if (next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}
