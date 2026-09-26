'use client';
import { useCallback, useEffect, useState } from 'react';
import type { Api, EngineEvent, EngineView } from './types';

/**
 * One matter's engine view, its log, and the command channel — shared by the work panel,
 * the issues tab and the documents tab so that a command recorded in one refreshes them all.
 */
export function useEngine(matterId: string, api: Api, onChanged?: () => void) {
  const [view, setView] = useState<EngineView | null>(null);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** What the last command came back with — success, a warning (recorded but a side effect failed), or an error. */
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string; at: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const [v, ev] = await Promise.all([api<EngineView>(`/matters/${matterId}/engine`), api<{ events: EngineEvent[] }>(`/matters/${matterId}/engine/events?limit=2000`)]);
      setView(v);
      setEvents(ev.events);
      setErr(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Could not load the engine view.');
    }
  }, [api, matterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const cmd = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const r = await api<{ events?: Array<{ type: string }>; warning?: string | null }>(`/matters/${matterId}/engine`, { method: 'POST', body: JSON.stringify(body) });
      await load();
      onChanged?.();
      const n = r.events?.length ?? 0;
      setNotice(r.warning ? { kind: 'warn', text: r.warning, at: Date.now() } : { kind: 'ok', text: n ? `Recorded${n > 1 ? ` (${n} events)` : ''}` : 'Nothing to record', at: Date.now() });
    } catch (e: unknown) {
      const text = e instanceof Error ? e.message : 'Command failed.';
      setErr(text);
      setNotice({ kind: 'err', text, at: Date.now() });
    } finally {
      setBusy(false);
    }
  }, [api, matterId, load, onChanged]);

  return { view, events, err, setErr, busy, setBusy, load, cmd, notice, clearNotice: () => setNotice(null) };
}
