/**
 * The EPA page's figures (docs/epa.md §3), from evidence already loaded: week by week through the attention timeline,
 * the Pareto of red and amber work with the CONVEYi action that takes each. Pure; store.ts loads.
 */
import { actsUnasked, levelFor, ENGINE_ACTION_LABEL, type EngineAction, type LevelConfig, type TrustLevel } from '../engine/types';
import { timedMinutes } from '../workload/model';
import { attribute, measure, type Completion, type Span } from './ledger';
import { EPA_KINDS, EPA_SPEC, fromBaselineCategory, fromEmail, type EpaKind } from './taxonomy';

const WEEK_MS = 7 * 86_400_000;
/** Monday 00:00 UTC of the week holding `ms` (an hour out from London in summer, at midnight: no work falls there). */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

/** A sent email from the mailbox scan: a completion, and when Outlook timed its draft, the writing itself. */
export interface SentEmail { id: string; category: string | null; draftedAt: string | null; sentAt: string; roles?: readonly string[] | null }
export function emailEvidence(e: SentEmail): { done: Completion; compose: Span | null } | null {
  const kind = fromEmail(e.category, e.roles);
  if (EPA_SPEC[kind].rag === 'none') return null;
  const end = Date.parse(e.sentAt);
  const t = timedMinutes({ draftedAt: e.draftedAt, sentAt: e.sentAt });
  return { done: { at: end, item: `email:${e.id}`, kind }, compose: t != null ? { start: end - t * 60_000, end, item: `email:${e.id}`, kind, source: 'compose' } : null };
}

/**
 * The CONVEYi action that takes each kind of work, if there is one (§3 "Pareto"). Null: nothing CONVEYi does takes it yet,
 * and the bar says so rather than suggesting something that does not exist.
 */
export const ACTION_FOR: Partial<Record<EpaKind, EngineAction>> = {
  client_chasers: 'chase', other_side_chasers: 'chase', lender_chasers: 'chase', agent_chasers: 'chase',
  first_requests_others: 'chase', first_requests_client: 'client_update',
  client_updates: 'client_update', sending_documents_client: 'client_update', resending_to_client: 'client_update',
  agent_updates: 'counterparty_update', other_side_updates: 'counterparty_update', lender_broker_updates: 'counterparty_update',
  acknowledging: 'acknowledgement', ordering_searches: 'search_order',
};

export interface ParetoBar {
  kind: EpaKind; label: string; rag: 'red' | 'amber'; hours: number; share: number; cumulative: number;
  /** How many separate things (emails, tasks) the time went on, and the average minutes each took. */
  times: number; avgMinutes: number | null;
  action: { key: EngineAction; label: string; level: TrustLevel; sendsUnasked: boolean } | null;
  /** Checking CONVEYi Drafts, by what the drafts were (Lender Chasers, Client Updates…), with the action that would send them. */
  parts?: Array<{ of: string; label: string; hours: number; action: EngineAction | null; level: TrustLevel | null }>;
}
export interface RagSplit { red: number; amber: number; green: number }
export interface EpaWeek {
  start: string;
  /** Hours by colour, and each colour's share of the counted time. */
  hours: RagSplit; share: RagSplit | null;
  unattributedHours: number;
}
export interface EpaReport {
  weeks: EpaWeek[];
  /** This week so far (the lead figure and the Pareto), else the latest week with time in it. */
  week: EpaWeek | null;
  pareto: ParetoBar[];
  /** Before CONVEYi, from the mailbox scans (sent email only). */
  baseline: RagSplit | null;
  people: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const shareOf = (h: RagSplit): RagSplit | null => { const t = h.red + h.amber + h.green; return t ? { red: h.red / t, amber: h.amber / t, green: h.green / t } : null; };

/** The red / amber / green split before CONVEYi, from the mailbox scans' hours per category (sent email only). */
export function baselineSplit(lines: Array<{ category: string; hoursPerWeek: number }>): RagSplit | null {
  const by = { red: 0, amber: 0, green: 0 };
  for (const l of lines) { const rag = EPA_SPEC[fromBaselineCategory(l.category)].rag; if (rag !== 'none') by[rag] += l.hoursPerWeek; }
  return shareOf(by);
}

/**
 * The firm's report: each person's time attributed on their own timeline (no minute counted twice, docs/epa.md §2),
 * then added up. Nobody is shown on their own.
 */
export function buildEpaReport(input: {
  people: Span[][];
  now: number;
  weeks: number;
  workday: { workdayStart: string; workdayEnd: string };
  levels: LevelConfig;
  baseline: RagSplit | null;
}): EpaReport {
  const first = weekStart(input.now) - (input.weeks - 1) * WEEK_MS;
  type Acc = { minutes: Record<string, number>; items: Record<string, Set<string>>; checking: Record<string, number>; unattributed: number };
  const accs: Array<{ start: number; acc: Acc }> = [];
  for (let w = first; w <= input.now; w += WEEK_MS) {
    const acc: Acc = { minutes: {}, items: {}, checking: {}, unattributed: 0 };
    input.people.forEach((spans, p) => {
      // Spans are cut to the week so a stretch over midnight on Sunday is split, never counted twice.
      const inWeek = spans.filter((s) => s.end > w && s.start < w + WEEK_MS).map((s) => ({ ...s, start: Math.max(s.start, w), end: Math.min(s.end, w + WEEK_MS) }));
      const slices = attribute(inWeek);
      const m = measure(slices, input.workday, undefined, { afterHours: false });
      for (const k of EPA_KINDS) acc.minutes[k] = (acc.minutes[k] ?? 0) + m.minutes[k];
      for (const [a, v] of Object.entries(m.checkingByAction)) acc.checking[a] = (acc.checking[a] ?? 0) + v;
      acc.unattributed += m.unattributedMinutes;
      for (const sl of slices) (acc.items[sl.span.kind] ??= new Set()).add(`${p}:${sl.span.item}`);
    });
    accs.push({ start: w, acc });
  }
  const toWeek = ({ start, acc }: { start: number; acc: Acc }): EpaWeek => {
    const h = { red: 0, amber: 0, green: 0 };
    for (const k of EPA_KINDS) { const rag = EPA_SPEC[k].rag; if (rag !== 'none') h[rag] += acc.minutes[k] ?? 0; }
    const hours = { red: r1(h.red / 60), amber: r1(h.amber / 60), green: r1(h.green / 60) };
    return { start: new Date(start).toISOString(), hours, share: shareOf(h), unattributedHours: r1(acc.unattributed / 60) };
  };
  const weeks = accs.map(toWeek);

  // This week so far; last week while this one has nothing in it yet (a Monday morning).
  const lead = [...accs].reverse().find((a) => toWeek(a).share) ?? null;
  const pareto: ParetoBar[] = [];
  if (lead) {
    const m = lead.acc;
    const kinds = EPA_KINDS.filter((k) => (EPA_SPEC[k].rag === 'red' || EPA_SPEC[k].rag === 'amber') && (m.minutes[k] ?? 0) > 0).sort((a, b) => m.minutes[b] - m.minutes[a]);
    const total = kinds.reduce((a, k) => a + m.minutes[k], 0);
    let cum = 0;
    for (const k of kinds) {
      cum += m.minutes[k];
      const key = ACTION_FOR[k];
      const level = key ? levelFor(input.levels, key) : null;
      const times = m.items[k]?.size ?? 0;
      pareto.push({
        kind: k, label: EPA_SPEC[k].label, rag: EPA_SPEC[k].rag as 'red' | 'amber', hours: r2(m.minutes[k] / 60), share: m.minutes[k] / total, cumulative: cum / total,
        times, avgMinutes: times ? r1(m.minutes[k] / times) : null,
        action: key && level ? { key, label: ENGINE_ACTION_LABEL[key], level, sendsUnasked: actsUnasked(level, key) } : null,
        parts: k === 'checking_drafts'
          ? Object.entries(m.checking).sort((a, b) => b[1] - a[1]).map(([of, mins]) => {
              const key = ACTION_FOR[of as EpaKind] ?? null;
              return { of, label: EPA_SPEC[of as EpaKind]?.label ?? 'Other Checks', hours: r2(mins / 60), action: key, level: key ? levelFor(input.levels, key) : null };
            })
          : undefined,
      });
    }
  }
  return { weeks, week: lead ? toWeek(lead) : null, pareto, baseline: input.baseline, people: input.people.length };
}
