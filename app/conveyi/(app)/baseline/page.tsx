'use client';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, forgetApiCache } from '@/app/shared/engine/api';
import { BusyButton } from '@/app/shared/engine/BusyButton';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { paths } from '@/lib/paths';
import type { Report, CategoryLine } from '@/lib/server/workload/model';
import type { Handover } from '@/lib/server/workload/handover';

/**
 * The workload baseline (docs/workload-baseline.md): from the conveyancer's own mailbox, how much of the
 * week goes on email that does not need a conveyancer, what it costs, and what CONVEYi has taken since.
 * Every figure is shown with its basis; the method and settings sit under it.
 */
type Spec = { out: Record<string, { label: string; what: string; tier: string }>; in: Record<string, { label: string; what: string }>; tiers: Record<string, string>; filtered: Record<string, string> };
type ScanView = { id: string; status: string; since: string; until: string; messagesRead: number; classified: number; maxMessages: number; model: string | null; promptVersion: string | null; error: string | null; createdAt: string; completedAt: string | null };
interface Res {
  me: string; person: { userId: string; name: string }; isOwn: boolean; admin: boolean;
  scan: ScanView | null; baselineScan: ScanView | null; baseline: Report | null;
  later: { scan: ScanView; report: Report } | null; handover: Handover | null;
  estimates: Record<string, number>; people: Array<{ id: string; name: string; scanned: boolean; freedHoursPerWeek: number | null; emails: number | null }> | null; spec: Spec;
}
type CheckEmail = { id: string; category: string; checked: string | null; subject: string; people: string; sentAt: string | null; text: string; webLink: string | null; gone: boolean };

const CSS = `
.bl{padding:18px 22px;max-width:1240px}
.bl h1{font-size:21px;font-weight:800;margin:0}
.bl h2{font-size:15px;font-weight:800;margin:22px 0 8px;color:#0f172a}
.bl-head{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.bl-head .r{margin-left:auto;display:flex;gap:8px;align-items:center}
.bl-card{background:#fff;border:1px solid #e6e8ee;border-radius:14px;padding:14px 16px}
.bl-say{font-size:15px;line-height:1.6;color:#0f172a;margin:14px 0 4px}
.bl-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-top:12px}
.bl-tile{background:#fff;border:1px solid #e6e8ee;border-radius:12px;padding:10px 12px}
.bl-tile .k{font-size:11.5px;color:#64748b;font-weight:700}
.bl-tile .v{font-size:22px;font-weight:800;color:#0f172a;margin-top:2px}
.bl-tile .s{font-size:12px;color:#64748b;margin-top:2px}
.bl-tile.hi{border-color:#c7b8fb;background:#faf8ff}
.bl table{border-collapse:collapse;width:100%;font-size:13px}
.bl th{text-align:right;padding:7px 9px;background:#f8fafc;color:#334155;font-weight:700;white-space:nowrap;border-bottom:1px solid #e8eaf0}
.bl td{text-align:right;padding:6px 9px;border-bottom:1px solid #f1f3f7;white-space:nowrap}
.bl th:first-child,.bl td:first-child{text-align:left;white-space:normal}
.bl td.tier{text-align:left;color:#475569}
.bl tr.tot td{font-weight:800;border-top:1px solid #cbd5e1}
.bl .basis{font-size:11px;color:#64748b;display:block}
.bl .est{width:64px;text-align:right;padding:3px 6px;border:1px solid #cbd5e1;border-radius:6px;font:inherit}
.bl-scroll{overflow-x:auto;border:1px solid #e8eaf0;border-radius:10px;background:#fff}
.bl-meth{font-size:13px;color:#334155;line-height:1.6}
.bl-meth dt{font-weight:700;margin-top:6px}
.bl-meth dd{margin:0}
.bl-chk{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px}
.bl-chk pre{white-space:pre-wrap;font:inherit;font-size:13.5px;line-height:1.55;margin:8px 0 0;max-height:340px;overflow:auto;background:#f8fafc;border-radius:8px;padding:10px}
.bl-chk select{width:100%}
.bl-bar{height:8px;border-radius:99px;background:#eef1f5;overflow:hidden;margin-top:8px}
.bl-bar i{display:block;height:100%;background:#5A27E0}
.bl-err{color:#b91c1c;font-size:13px}
.bl .onlyprint{display:none}
@media print{.bl .noprint{display:none!important}.bl .onlyprint{display:inline}.bl{padding:0}}
`;

const pct = (x: number | null | undefined, dp = 0) => (x == null ? '—' : `${(x * 100).toFixed(dp)}%`);
const hrs = (x: number | null | undefined) => (x == null ? '—' : `${x.toFixed(1)}h`);
const gbp = (p: number | null | undefined) => (p == null ? '—' : `£${Math.round(p / 100).toLocaleString('en-GB')}`);
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const BASIS: Record<string, string> = { timed: 'Timed in Outlook', estimate: 'Typing + your estimate', typing_only: 'Typing only (estimate pending)' };
const RUNNING = ['SCANNING_SENT', 'SCANNING_INBOX'];

export default function BaselinePage() {
  return <Suspense fallback={<div style={{ padding: 20, color: '#64748b' }}>Loading…</div>}><Baseline /></Suspense>;
}

function Baseline() {
  const params = useSearchParams();
  const router = useRouter();
  const person = params.get('person') ?? '';
  const [res, setRes] = useState<Res | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [weeks, setWeeks] = useState(13);
  const running = useRef(false);

  const load = useCallback(async () => {
    try { forgetApiCache(); setRes(await api<Res>(`/workload${person ? `?person=${person}` : ''}`)); setErr(null); }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not load the baseline.'); }
  }, [person]);
  useEffect(() => { void load(); }, [load]);

  // A running scan is driven from the page, one slice at a time, until it is done.
  const drive = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (let fails = 0; ;) {
        try {
          const r = await api<{ done: boolean; status: string; messagesRead?: number; classified?: number; error?: string | null }>('/workload/process', { method: 'POST' });
          setRes((cur) => (cur && cur.scan ? { ...cur, scan: { ...cur.scan, status: r.status, messagesRead: r.messagesRead ?? cur.scan.messagesRead, classified: r.classified ?? cur.scan.classified, error: r.error ?? null } } : cur));
          fails = 0;
          if (r.done) break;
        } catch (e: unknown) {
          const status = (e as { status?: number }).status ?? 0;
          if (++fails > 4 || (status && status < 500 && status !== 408 && status !== 429)) { setErr(e instanceof Error ? e.message : 'The scan stopped.'); break; }
          await new Promise((ok) => setTimeout(ok, 1500 * fails));
        }
      }
    } finally { running.current = false; await load(); }
  }, [load]);
  useEffect(() => { if (res?.isOwn && res.scan && RUNNING.includes(res.scan.status)) void drive(); }, [res?.isOwn, res?.scan?.status, drive]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err && !res) return <div className="eg-err" style={{ margin: 20 }}>{err}</div>;
  if (!res) return <div style={{ padding: 20, color: '#64748b' }}>Loading…</div>;
  const { baseline, scan, spec } = res;
  const scanning = !!scan && RUNNING.includes(scan.status);
  const checking = res.isOwn && scan?.status === 'CHECKING';

  const start = async (body: Record<string, unknown>) => { try { await api('/workload', { method: 'POST', body: JSON.stringify(body) }); await load(); return true; } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not start the scan.'); return false; } };

  return (
    <div className="bl">
      <style>{ENGINE_CSS + CSS}</style>
      <div className="bl-head">
        <h1>Baseline{res.isOwn ? '' : ` · ${res.person.name}`}</h1>
        <div className="r noprint">
          {res.people && <select className="ep-input" value={person || res.me} onChange={(e) => router.push(`${paths.baseline}${e.target.value === res.me ? '' : `?person=${e.target.value}`}`)} style={{ margin: 0 }}>
            {res.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.scanned ? '' : ' (Not Scanned)'}</option>)}
          </select>}
          {baseline && <button className="ep-btn" style={{ margin: 0 }} onClick={() => window.print()}>Print</button>}
        </div>
      </div>
      {err && <p className="bl-err">{err}</p>}

      {res.isOwn && !scanning && !baseline && (
        <div className="bl-card noprint" style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 13 }}>Weeks To Read <select className="ep-input" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} style={{ margin: '0 0 0 6px' }}>{[4, 8, 13, 26].map((w) => <option key={w} value={w}>{w}</option>)}</select></label>
            <BusyButton busyLabel="Starting…" doneLabel="Started" onClick={() => start({ weeks })}>Scan My Mailbox</BusyButton>
          </div>
        </div>
      )}

      {scanning && scan && (
        <div className="bl-card" style={{ marginTop: 14 }}>
          <b>{scan.status === 'SCANNING_SENT' ? 'Reading Sent Items' : 'Reading The Inbox'}</b> · {scan.messagesRead.toLocaleString('en-GB')} read · {scan.classified.toLocaleString('en-GB')} classified
          <div className="bl-bar"><i style={{ width: `${Math.min(100, (scan.messagesRead / scan.maxMessages) * 100)}%` }} /></div>
          {res.isOwn && <button className="ep-btn noprint" style={{ margin: '10px 0 0' }} onClick={async () => { await api('/workload', { method: 'DELETE' }); await load(); }}>Cancel</button>}
        </div>
      )}
      {scan?.status === 'FAILED' && <p className="bl-err">The scan stopped: {scan.error}</p>}

      {checking && scan && <CheckSample scanId={scan.id} spec={spec} onDone={load} />}

      {baseline && res.baselineScan && <ReportView res={res} report={baseline} scan={res.baselineScan} onSaved={load} />}

      {baseline && res.isOwn && !scanning && (
        <div className="noprint" style={{ marginTop: 16 }}>
          <BusyButton className="ep-btn" busyLabel="Starting…" doneLabel="Started" onClick={() => start({ sinceBaseline: true })}>Re-Scan Since Go-Live</BusyButton>
        </div>
      )}

      {res.people && res.people.length > 1 && (
        <>
          <h2>The Team</h2>
          <div className="bl-scroll"><table><thead><tr><th>Person</th><th>Emails Read</th><th>Freed Hours A Week</th></tr></thead><tbody>
            {res.people.map((p) => <tr key={p.id}><td><a href={`${paths.baseline}${p.id === res.me ? '' : `?person=${p.id}`}`}>{p.name}</a></td><td>{p.emails?.toLocaleString('en-GB') ?? 'Not Scanned'}</td><td>{hrs(p.freedHoursPerWeek)}</td></tr>)}
          </tbody></table></div>
        </>
      )}
    </div>
  );
}

/** The report: the statement, the headline figures, every category with its basis, and the method. */
function ReportView({ res, report: r, scan, onSaved }: { res: Res; report: Report; scan: ScanView; onSaved: () => void }) {
  const { spec } = res;
  const counted = r.lines.filter((l) => l.tier !== 'excluded');
  const written = r.lines.reduce((a, l) => a + l.count, 0);
  const auto = r.lines.filter((l) => l.tier === 'automated' && l.count > 0).sort((a, b) => b.corrected - a.corrected);
  const st = r.settings;
  const totalWeek = counted.reduce((a, l) => a + l.hoursPerWeek, 0);
  const pending = counted.filter((l) => l.count > 0 && l.basis === 'typing_only' && l.tier !== 'conveyancer').length;
  const you = res.isOwn ? 'You' : res.person.name;
  const statement = `We read ${r.read.total.toLocaleString('en-GB')} emails from ${day(r.window.since)} to ${day(r.window.until)} (${r.window.workingWeeks} working weeks). ${you} wrote ${written.toLocaleString('en-GB')} of them${auto.length ? `: ${auto.slice(0, 5).map((l) => `${Math.round(l.corrected).toLocaleString('en-GB')} ${l.label.toLowerCase()}`).join(', ')}` : ''}. Typing the ones CONVEYi sends takes ${hrs(r.tiers.automated.hoursPerWeekFloor)} a week; with finding what to say it is ${hrs(r.tiers.automated.hoursPerWeek)}. Freed in all: ${hrs(r.freed.hoursPerWeek)} a week, ${pct(r.freed.shareOfWeek)} of a ${st.contractedHours}-hour week${r.afterHoursShare ? `, and ${pct(r.afterHoursShare)} of ${res.isOwn ? 'your' : 'their'} case email goes after hours` : ''}.${r.freed.completionsPerMonth != null ? ` At ${st.hoursPerCompletion} hours a completion that is ${r.freed.completionsPerMonth.toFixed(1)} more completions a month${r.freed.firmPerMonthPennies != null ? `: ${gbp(r.freed.firmPerMonthPennies)} to the firm` : ''}${r.freed.payPerMonthPennies != null ? ` and ${gbp(r.freed.payPerMonthPennies)} to ${res.isOwn ? 'you' : 'them'}` : ''}, a month.` : ''}`;

  return (
    <>
      <p className="bl-say">{statement}</p>
      <div className="bl-tiles">
        <Tile k="Emails Read" v={r.read.total.toLocaleString('en-GB')} s={`${r.read.sent.toLocaleString('en-GB')} sent · ${r.read.received.toLocaleString('en-GB')} received`} />
        <Tile k="Case Email A Week" v={hrs(totalWeek)} s={`${pct(totalWeek / st.contractedHours)} of ${st.contractedHours}h · floor ${hrs(counted.reduce((a, l) => a + l.hoursPerWeekFloor, 0))}`} />
        <Tile k="Freed A Week" v={hrs(r.freed.hoursPerWeek)} s={`${pct(r.freed.shareOfWeek)} of the week · floor ${hrs(r.freed.hoursPerWeekFloor)}`} hi />
        <Tile k="After Hours" v={pct(r.afterHoursShare)} s={`outside ${st.workdayStart}–${st.workdayEnd}, weekdays`} />
        <Tile k="Extra Completions A Month" v={r.freed.completionsPerMonth == null ? '—' : r.freed.completionsPerMonth.toFixed(1)} s={st.hoursPerCompletion ? `at ${st.hoursPerCompletion}h a completion` : 'set hours per completion'} hi />
        <Tile k="To The Firm A Month" v={gbp(r.freed.firmPerMonthPennies)} s={st.feePerCompletionPennies != null ? `at ${gbp(st.feePerCompletionPennies)} a completion` : 'set the fee per completion'} />
        <Tile k={res.isOwn ? 'To You A Month' : 'To Them A Month'} v={gbp(r.freed.payPerMonthPennies)} s={st.payPerCompletionPennies != null ? `at ${gbp(st.payPerCompletionPennies)} a completion` : 'set pay per completion'} />
        <Tile k="Classification Checked" v={r.accuracy.rate == null ? 'Not Yet' : pct(r.accuracy.rate)} s={r.accuracy.rate == null ? `${r.accuracy.asked} drawn to check` : `${r.accuracy.agreed} of ${r.accuracy.checked} agreed · 95% ${pct(r.accuracy.low)}–${pct(r.accuracy.high)}`} />
      </div>
      {pending > 0 && res.isOwn && <p className="noprint" style={{ fontSize: 13, color: '#92400e', margin: '10px 0 0' }}>{pending} {pending === 1 ? 'kind has' : 'kinds have'} no estimate yet: enter your minutes below.</p>}

      <h2>What You Wrote</h2>
      <Lines r={r} res={res} onSaved={onSaved} />

      <h2>What Came In</h2>
      <div className="bl-scroll"><table><thead><tr><th>Kind</th><th>Emails</th><th>A Week</th></tr></thead><tbody>
        {r.received.filter((x) => x.count > 0).map((x) => <tr key={x.category}><td>{spec.in[x.category]?.label ?? x.category}</td><td>{x.count.toLocaleString('en-GB')}</td><td>{x.perWeek}</td></tr>)}
      </tbody></table></div>

      {(res.handover || res.later) && <AfterGoLive res={res} base={r} />}

      <h2>How This Is Worked Out</h2>
      <div className="bl-card bl-meth">
        <dl>
          <dt>Read</dt><dd>Sent Items and the Inbox, {day(scan.since)} to {day(scan.until)}; {r.read.total.toLocaleString('en-GB')} messages. Set aside by rule before classifying: {Object.entries(r.read.filtered).map(([k, n]) => `${n.toLocaleString('en-GB')} ${(spec.filtered[k] ?? k).toLowerCase()}`).join(', ') || 'none'}. Only the words each message added count, without quoted replies or the signature. No message text is kept.</dd>
          <dt>Classified</dt><dd>{r.read.classified.toLocaleString('en-GB')} messages by {scan.model ?? 'the classify model'} (method {scan.promptVersion ?? '—'}), ten at a time. {r.accuracy.rate == null ? 'The random sample has not been checked yet: counts are as classified.' : `${r.accuracy.agreed} of a random ${r.accuracy.checked} agreed with the conveyancer (95% interval ${pct(r.accuracy.low)}–${pct(r.accuracy.high)}); counts are corrected by what the sample found.`}</dd>
          <dt>Time</dt><dd>Typing (the floor): words ÷ {st.wpm} words a minute. Finding what to say: the conveyancer's own estimate per kind. Timed: Outlook's draft-to-send minutes (median of drafts open 15 seconds to 45 minutes), used once a kind has 10. Not counted: interruptions, reading what prompted the reply, phone calls.</dd>
          <dt>The Week</dt><dd>Per week = count ÷ {r.window.workingWeeks} working weeks (England and Wales, bank holidays excluded). Share of a {st.contractedHours}-hour week. After hours: sent outside {st.workdayStart}–{st.workdayEnd} on a working day, UK time.</dd>
          <dt>Freed</dt><dd>Everything CONVEYi sends, in full; for what it drafts, the typing only. Hours a month = hours a week × 52 ÷ 12. Extra completions = hours a month ÷ {st.hoursPerCompletion ?? '(hours per completion not set)'} hours. Capacity, not a forecast: it assumes the work is there to fill the hours.</dd>
        </dl>
        {res.admin && <a className="noprint" href={`${paths.admin}?tab=firm`}>Firm Figures</a>}
      </div>
    </>
  );
}

function Tile({ k, v, s, hi }: { k: string; v: string; s?: string; hi?: boolean }) {
  return <div className={`bl-tile${hi ? ' hi' : ''}`}><div className="k">{k}</div><div className="v">{v}</div>{s && <div className="s">{s}</div>}</div>;
}

/** Every kind of email written: how many, the minutes and their basis, the hours. The conveyancer's own estimates are entered here. */
function Lines({ r, res, onSaved }: { r: Report; res: Res; onSaved: () => void }) {
  const [est, setEst] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(res.estimates).map(([k, v]) => [k, String(v)])));
  const [err, setErr] = useState<string | null>(null);
  const lines = r.lines.filter((l) => l.count > 0 || l.tier !== 'excluded');
  const dirty = Object.keys({ ...est, ...res.estimates }).some((k) => (est[k] ?? '') !== (res.estimates[k] == null ? '' : String(res.estimates[k])));
  const save = async () => {
    const body = Object.fromEntries(r.lines.map((l) => [l.category, est[l.category]?.trim() ? Number(est[l.category]) : null]));
    if (Object.values(body).some((v) => v != null && (!Number.isFinite(v) || v < 0 || v > 240))) { setErr('Minutes are 0 to 240.'); return false; }
    try { await api('/workload/estimates', { method: 'PUT', body: JSON.stringify({ estimates: body }) }); setErr(null); onSaved(); return true; } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not save.'); return false; }
  };
  const tot = (f: (l: CategoryLine) => number) => lines.filter((l) => l.tier !== 'excluded').reduce((a, l) => a + f(l), 0);
  return (
    <>
      <div className="bl-scroll"><table>
        <thead><tr><th>Kind</th><th style={{ textAlign: 'left' }}>CONVEYi</th><th>Emails</th><th>A Week</th><th>Words</th><th>Typing (Min)</th><th>Finding What To Say (Min)</th><th>Timed (Min)</th><th>Minutes Used</th><th>Hours A Week</th><th>Of The Week</th><th>After Hours</th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.category} title={res.spec.out[l.category]?.what}>
              <td>{l.label}</td>
              <td className="tier">{res.spec.tiers[l.tier]}</td>
              <td>{l.corrected !== l.count ? <>{Math.round(l.corrected).toLocaleString('en-GB')}<span className="basis">{l.count} as classified</span></> : l.count.toLocaleString('en-GB')}</td>
              <td>{l.perWeek}</td>
              <td>{l.avgWords}</td>
              <td>{l.typingMinutes.toFixed(1)}</td>
              <td>{res.isOwn && l.tier !== 'excluded'
                ? <><input className="est noprint" inputMode="decimal" value={est[l.category] ?? ''} onChange={(e) => setEst({ ...est, [l.category]: e.target.value })} placeholder="—" aria-label={`Minutes finding what to say for ${l.label}`} /><span className="onlyprint">{est[l.category] || '—'}</span></>
                : (l.estimateMinutes ?? '—')}</td>
              <td>{l.timed ? <>{l.timedMedian?.toFixed(1)}<span className="basis">{l.timed} timed</span></> : '—'}</td>
              <td>{l.minutes.toFixed(1)}<span className="basis">{BASIS[l.basis]}</span></td>
              <td>{l.tier === 'excluded' ? '—' : <>{l.hoursPerWeek.toFixed(2)}<span className="basis">floor {l.hoursPerWeekFloor.toFixed(2)}</span></>}</td>
              <td>{l.tier === 'excluded' ? '—' : pct(l.shareOfWeek, 1)}</td>
              <td>{l.afterHours}</td>
            </tr>
          ))}
          <tr className="tot"><td>Case Email</td><td /><td>{Math.round(tot((l) => l.corrected)).toLocaleString('en-GB')}</td><td>{tot((l) => l.perWeek).toFixed(1)}</td><td /><td /><td /><td /><td /><td>{tot((l) => l.hoursPerWeek).toFixed(1)}</td><td>{pct(tot((l) => l.hoursPerWeek) / r.settings.contractedHours, 1)}</td><td>{tot((l) => l.afterHours)}</td></tr>
        </tbody>
      </table></div>
      {res.isOwn && (dirty || err) && <div className="noprint" style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}><BusyButton busyLabel="Saving…" doneLabel="Saved" onClick={save}>Save Estimates</BusyButton>{err && <span className="bl-err">{err}</span>}</div>}
    </>
  );
}

/** Since the baseline: what CONVEYi sent on this person's cases, and a re-scan of their own Sent Items against the baseline. */
function AfterGoLive({ res, base }: { res: Res; base: Report }) {
  const h = res.handover;
  const later = res.later?.report;
  return (
    <>
      <h2>Since Go-Live</h2>
      {h && (
        <div className="bl-scroll"><table><thead><tr><th>Sent By CONVEYi Since {day(h.since)}</th><th>Emails</th><th>A Week</th><th>Minutes Each</th><th>Hours A Week</th></tr></thead><tbody>
          {h.lines.length === 0 ? <tr><td colSpan={5}>Nothing yet.</td></tr> : h.lines.map((l) => <tr key={l.category}><td>{l.label}</td><td>{l.count}</td><td>{l.perWeek}</td><td>{l.minutes.toFixed(1)}</td><td>{l.hoursPerWeek.toFixed(2)}</td></tr>)}
          {h.lines.length > 0 && <tr className="tot"><td>Handed Over</td><td /><td /><td /><td>{h.hoursPerWeek.toFixed(1)}</td></tr>}
        </tbody></table></div>
      )}
      {later && (
        <>
          <h2>Written By Hand: Before And After</h2>
          <div className="bl-scroll"><table><thead><tr><th>Kind</th><th>Before (A Week)</th><th>After (A Week)</th><th>Change</th></tr></thead><tbody>
            {base.lines.filter((l) => l.tier !== 'excluded' && (l.perWeek > 0 || (later.lines.find((x) => x.category === l.category)?.perWeek ?? 0) > 0)).map((l) => {
              const a = later.lines.find((x) => x.category === l.category)?.perWeek ?? 0;
              return <tr key={l.category}><td>{l.label}</td><td>{l.perWeek}</td><td>{a}</td><td>{l.perWeek ? pct((a - l.perWeek) / l.perWeek) : '—'}</td></tr>;
            })}
            <tr className="tot"><td>Hours A Week</td><td>{base.lines.filter((l) => l.tier !== 'excluded').reduce((s, l) => s + l.hoursPerWeek, 0).toFixed(1)}</td><td>{later.lines.filter((l) => l.tier !== 'excluded').reduce((s, l) => s + l.hoursPerWeek, 0).toFixed(1)}</td><td /></tr>
          </tbody></table></div>
        </>
      )}
    </>
  );
}

/** The random sample, one email at a time, read live from Outlook: agree, or pick the right kind. */
function CheckSample({ scanId, spec, onDone }: { scanId: string; spec: Spec; onDone: () => void }) {
  const [emails, setEmails] = useState<CheckEmail[] | null>(null);
  const [i, setI] = useState(0);
  const [pick, setPick] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<{ emails: CheckEmail[] }>('/workload/check').then((r) => {
      setEmails(r.emails);
      const first = r.emails.findIndex((e) => !e.checked && !e.gone);
      setI(first < 0 ? r.emails.length : first);
    }).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load the sample.'));
  }, []);
  const cur = emails?.[i] ?? null;
  useEffect(() => { if (cur) setPick(cur.checked ?? cur.category); }, [cur]);
  if (err) return <p className="bl-err">{err}</p>;
  if (!emails) return <div className="bl-card" style={{ marginTop: 14 }}>Loading the emails to check…</div>;
  const done = emails.filter((e) => e.checked).length;
  const answer = async (category: string) => {
    if (!cur) return false;
    try {
      await api('/workload/check', { method: 'POST', body: JSON.stringify({ scanId, emailId: cur.id, category }) });
      const next = emails.map((e, k) => (k === i ? { ...e, checked: category } : e));
      setEmails(next);
      const n = next.findIndex((e, k) => k > i && !e.checked && !e.gone);
      setI(n < 0 ? next.length : n);
      return true;
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Could not save.'); return false; }
  };
  const finish = async () => { await api('/workload/finish', { method: 'POST', body: JSON.stringify({ scanId }) }); onDone(); return true; };
  return (
    <div className="bl-card noprint" style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <b>Check {emails.length} Emails</b>
        <span style={{ color: '#64748b', fontSize: 13 }}>{done} of {emails.length} checked</span>
        <span style={{ marginLeft: 'auto' }}><BusyButton className="ep-btn" busyLabel="Finishing…" doneLabel="Finished" onClick={finish}>{done < emails.length ? 'Finish With These' : 'Finish'}</BusyButton></span>
      </div>
      <div className="bl-bar"><i style={{ width: `${(done / Math.max(1, emails.length)) * 100}%` }} /></div>
      {cur ? (
        <div className="bl-chk" style={{ marginTop: 12 }}>
          <div>
            <div style={{ fontWeight: 700 }}>{cur.subject || '(No Subject)'}</div>
            <div style={{ fontSize: 12.5, color: '#64748b' }}>To {cur.people || '—'} · {day(cur.sentAt)}{cur.webLink && <> · <a href={cur.webLink} target="_blank" rel="noreferrer">Open In Outlook</a></>}</div>
            <pre>{cur.text || '(Nothing written: a file sent on its own)'}</pre>
          </div>
          <div>
            <label style={{ fontSize: 12.5, color: '#475569' }}>What it was
              <select className="ep-input" value={pick} onChange={(e) => setPick(e.target.value)} style={{ marginTop: 4 }}>
                {Object.entries(spec.out).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </label>
            <p style={{ fontSize: 12.5, color: '#64748b', margin: '6px 0 10px' }}>{spec.out[pick]?.what}</p>
            <BusyButton busyLabel="Saving…" doneLabel="Saved" onClick={() => answer(pick)}>{pick === cur.category ? 'Agree' : 'Correct It'}</BusyButton>
          </div>
        </div>
      ) : <p style={{ fontSize: 13.5, marginTop: 10 }}>All checked.</p>}
    </div>
  );
}
