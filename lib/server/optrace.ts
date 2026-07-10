/**
 * Dead-simple per-slice operation tracer for diagnosing onboarding timeouts. Wrap a call in
 * `timed(label, fn)` and it records how long it took; when a slice blows its budget, the slice's
 * error carries `traceString()` — completed ops with their ms, plus the ONE op still in flight
 * (the actual culprit). Module-level state is fine here: onboarding slices run one at a time.
 */
let ops: string[] = [];
let current: { label: string; at: number } | null = null;

export function resetTrace(): void {
  ops = [];
  current = null;
}

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const at = Date.now();
  current = { label, at };
  try {
    const r = await fn();
    const ms = Date.now() - at;
    ops.push(`${label}=${ms}ms`);
    // eslint-disable-next-line no-console
    console.log(`[optrace] ${label} ${ms}ms`);
    current = null;
    return r;
  } catch (e) {
    ops.push(`${label}=ERR@${Date.now() - at}ms`);
    current = null;
    throw e;
  }
}

/** Completed ops + the in-flight one (if any) — the in-flight entry names what's hung. */
export function traceString(): string {
  const parts = [...ops];
  if (current) parts.push(`${current.label}=INFLIGHT@${Date.now() - current.at}ms`);
  return parts.length ? parts.join(' | ') : '(no ops recorded)';
}
