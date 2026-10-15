'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, forgetApiCache } from '@/app/shared/engine/api';
import { BusyButton, BUSY_CSS } from '@/app/shared/engine/BusyButton';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { ActionsCard, ParetoCard, RagCard, TIME_CSS } from '@/app/shared/epa/TimeView';
import { paths } from '@/lib/paths';
import { ArrowLeft, Check, ChevronRight, Loader, X } from '@/app/shared/icons';
import { MIN_SENT_PER_WEEK, type Measurement } from '@/lib/server/epa/measure';
import type { ScanCounts } from '@/lib/server/workload/scan';

/**
 * The onboarding measurement (docs/epa-categories.md): each conveyancer scans two months of their own inbox and InTouch once,
 * and the firm sees a typical week in Analytics → Time's colours. Never one person's figures. Your own scan shows what it read,
 * and every email it read can be listed, so the result can be trusted; nobody is asked to mark anything. A thin scan is still
 * drawn, with a closable warning.
 */
interface Mine { status: string; messagesRead: number; classified: number; since: string; until: string; error: string | null; counts: ScanCounts }
interface Res { measurement: Measurement | null; team: number; scanned: number; mine: Mine | null }
interface ReadEmail { at: string; direction: 'out' | 'in'; roles: string[]; label: string; subject: string | null; people: string | null; webLink: string | null }

const RUNNING = ['SCANNING_SENT', 'SCANNING_INBOX', 'SCANNING_INTOUCH'];

const CSS = `
.ms{padding:18px 22px;max-width:1360px}
.ms h1{font-size:21px;font-weight:800;margin:0}
.ms-back{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;background:#f1f5f9;color:#0f172a}
.ms-back:hover{background:#e8ecf2}
.ms-head{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.ms-head .r{margin-left:auto;display:flex;gap:12px;align-items:center;font-size:13px;color:#475569;font-weight:700}
.ms-err{color:#b91c1c;font-size:13px}
.ms-go{border:0;background:#5A27E0;color:#fff;border-radius:9px;padding:8px 14px;font:inherit;font-size:13px;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.ms-go:hover{background:#4A1FC0}
.ms-card{background:#fff;border:1px solid #e6e8ee;border-radius:14px;padding:16px 20px;margin-top:16px}
.ms-card h2{font-size:15px;font-weight:800;margin:0 0 12px;color:#0f172a}
.ms-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.ms-step{border:1px solid #eef0f4;border-radius:12px;padding:12px 14px;display:flex;gap:10px;align-items:flex-start}
.ms-step.on{border-color:#c9b8fa;background:#fbf9ff}
.ms-step .ic{width:22px;height:22px;border-radius:99px;display:flex;align-items:center;justify-content:center;flex:none;background:#f1f5f9;color:#94a3b8}
.ms-step.done .ic{background:#dcfce7;color:#166534}
.ms-step.on .ic{background:#ede9fe;color:#5A27E0}
.ms-step b{display:block;font-size:13.5px;font-weight:800;color:#0f172a}
.ms-step span{display:block;font-size:12.5px;color:#475569;font-weight:600;margin-top:2px}
.ms-spin{animation:ms-spin 1s linear infinite}
@keyframes ms-spin{to{transform:rotate(360deg)}}
.ms-bar{height:6px;border-radius:99px;background:#eef0f4;overflow:hidden;margin-top:14px}
.ms-bar i{display:block;height:100%;background:#5A27E0;border-radius:99px;transition:width .4s}
.ms-read{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;font-size:13px;color:#334155;font-weight:600}
.ms-read b{color:#0f172a;font-weight:800}
.ms-read button{margin-left:auto;border:0;background:#f1f5f9;border-radius:9px;padding:7px 12px;font:inherit;font-size:13px;font-weight:700;color:#0f172a;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.ms-read button:hover{background:#e8ecf2}
.ms-t{width:100%;border-collapse:collapse;font-size:13px;margin-top:12px}
.ms-t th{text-align:left;font-size:12px;font-weight:800;color:#64748b;padding:6px 8px;border-bottom:1px solid #e6e8ee}
.ms-t td{padding:7px 8px;border-bottom:1px solid #f1f3f7;vertical-align:top}
.ms-t td.when{white-space:nowrap;color:#475569}
.ms-t a{color:#5A27E0;text-decoration:none;font-weight:600}
.ms-pg{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:10px;font-size:13px;color:#475569;font-weight:700}
.ms-pg button{border:0;background:#f1f5f9;border-radius:8px;padding:6px 11px;font:inherit;font-weight:700;cursor:pointer}
.ms-warn{display:flex;align-items:center;gap:10px;margin-top:14px;background:#fef9c3;border:1px solid #fde68a;color:#713f12;border-radius:10px;padding:9px 12px;font-size:13px;font-weight:700}
.ms-warn button{margin-left:auto;border:0;background:none;color:#713f12;cursor:pointer;display:inline-flex;padding:2px}
@media (max-width:1100px){.ms-steps{grid-template-columns:1fr}}
`;

const n = (x: number) => x.toLocaleString('en-GB');
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const ROLE: Record<string, string> = { client: 'Client', other_solicitor: 'Other Side', estate_agent: 'Agent', lender: 'Lender', broker: 'Broker', colleague: 'Colleague', third_party: 'Third Party' };

/** The three stages of a scan, each with what it has read. */
function Progress({ mine }: { mine: Mine }) {
  const c = mine.counts;
  const order = ['SCANNING_SENT', 'SCANNING_INBOX', 'SCANNING_INTOUCH'];
  const at = order.indexOf(mine.status);
  const state = (i: number) => (at === -1 ? 'done' : i < at ? 'done' : i === at ? 'on' : 'wait');
  const it = c.intouch;
  const intouchLine = it.state === 'not_connected' ? 'Not Connected' : it.state === 'failed' ? `Could Not Be Read: ${it.error}` : it.state === 'reading' ? `${n(it.read)} Of ${n(it.live)} Live Cases` : it.state === 'read' ? `${n(it.live)} Live Cases Read` : 'Waiting';
  const steps = [
    { title: 'Sent Items', line: `${n(c.sent)} Emails Read` },
    { title: 'Inbox', line: state(1) === 'wait' ? 'Waiting' : `${n(c.received)} Emails Read` },
    { title: 'InTouch', line: intouchLine },
  ];
  const share = at === -1 ? 1 : (at + 0.5) / 3;
  return (
    <section className="ms-card" aria-live="polite">
      <h2>Scanning {day(mine.since)} – {day(mine.until)}</h2>
      <div className="ms-steps">
        {steps.map((s, i) => {
          const st = i === 2 && it.state === 'not_connected' && at === -1 ? 'done' : state(i);
          return (
            <div key={s.title} className={`ms-step ${st}`}>
              <span className="ic">{st === 'done' ? <Check size={16} /> : st === 'on' ? <Loader size={16} className="ms-spin" /> : null}</span>
              <div><b>{s.title}</b><span>{s.line}</span></div>
            </div>
          );
        })}
      </div>
      <div className="ms-bar"><i style={{ width: `${Math.round(share * 100)}%` }} /></div>
    </section>
  );
}

/** Every email your scan read, newest first, with the label it was given. Read-only. */
function EmailsRead() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; pages: number; emails: ReadEmail[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    api<{ total: number; pages: number; emails: ReadEmail[] }>(`/epa/measurement/emails?page=${page}`).then(setData).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not read them.'));
  }, [page]);
  if (err) return <p className="ms-err">{err}</p>;
  if (!data) return <p className="tv-none">Reading your mailbox…</p>;
  return (
    <>
      <table className="ms-t">
        <thead><tr><th>When</th><th>Sent Or Received</th><th>Who With</th><th>Subject</th><th>Labelled As</th></tr></thead>
        <tbody>
          {data.emails.map((e, i) => (
            <tr key={i}>
              <td className="when">{when(e.at)}</td>
              <td>{e.direction === 'out' ? 'Sent' : 'Received'}</td>
              <td>{e.roles.map((r) => ROLE[r] ?? r).join(', ') || '—'}</td>
              <td>{e.webLink ? <a href={e.webLink} target="_blank" rel="noreferrer">{e.subject || '(No Subject)'}</a> : e.subject ?? '(No Longer In Your Mailbox)'}</td>
              <td>{e.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.pages > 1 && (
        <div className="ms-pg">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          Page {page} Of {data.pages}
          <button type="button" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </>
  );
}

export default function MeasurePage() {
  const [res, setRes] = useState<Res | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showEmails, setShowEmails] = useState(false);
  const [hideThin, setHideThin] = useState(false);
  const running = useRef(false);
  const load = useCallback(async () => {
    forgetApiCache();
    try { setRes(await api<Res>('/epa/measurement')); setErr(null); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not load the measurement.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // A running scan is driven from here, a slice at a time, while the page is open; each slice reports what it has read.
  const drive = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        const r = await api<{ done: boolean; status: string; messagesRead: number; classified: number; counts: ScanCounts; error: string | null }>('/workload/process', { method: 'POST' });
        setRes((cur) => (cur?.mine ? { ...cur, mine: { ...cur.mine, status: r.status, messagesRead: r.messagesRead, classified: r.classified, counts: r.counts, error: r.error } } : cur));
        if (r.done) break;
      }
    } catch (e) { setErr(e instanceof Error ? e.message : 'The scan stopped.'); }
    running.current = false;
    // Hold the finished stages on screen a moment, then the result.
    await new Promise((ok) => setTimeout(ok, 1200));
    await load();
  }, [load]);
  useEffect(() => { if (res?.mine && RUNNING.includes(res.mine.status)) void drive(); }, [res?.mine?.status, drive]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    try {
      setShowEmails(false);
      await api('/workload', { method: 'POST', body: JSON.stringify({ weeks: 9 }) });
      await load();
      return true;
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not start the scan.'); return false; }
  };
  const m = res?.measurement ?? null;
  const mine = res?.mine ?? null;
  const isRunning = !!mine && (RUNNING.includes(mine.status) || running.current);
  const finished = !!mine && ['CHECKING', 'COMPLETE'].includes(mine.status) && !running.current;
  const thin = !!m && m.sentPerPersonWeek < MIN_SENT_PER_WEEK;
  const c = mine?.counts;
  return (
    <div className="ms">
      <style>{ENGINE_CSS + BUSY_CSS + TIME_CSS + CSS}</style>
      <div className="ms-head">
        <a className="ms-back" href={paths.integrations} aria-label="Back To Tools"><ArrowLeft size={18} /></a>
        <h1>Measurement</h1>
        {res && (
          <span className="r">
            {res.scanned} Of {res.team} Conveyancers Scanned
            {!isRunning && <BusyButton className="ms-go" busyLabel="Starting…" doneLabel="Started" onClick={start}>{finished ? 'Scan Again' : 'Scan My Last Two Months'}</BusyButton>}
          </span>
        )}
      </div>
      {err && <p className="ms-err">{err}</p>}
      {mine?.status === 'FAILED' && mine.error && <p className="ms-err">The scan stopped: {mine.error}</p>}
      {!res && !err && <p className="tv-none">Loading…</p>}

      {/* While a scan runs, only its progress: the old result is not shown. */}
      {isRunning && mine && <Progress mine={mine} />}

      {!isRunning && (
        <>
          {finished && c && (
            <section className="ms-card">
              <div className="ms-read">
                <span>Your Scan: <b>{day(mine!.since)} – {day(mine!.until)}</b></span>
                <span><b>{n(c.sent)}</b> Sent</span>
                <span><b>{n(c.received)}</b> Received</span>
                <span><b>{n(c.setAside)}</b> Set Aside As Automated, Bulk Or Empty</span>
                <span><b>{n(c.classified)}</b> Labelled{c.model ? ` By ${/haiku/i.test(c.model) ? 'Claude Haiku' : c.model}` : ''}</span>
                <span>InTouch: <b>{c.intouch.state === 'read' ? `${n(c.intouch.live)} Live Cases Read` : c.intouch.state === 'failed' ? 'Could Not Be Read' : 'Not Connected'}</b></span>
                <button type="button" aria-expanded={showEmails} onClick={() => setShowEmails((v) => !v)}>{showEmails ? 'Hide' : 'See'} What It Read<ChevronRight size={16} style={{ transform: showEmails ? 'rotate(90deg)' : undefined }} /></button>
              </div>
              {showEmails && <EmailsRead />}
            </section>
          )}
          {res && !m && !mine && <p className="tv-none">No mailbox scanned yet.</p>}
          {m && thin && !hideThin && (
            <div className="ms-warn" role="status">
              <span>Not much data found: {m.sentPerPersonWeek} case emails sent a week per conveyancer.</span>
              <button type="button" aria-label="Close" onClick={() => setHideThin(true)}><X size={16} /></button>
            </div>
          )}
          {m && (
            <>
              <div className="tv-top">
                <RagCard title="A Typical Week" hours={m.hours} share={m.share} foot={`${m.people} ${m.people === 1 ? 'Conveyancer' : 'Conveyancers'} · ${m.contractedHours}h Week`} />
                <ParetoCard lines={m.lines} />
              </div>
              <ActionsCard lines={m.lines} timesHead="A Week" />
            </>
          )}
        </>
      )}
    </div>
  );
}
