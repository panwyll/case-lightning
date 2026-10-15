'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, forgetApiCache } from '@/app/shared/engine/api';
import { BusyButton, BUSY_CSS } from '@/app/shared/engine/BusyButton';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { ActionsCard, ParetoCard, RagCard, TIME_CSS } from '@/app/shared/epa/TimeView';
import { paths } from '@/lib/paths';
import type { Measurement } from '@/lib/server/epa/measure';

/**
 * The onboarding measurement (docs/epa-categories.md): each conveyancer scans two months of their own inbox and InTouch once,
 * and the firm sees a typical week in Analytics → Time's colours. Never one person's figures.
 */
interface Res {
  measurement: Measurement | null;
  team: number;
  scanned: number;
  mine: { status: string; messagesRead: number; classified: number; since: string; until: string; error: string | null } | null;
}
const RUNNING = ['SCANNING_SENT', 'SCANNING_INBOX', 'SCANNING_INTOUCH'];
const PHASE: Record<string, string> = { SCANNING_SENT: 'Reading Sent Items', SCANNING_INBOX: 'Reading The Inbox', SCANNING_INTOUCH: 'Reading InTouch' };

const CSS = `
.ms{padding:18px 22px;max-width:1360px}
.ms h1{font-size:21px;font-weight:800;margin:0}
.ms-head{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.ms-head .r{margin-left:auto;display:flex;gap:10px;align-items:center;font-size:13px;color:#475569;font-weight:700}
.ms-err{color:#b91c1c;font-size:13px}
.ms-go{border:0;background:#5A27E0;color:#fff;border-radius:9px;padding:8px 14px;font:inherit;font-size:13px;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.ms-go:hover{background:#4A1FC0}
`;


export default function MeasurePage() {
  const [res, setRes] = useState<Res | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const running = useRef(false);
  const load = useCallback(async () => {
    forgetApiCache();
    try { setRes(await api<Res>('/epa/measurement')); setErr(null); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load the measurement.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // A running scan is driven from here, a slice at a time, while the page is open.
  const drive = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        const r = await api<{ done: boolean; status: string; messagesRead: number; classified: number; error: string | null }>('/workload/process', { method: 'POST' });
        setRes((cur) => (cur ? { ...cur, mine: cur.mine ? { ...cur.mine, status: r.status, messagesRead: r.messagesRead, classified: r.classified, error: r.error } : cur.mine } : cur));
        if (r.done) break;
      }
    } catch (e) { setErr(e instanceof Error ? e.message : 'The scan stopped.'); }
    running.current = false;
    await load();
  }, [load]);
  useEffect(() => { if (res?.mine && RUNNING.includes(res.mine.status)) void drive(); }, [res?.mine?.status, drive]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    try { await api('/workload', { method: 'POST', body: JSON.stringify({ weeks: 9 }) }); await load(); return true; } catch (e) { setErr(e instanceof Error ? e.message : 'Could not start the scan.'); return false; }
  };
  const m = res?.measurement ?? null;
  const mine = res?.mine ?? null;
  const isRunning = !!mine && RUNNING.includes(mine.status);
  return (
    <div className="ms">
      <style>{ENGINE_CSS + BUSY_CSS + TIME_CSS + CSS}</style>
      <div className="ms-head">
        <h1>Measurement</h1>
        {res && (
          <span className="r">
            {res.scanned} Of {res.team} Conveyancers Scanned
            {isRunning
              ? <span>{PHASE[mine!.status]} · {mine!.messagesRead.toLocaleString('en-GB')} Emails Read</span>
              : <BusyButton className="ms-go" busyLabel="Starting…" doneLabel="Started" onClick={start}>{mine && ['CHECKING', 'COMPLETE'].includes(mine.status) ? 'Scan Again' : 'Scan My Last Two Months'}</BusyButton>}
          </span>
        )}
      </div>
      {err && <p className="ms-err">{err}</p>}
      {mine?.status === 'FAILED' && mine.error && <p className="ms-err">The scan stopped: {mine.error}</p>}
      {!res && !err && <p className="tv-none">Loading…</p>}
      {res && !m && !isRunning && <p className="tv-none">No mailbox scanned yet.</p>}
      {m && (
        <>
          <div className="tv-top">
            <RagCard title="A Typical Week" hours={m.hours} share={m.share} foot={`${m.people} ${m.people === 1 ? 'Conveyancer' : 'Conveyancers'} · ${m.contractedHours}h Week`} />
            <ParetoCard lines={m.lines} />
          </div>
          <ActionsCard lines={m.lines} timesHead="A Week" />
        </>
      )}
      <p style={{ marginTop: 14 }}><a href={paths.baseline} className="tv-none" style={{ textDecoration: 'none', color: '#5A27E0', fontWeight: 700 }}>Check A Sample Of Your Emails</a></p>
    </div>
  );
}
