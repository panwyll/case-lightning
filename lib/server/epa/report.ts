/**
 * The EPA page's figures (docs/epa.md §3), from evidence already loaded: week by week through the attention timeline,
 * the Pareto of red and amber work with the CONVEYi action that takes each, and queue times. Pure; store.ts loads.
 */
import { actsUnasked, levelFor, ENGINE_ACTION_LABEL, type EngineAction, type LevelConfig, type TrustLevel } from '../engine/types';
import { timedMinutes } from '../workload/model';
import { attribute, estimateSpan, measure, type Span, type WeekMeasures } from './ledger';
import { EPA_KINDS, EPA_SPEC, fromBaselineCategory, type EpaKind } from './taxonomy';

const WEEK_MS = 7 * 86_400_000;
/** Monday 00:00 UTC of the week holding `ms` (an hour out from London in summer, at midnight: no work falls there). */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

/** A sent email from the mailbox scan as evidence: its draft-to-send when Outlook timed it, else its kind's minutes. */
export interface SentEmail { id: string; category: string | null; draftedAt: string | null; sentAt: string; wordsWritten: number }
export function emailSpan(e: SentEmail, minutesFor: (category: string, words: number) => number): Span | null {
  const kind = fromBaselineCategory(e.category);
  if (EPA_SPEC[kind].rag === 'none') return null;
  const end = Date.parse(e.sentAt);
  const t = timedMinutes({ draftedAt: e.draftedAt, sentAt: e.sentAt });
  if (t != null) return { start: end - t * 60_000, end, item: `email:${e.id}`, kind, source: 'compose' };
  const m = minutesFor(e.category ?? '', e.wordsWritten);
  return m > 0 ? estimateSpan(end, m, `email:${e.id}`, kind) : null;
}

/**
 * The CONVEYi action that takes each kind of work, if there is one (§3 "Pareto"). Null: nothing CONVEYi does takes it yet,
 * and the bar says so rather than suggesting something that does not exist.
 */
export const ACTION_FOR: Partial<Record<EpaKind, EngineAction>> = {
  chasing: 'chase',
  requesting: 'chase',
  acknowledging: 'acknowledgement',
  status_updates: 'client_update',
  sending_documents: 'client_update',
};
const PROPOSAL_ACTION: Record<string, EngineAction> = { chase: 'chase', acknowledgement: 'acknowledgement', client_update: 'client_update', counterparty_update: 'counterparty_update', search_order: 'search_order', email_no_reply: 'email_no_reply' };

export interface ParetoBar {
  kind: EpaKind; label: string; rag: 'red' | 'amber'; hours: number; share: number; cumulative: number;
  action: { key: EngineAction; label: string; level: TrustLevel; sendsUnasked: boolean } | null;
  /** Checking Drafts, by the CONVEYi action whose drafts were being read. */
  parts?: Array<{ action: string; label: string; hours: number; level: TrustLevel | null }>;
}
export interface QueueLine { kind: EpaKind; label: string; done: number; medianHours: number | null; p85Hours: number | null }
export interface EpaWeek { start: string; measures: WeekMeasures; hours: { red: number; amber: number; green: number; unattributed: number } }
export interface EpaReport {
  weeks: EpaWeek[];
  pareto: ParetoBar[];
  /** The week the Pareto is for. */
  paretoWeek: string | null;
  queue: QueueLine[];
  baselineEfficiency: number | null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const pctl = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/** Efficiency at baseline, from the mailbox scan's hours per category (sent email only: the page says so). */
export function baselineEfficiency(lines: Array<{ category: string; hoursPerWeek: number }>): number | null {
  const by = { red: 0, amber: 0, green: 0 };
  for (const l of lines) { const rag = EPA_SPEC[fromBaselineCategory(l.category)].rag; if (rag !== 'none') by[rag] += l.hoursPerWeek; }
  const t = by.red + by.amber + by.green;
  return t ? by.green / t : null;
}

export function buildEpaReport(input: {
  spans: Span[];
  now: number;
  weeks: number;
  workday: { workdayStart: string; workdayEnd: string };
  levels: LevelConfig;
  tasks: Array<{ kind: EpaKind; openedAt: number; closedAt: number }>;
  baselineEfficiency: number | null;
}): EpaReport {
  const first = weekStart(input.now) - (input.weeks - 1) * WEEK_MS;
  const weeks: EpaWeek[] = [];
  for (let w = first; w <= input.now; w += WEEK_MS) {
    // Spans are cut to the week so a stretch over midnight on Sunday is split, never counted twice.
    const inWeek = input.spans
      .filter((s) => s.end > w && s.start < w + WEEK_MS)
      .map((s) => ({ ...s, start: Math.max(s.start, w), end: Math.min(s.end, w + WEEK_MS) }));
    const m = measure(attribute(inWeek), input.workday);
    weeks.push({ start: new Date(w).toISOString(), measures: m, hours: { red: r1(m.rag.red / 60), amber: r1(m.rag.amber / 60), green: r1(m.rag.green / 60), unattributed: r1(m.unattributedMinutes / 60) } });
  }

  // The Pareto is for the latest week with time in it.
  const pw = [...weeks].reverse().find((w) => w.measures.efficiency != null) ?? null;
  const pareto: ParetoBar[] = [];
  if (pw) {
    const m = pw.measures;
    const kinds = EPA_KINDS.filter((k) => (EPA_SPEC[k].rag === 'red' || EPA_SPEC[k].rag === 'amber') && m.minutes[k] > 0).sort((a, b) => m.minutes[b] - m.minutes[a]);
    const total = kinds.reduce((a, k) => a + m.minutes[k], 0);
    let cum = 0;
    for (const k of kinds) {
      cum += m.minutes[k];
      const key = ACTION_FOR[k];
      const level = key ? levelFor(input.levels, key) : null;
      pareto.push({
        kind: k, label: EPA_SPEC[k].label, rag: EPA_SPEC[k].rag as 'red' | 'amber', hours: r2(m.minutes[k] / 60), share: m.minutes[k] / total, cumulative: cum / total,
        action: key && level ? { key, label: ENGINE_ACTION_LABEL[key], level, sendsUnasked: actsUnasked(level, key) } : null,
        parts: k === 'checking_drafts'
          ? Object.entries(m.checkingByAction).sort((a, b) => b[1] - a[1]).map(([a, mins]) => {
              const key = PROPOSAL_ACTION[a];
              return { action: a, label: key ? ENGINE_ACTION_LABEL[key] : a.replace(/_/g, ' '), hours: r2(mins / 60), level: key ? levelFor(input.levels, key) : null };
            })
          : undefined,
      });
    }
  }

  // Queue time: how long items waited, per kind. Never added up into anyone's hours.
  const since = first;
  const queue: QueueLine[] = EPA_KINDS.filter((k) => k !== 'not_counted').map((k) => {
    const waits = input.tasks.filter((t) => t.kind === k && t.closedAt >= since).map((t) => (t.closedAt - t.openedAt) / 3_600_000);
    return { kind: k, label: EPA_SPEC[k].label, done: waits.length, medianHours: waits.length ? r1(pctl(waits, 0.5)!) : null, p85Hours: waits.length ? r1(pctl(waits, 0.85)!) : null };
  }).filter((q) => q.done > 0).sort((a, b) => (b.medianHours ?? 0) - (a.medianHours ?? 0));

  return { weeks, pareto, paretoWeek: pw?.start ?? null, queue, baselineEfficiency: input.baselineEfficiency };
}
