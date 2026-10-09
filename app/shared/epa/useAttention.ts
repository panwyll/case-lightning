'use client';
import { useEffect } from 'react';
import type { EpaWork } from '@/lib/server/epa/taxonomy';

/**
 * EPA's Focus evidence (docs/epa.md §2): while an item is open, in view, in the focused window and the person is active,
 * its time is theirs on it. The most recently opened item wins; idle (2 minutes without input) or hidden ends the span at
 * the last input. Spans are kept in memory and sent in one batch when the page is hidden, or every 5 minutes of use:
 * nothing is sent while nobody is working, and nothing is polled.
 */
export interface Attention extends EpaWork { item: string; matterId?: string | null }
type Out = { start: string; end: string; source: 'focus'; item: string; matterId: string | null; kind: string; of: string | null; action: string | null };

const IDLE_MS = 2 * 60_000;
const MIN_SPAN_MS = 5_000;
const FLUSH_MS = 5 * 60_000;
const ENDPOINT = '/api/v1/epa/spans';

const stack: Attention[] = [];
let current: { att: Attention; start: number } | null = null;
let lastInput = Date.now();
let idle = false;
let buffer: Out[] = [];
let lastFlush = Date.now();
let installed = false;

function wanted(): Attention | null {
  if (typeof document === 'undefined' || document.hidden || !document.hasFocus() || idle) return null;
  return stack[stack.length - 1] ?? null;
}

function close(at: number) {
  if (!current) return;
  const { att, start } = current;
  current = null;
  if (at - start < MIN_SPAN_MS) return;
  buffer.push({ start: new Date(start).toISOString(), end: new Date(at).toISOString(), source: 'focus', item: att.item, matterId: att.matterId ?? null, kind: att.kind, of: att.of ?? null, action: att.action ?? null });
}

function flush() {
  lastFlush = Date.now();
  if (!buffer.length) return;
  const body = JSON.stringify({ spans: buffer.splice(0, 200) });
  try {
    if (!navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: 'text/plain' }))) void fetch(ENDPOINT, { method: 'POST', body, keepalive: true, credentials: 'include' }).catch(() => {});
  } catch { /* evidence is best-effort: a lost batch is unmeasured time, shown as such */ }
}

function sync(at = Date.now()) {
  const w = wanted();
  // Idle ends a span at the last input: the two quiet minutes were not work.
  if (current && (!w || w.item !== current.att.item || w.kind !== current.att.kind)) close(idle ? Math.min(at, lastInput) : at);
  if (w && !current) current = { att: w, start: at };
  if (Date.now() - lastFlush >= FLUSH_MS) { if (current) { close(at); if (w) current = { att: w, start: at }; } flush(); }
}

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  let moved = 0;
  const input = () => {
    lastInput = Date.now();
    if (idle) { idle = false; sync(); }
  };
  for (const e of ['keydown', 'pointerdown', 'wheel', 'scroll', 'touchstart']) window.addEventListener(e, input, { passive: true, capture: true });
  window.addEventListener('pointermove', () => { const n = Date.now(); if (n - moved > 5_000) { moved = n; input(); } }, { passive: true });
  window.addEventListener('focus', () => sync());
  window.addEventListener('blur', () => sync());
  document.addEventListener('visibilitychange', () => { sync(); if (document.hidden) { close(Date.now()); flush(); } });
  window.addEventListener('pagehide', () => { close(Date.now()); flush(); });
  // A cheap local check, no network: has the person gone idle?
  window.setInterval(() => { if (!idle && Date.now() - lastInput > IDLE_MS) { idle = true; sync(); } else if (current) sync(); }, 15_000);
}

/** Send what is held now (the Efficiency page does, so its figures include the last few minutes). */
export async function flushAttention(): Promise<void> {
  if (current) { const att = current.att; close(Date.now()); if (wanted()?.item === att.item) current = { att, start: Date.now() }; }
  lastFlush = Date.now();
  if (!buffer.length) return;
  const body = JSON.stringify({ spans: buffer.splice(0, 200) });
  await fetch(ENDPOINT, { method: 'POST', body, credentials: 'include' }).catch(() => {});
}

/** Count this item's open, attended time as the person's work on it. Pass null when nothing is open. */
export function useAttention(att: Attention | null): void {
  const key = att ? `${att.item}|${att.kind}|${att.of ?? ''}|${att.action ?? ''}` : '';
  useEffect(() => {
    if (!att) return;
    install();
    stack.push(att);
    sync();
    return () => {
      const i = stack.lastIndexOf(att);
      if (i >= 0) stack.splice(i, 1);
      sync();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
