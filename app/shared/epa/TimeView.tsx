'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/app/shared/engine/api';
import { ENGINE_CSS } from '@/app/shared/engine/ui';
import { paths } from '@/lib/paths';
import { flushAttention } from '@/app/shared/epa/useAttention';
import type { EpaReport, EpaWeek, RagSplit } from '@/lib/server/epa/report';

/**
 * Analytics → Time (docs/epa.md): the whole firm's week as legal work, checks and routine; week by week; and the routine
 * time ranked, with how often each thing happened and how long it took. Never one person's figures.
 */
const CSS = `
.tv{max-width:1360px}
.tv-head{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.tv-head h1{font-size:21px;font-weight:800;margin:0}
.tv h2{font-size:15px;font-weight:800;margin:0;color:#0f172a}
.tv-card{background:#fff;border:1px solid #e6e8ee;border-radius:14px;padding:18px 20px;margin-top:16px}
.tv-cardhead{display:flex;align-items:baseline;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.tv-cardhead .r{margin-left:auto;font-size:12.5px;color:#64748b;font-weight:700}
.tv-stack{display:flex;gap:2px;height:46px}
.tv-stack.thin{height:20px}
.tv-stack > span{display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:15px;min-width:0;overflow:hidden;white-space:nowrap}
.tv-stack.thin > span{font-size:11.5px}
.tv-stack > span:first-child{border-radius:6px 0 0 6px}
.tv-stack > span:last-child{border-radius:0 6px 6px 0}
.tv-stack > span:only-child{border-radius:6px}
.tv-green{background:#1E8E4E}.tv-amber{background:#E39A2D}.tv-red{background:#D64A3A}
.tv-amber{color:#3b2405 !important}
.tv-legend{display:flex;gap:22px;flex-wrap:wrap;margin-top:12px;font-size:13.5px;color:#0f172a}
.tv-legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:7px;vertical-align:-1px}
.tv-legend b{font-weight:800}
.tv-legend span{color:#475569}
.tv-before{display:grid;grid-template-columns:130px minmax(0,1fr);gap:12px;align-items:center;margin-top:14px;font-size:12.5px;font-weight:700;color:#475569}
.tv-weeks{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:14px;align-items:end;height:170px}
.tv-col{display:flex;flex-direction:column;gap:2px;height:100%}
.tv-col > span:first-child{border-radius:5px 5px 0 0}
.tv-col > span:last-child{border-radius:0 0 5px 5px}
.tv-col.empty{background:#f1f5f9;border-radius:5px}
.tv-wklabels{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:14px;margin-top:8px;font-size:12px;color:#64748b;font-weight:700;text-align:center}
.tv-wklabels .on{color:#0f172a}
.tv-row{display:grid;grid-template-columns:190px minmax(0,1fr) 64px 64px 72px 310px;gap:14px;align-items:center;padding:9px 0;border-bottom:1px solid #f1f3f7;font-size:13.5px}
.tv-row.th{font-size:12px;font-weight:800;color:#64748b;padding-top:0}
.tv-row .num{text-align:right;font-variant-numeric:tabular-nums}
.tv-row .bar{height:12px;background:#f3f4f6;border-radius:4px;overflow:hidden}
.tv-row .bar i{display:block;height:100%;border-radius:4px}
.tv-row.part{font-size:12.5px;color:#475569}
.tv-row.part > span:first-child{padding-left:16px}
.tv-lvl{display:inline-block;font-size:11px;font-weight:800;border-radius:999px;padding:1px 8px;margin-right:8px}
.tv-lvl.propose{background:#fef3c7;color:#92400e}.tv-lvl.assist{background:#e0e7ff;color:#3730a3}.tv-lvl.auto{background:#dcfce7;color:#166534}
.tv-row a{color:#5A27E0;font-weight:800;text-decoration:none}
.tv-none{color:#64748b;font-size:13.5px;padding:8px 0}
.tv-err{color:#b91c1c;font-size:13px;margin-top:12px}
@media (max-width:1100px){.tv-row{grid-template-columns:150px minmax(0,1fr) 56px 56px 70px}.tv-row > :last-child{grid-column:1/-1}}
`;

const COLOURS = [['green', 'Legal Work'], ['amber', 'Checks'], ['red', 'Routine']] as const;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const hrs = (x: number) => (x > 0 && x < 0.05 ? '<0.1h' : `${x.toFixed(1)}h`);
const mins = (x: number | null) => (x == null ? '—' : x < 1 ? '<1 min' : `${Math.round(x)} min`);
const day = (iso: string, plus = 0) => new Date(Date.parse(iso) + plus * 86_400_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const title = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const LEVEL: Record<string, string> = { propose: 'Propose', assist: 'Assist', auto: 'Auto' };

/** One red / amber / green bar, each part labelled with its share where it is wide enough to read. */
function Stack({ share, thin = false }: { share: RagSplit; thin?: boolean }) {
  return (
    <div className={`tv-stack${thin ? ' thin' : ''}`} role="img" aria-label={COLOURS.map(([k, l]) => `${l} ${pct(share[k])}`).join(', ')}>
      {COLOURS.filter(([k]) => share[k] > 0).map(([k, l]) => (
        <span key={k} className={`tv-${k}`} style={{ flex: `${share[k]} 1 0` }} title={`${l}: ${pct(share[k])}`}>{share[k] >= 0.08 ? pct(share[k]) : ''}</span>
      ))}
    </div>
  );
}

export function TimeView({ tabs }: { tabs: ReactNode }) {
  const [r, setR] = useState<EpaReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void flushAttention().then(() => api<{ report: EpaReport }>('/epa').then((x) => setR(x.report)).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load the figures.')));
  }, []);

  const w: EpaWeek | null = r?.week ?? null;
  const maxShare = r?.pareto[0]?.share ?? 1;
  return (
    <div className="tv">
      <style>{ENGINE_CSS + CSS}</style>
      <div className="tv-head"><h1>Analytics</h1>{tabs}</div>
      {err && <p className="tv-err">{err}</p>}
      {!r && !err && <p className="tv-none">Loading…</p>}
      {r && (
        <>
          <section className="tv-card">
            <div className="tv-cardhead">
              <h2>{w ? `Week Of ${day(w.start)} – ${day(w.start, 6)}` : 'Last Week'}</h2>
              {w && <span className="r">{hrs(w.hours.green + w.hours.amber + w.hours.red)} Across The Firm</span>}
            </div>
            {w?.share ? (
              <>
                <Stack share={w.share} />
                <div className="tv-legend">
                  {COLOURS.map(([k, l]) => <div key={k}><i className={`tv-${k}`} /><b>{l}</b> <span>{pct(w.share![k])} · {hrs(w.hours[k])}</span></div>)}
                </div>
                {r.baseline && <div className="tv-before"><span>Before CONVEYi</span><Stack share={r.baseline} thin /></div>}
              </>
            ) : <p className="tv-none">No time recorded yet.</p>}
          </section>

          <section className="tv-card">
            <div className="tv-cardhead"><h2>Week By Week</h2></div>
            <div className="tv-weeks">
              {r.weeks.map((wk) => (
                wk.share
                  ? <div key={wk.start} className="tv-col" title={COLOURS.map(([k, l]) => `${l} ${pct(wk.share![k])}`).join(' · ')}>
                      {[...COLOURS].reverse().filter(([k]) => wk.share![k] > 0).map(([k]) => <span key={k} className={`tv-${k}`} style={{ flex: `${wk.share![k]} 1 0` }} />)}
                    </div>
                  : <div key={wk.start} className="tv-col empty" title="No time recorded" />
              ))}
            </div>
            <div className="tv-wklabels">{r.weeks.map((wk) => <span key={wk.start} className={wk.start === w?.start ? 'on' : ''}>{day(wk.start)}</span>)}</div>
          </section>

          <section className="tv-card">
            <div className="tv-cardhead"><h2>Where Routine Time Goes</h2>{w && <span className="r">Week Of {day(w.start)}</span>}</div>
            {!r.pareto.length ? <p className="tv-none">No routine time recorded yet.</p> : (
              <>
                <div className="tv-row th"><span>Kind</span><span /><span className="num">Hours</span><span className="num">Times</span><span className="num">Each</span><span>CONVEYi</span></div>
                {r.pareto.map((b) => (
                  <div key={b.kind}>
                    <div className="tv-row">
                      <span><b>{b.label}</b></span>
                      <span className="bar"><i className={`tv-${b.rag}`} style={{ width: `${(b.share / maxShare) * 100}%` }} /></span>
                      <span className="num"><b>{hrs(b.hours)}</b></span>
                      <span className="num">{b.times}</span>
                      <span className="num">{mins(b.avgMinutes)}</span>
                      <span>
                        {b.action
                          ? <><span className={`tv-lvl ${b.action.level}`}>{LEVEL[b.action.level]}</span>{b.action.sendsUnasked ? `${title(b.action.label)} Send` : <a href={paths.rules}>Set {title(b.action.label)} To Send</a>}</>
                          : b.kind === 'checking_drafts' ? 'By Action Below' : 'No CONVEYi Action Yet'}
                      </span>
                    </div>
                    {b.parts?.map((p) => (
                      <div key={p.action} className="tv-row part">
                        <span>{title(p.label)}</span><span /><span className="num">{hrs(p.hours)}</span><span /><span />
                        <span>{p.level ? <><span className={`tv-lvl ${p.level}`}>{LEVEL[p.level]}</span><a href={paths.rules}>Change Level</a></> : null}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
