'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Api, EngineEvent, EngineView } from './types';

/**
 * One matter's engine view, its log, and the command channel — shared by the work panel,
 * the issues tab and the documents tab so that a command recorded in one refreshes them all.
 */
/** What the combined case-view request carries besides the engine view and the log. */
export interface EngineBundle { row: unknown; detail: unknown; graph: unknown }

export function useEngine(matterId: string, api: Api, onChanged?: () => void, opts?: { onBundle?: (b: EngineBundle) => void }) {
  // The page's handler may be a new function each render; the load must not restart for that.
  const bundleRef = useRef(opts?.onBundle);
  bundleRef.current = opts?.onBundle;
  const wantsBundle = !!opts?.onBundle;
  const [view, setView] = useState<EngineView | null>(null);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** What the last command came back with — success, a warning (recorded but a side effect failed), or an error. */
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string; at: number } | null>(null);

  // Only the newest load applies: two actions in quick succession must not let an older read land last.
  const loadSeq = useRef(0);
  const inFlight = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      if (wantsBundle) {
        const b = await api<{ view: EngineView; events: EngineEvent[] } & EngineBundle>(`/matters/${matterId}/open`);
        if (seq !== loadSeq.current) return;
        setView(b.view);
        setEvents(b.events);
        bundleRef.current?.({ row: b.row, detail: b.detail, graph: b.graph });
      } else {
        const [v, ev] = await Promise.all([api<EngineView>(`/matters/${matterId}/engine`), api<{ events: EngineEvent[] }>(`/matters/${matterId}/engine/events?limit=2000`)]);
        if (seq !== loadSeq.current) return;
        setView(v);
        setEvents(ev.events);
      }
      setErr(null);
    } catch (e: unknown) {
      if (seq === loadSeq.current) setErr(e instanceof Error ? e.message : 'Could not load the case.');
    }
  }, [api, matterId, wantsBundle]);

  useEffect(() => {
    void load();
  }, [load]);

  // A confirmation is read once and goes; a warning lingers a little longer; an error stays until the next action.
  useEffect(() => {
    if (!notice || notice.kind === 'err') return;
    const t = setTimeout(() => setNotice(null), notice.kind === 'warn' ? 10_000 : 4_000);
    return () => clearTimeout(t);
  }, [notice]);

  // Busy while any command is in flight (a counter: overlapping commands do not clear each other's state).
  // It covers the refresh too, so nothing is clicked against a view the command has just changed.
  const cmd = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    inFlight.current += 1;
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const r = await api<{ events?: Array<{ type: string }>; warning?: string | null }>(`/matters/${matterId}/engine`, { method: 'POST', body: JSON.stringify(body) });
      await load();
      onChanged?.();
      const n = r.events?.length ?? 0;
      setNotice(r.warning ? { kind: 'warn', text: r.warning, at: Date.now() } : { kind: 'ok', text: n ? `Recorded${n > 1 ? ` (${n} events)` : ''}` : 'Nothing to record', at: Date.now() });
      return true;
    } catch (e: unknown) {
      const text = e instanceof Error ? e.message : 'Command failed.';
      setErr(text);
      setNotice({ kind: 'err', text, at: Date.now() });
      return false;
    } finally {
      inFlight.current -= 1;
      if (inFlight.current === 0) setBusy(false);
    }
  }, [api, matterId, load, onChanged]);

  return { view, events, err, setErr, busy, setBusy, load, cmd, notice, clearNotice: () => setNotice(null) };
}
