'use client';
import { useEffect, useState } from 'react';
import { hoursAndMinutes, minuteValueOf, minutesPerCaseOf, pounds, yearFeesOf, type ValueInputs } from '@/lib/value';

/**
 * Time per case and what a minute of it is worth, from the firm's own figures (lib/value.ts). The figures are kept in
 * this browser so the scan's results are valued the same way (app/conveyi/scan/[token]).
 */
export interface CalcInputs extends ValueInputs { feeEarners: number }

/** 233 working days: the UK's 261 weekdays less the 28 days' statutory holiday, bank holidays included. */
export const CALC_DEFAULTS: CalcInputs = { completionsPerMonth: 30, averageFee: 1000, workingDays: 233, hoursPerDay: 7.5, feeEarners: 1 };
const KEY = 'cl_scan_inputs';

export function useCalcInputs(): [CalcInputs, (v: CalcInputs) => void] {
  const [v, setV] = useState<CalcInputs>(CALC_DEFAULTS);
  useEffect(() => {
    try { const s = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (s && typeof s === 'object') setV({ ...CALC_DEFAULTS, ...s }); } catch { /* defaults */ }
  }, []);
  const set = (n: CalcInputs) => { setV(n); try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* this visit only */ } };
  return [v, set];
}

const field = 'w-full rounded-xl border border-line bg-paper px-4 py-3 text-lg font-semibold text-ink tabular-nums focus:border-violet focus:outline-none focus:ring-1 focus:ring-violet';

function Num({ id, label, value, onChange, prefix, step = 1, min = 0 }: { id: string; label: string; value: number; onChange: (n: number) => void; prefix?: string; step?: number; min?: number }) {
  return (
    <label htmlFor={id} className="grid gap-1.5 text-sm font-semibold text-ink">
      {label}
      <span className="relative">
        {prefix && <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-lg font-semibold text-ink-soft">{prefix}</span>}
        <input id={id} type="number" inputMode="decimal" min={min} step={step} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} className={`${field} ${prefix ? 'pl-9' : ''}`} />
      </span>
    </label>
  );
}

/** The calculator. Given `value` and `onChange` (the results page), it shares its figures with the page; else it keeps its own. */
export function Calculator({ value, onChange }: { value?: CalcInputs; onChange?: (v: CalcInputs) => void } = {}) {
  const own = useCalcInputs();
  const [v, set] = value && onChange ? [value, onChange] as const : own;
  const up = (k: keyof CalcInputs) => (n: number) => set({ ...v, [k]: n });
  const ok = [v.completionsPerMonth, v.averageFee, v.workingDays, v.hoursPerDay].every((x) => Number.isFinite(x) && x > 0);
  const perCase = ok ? minutesPerCaseOf(v) : 0;
  const minute = ok ? minuteValueOf(v) : 0;
  const people = Number.isFinite(v.feeEarners) && v.feeEarners > 0 ? Math.round(v.feeEarners) : 1;
  return (
    <div className="grid gap-8 rounded-3xl border border-line bg-paper-soft p-6 shadow-card md:grid-cols-[1fr_1.1fr] md:p-10">
      <div className="grid content-start gap-5">
        <Num id="calc-completions" label="Completions a month, per fee earner" value={v.completionsPerMonth} onChange={up('completionsPerMonth')} />
        <Num id="calc-fee" label="Average fee per case" prefix="£" step={50} value={v.averageFee} onChange={up('averageFee')} />
        <div className="grid grid-cols-2 gap-4">
          <Num id="calc-days" label="Working days a year" value={v.workingDays} onChange={up('workingDays')} />
          <Num id="calc-hours" label="Hours a day" step={0.5} value={v.hoursPerDay} onChange={up('hoursPerDay')} />
        </div>
        <Num id="calc-people" label="Fee earners" min={1} value={v.feeEarners} onChange={up('feeEarners')} />
      </div>
      <div className="grid content-start gap-6 rounded-2xl bg-ink p-6 text-paper md:p-8" aria-live="polite">
        <div>
          <p className="text-sm font-semibold text-paper/60">Time per case</p>
          <p className="mt-1 font-serif text-4xl font-bold tracking-tight tabular-nums">{ok ? hoursAndMinutes(perCase) : '-'}</p>
          <p className="mt-1 text-sm text-paper/60">{ok ? `${Math.round(perCase)} minutes of a fee earner's time, on average` : 'Fill in all four figures'}</p>
        </div>
        <div className="border-t border-white/10 pt-6">
          <p className="text-sm font-semibold text-paper/60">Each minute saved per case is worth</p>
          <p className="mt-1 font-serif text-5xl font-bold tracking-tight text-[#9B7BFF] tabular-nums md:text-6xl">{ok ? `£${Math.round(minute).toLocaleString('en-GB')}` : '-'}</p>
          <p className="mt-1 text-sm text-paper/60">per fee earner, per year{ok && people > 1 ? `, so £${Math.round(minute * people).toLocaleString('en-GB')} across ${people} fee earners` : ''}</p>
        </div>
        <p className="border-t border-white/10 pt-6 text-sm leading-relaxed text-paper/60">
          {ok ? `Each fee earner bills ${pounds(yearFeesOf(v))} a year. A minute off every case lets the same year hold more cases, at your average fee.` : ''}
        </p>
      </div>
    </div>
  );
}
