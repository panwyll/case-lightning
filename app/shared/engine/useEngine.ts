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
    try {
      await api(`/matters/${matterId}/engine`, { method: 'POST', body: JSON.stringify(body) });
      await load();
      onChanged?.();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Command failed.');
    } finally {
      setBusy(false);
    }
  }, [api, matterId, load, onChanged]);

  return { view, events, err, setErr, busy, setBusy, load, cmd };
}
