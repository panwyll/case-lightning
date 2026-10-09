/**
 * The attention timeline (docs/epa.md §2): evidence spans → one person's time, each moment given to at most one item, so the
 * total can never exceed the time that passed. Then the week's measures from it. Pure, and unit-tested against cases worked by
 * hand (the in-tray of three, a switch and back, a draft left open behind a review).
 */
import { EW_CALENDAR, type WorkingCalendar } from '../engine/working-days';
import { inWorkingHours } from '../workload/model';
import { EPA_KINDS, EPA_SPEC, type EpaKind, type Rag } from './taxonomy';

/** Where a span's evidence came from, strongest first (§2 "Evidence"). */
export const SOURCES = ['focus', 'compose', 'reading', 'estimate'] as const;
export type Source = (typeof SOURCES)[number];
const RANK: Record<Source, number> = { focus: 0, compose: 1, reading: 2, estimate: 3 };

export interface Span {
  /** Epoch milliseconds. */
  start: number;
  end: number;
  /** What was being worked on (a task id, an email id, a draft): the unit of a switch. */
  item: string;
  kind: EpaKind;
  /** For Checking Drafts: what the draft was, and the CONVEYi action behind it. */
  of?: EpaKind | null;
  action?: string | null;
  source: Source;
}
export interface Slice { start: number; end: number; span: Span }

/**
 * The sweep (§2 "Attribution"): every boundary cuts the day; in each cut the strongest covering span wins, the most recently
 * started between equals (what the person switched to), the item id last so the result never depends on input order.
 * Consecutive cuts won by the same span are merged.
 */
export function attribute(spans: Span[]): Slice[] {
  const good = spans.filter((s) => s.end > s.start);
  const cuts = [...new Set(good.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
  const out: Slice[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    let win: Span | null = null;
    for (const s of good) {
      if (s.start > a || s.end < b) continue;
      if (!win || RANK[s.source] < RANK[win.source] || (RANK[s.source] === RANK[win.source] && (s.start > win.start || (s.start === win.start && s.item > win.item)))) win = s;
    }
    if (!win) continue;
    const last = out[out.length - 1];
    if (last && last.span === win && last.end === a) last.end = b;
    else out.push({ start: a, end: b, span: win });
  }
  return out;
}

/**
 * A sent email with no timing of its own (§2, Estimate): the minutes its kind takes, ending when it was sent. Placed only in
 * time no stronger evidence covers; the sweep does that, so this just makes the span.
 */
export function estimateSpan(sentAt: number, minutes: number, item: string, kind: EpaKind): Span {
  return { start: sentAt - Math.max(0, minutes) * 60_000, end: sentAt, item, kind, source: 'estimate' };
}

export interface WeekMeasures {
  /** Minutes given to each kind; and how many of them fell outside working hours. */
  minutes: Record<EpaKind, number>;
  afterHoursMinutes: Record<EpaKind, number>;
  /** Checking Drafts by what the draft was (the CONVEYi action that would take it on Send). */
  checkingByAction: Record<string, number>;
  rag: Record<Exclude<Rag, 'none'>, number>;
  /** green ÷ (red + amber + green); null with no counted time. */
  efficiency: number | null;
  /** Share of attributed minutes from Focus or Outlook compose rather than reading or estimates. */
  measuredShare: number | null;
  /** Gaps inside each working stretch no evidence covers (calls, meetings, breaks): shown, never guessed. */
  unattributedMinutes: number;
  /** Changes from one item to a different one within a working stretch, per attributed hour. */
  switchesPerHour: number | null;
  /** How long a person stays on one item (median, minutes) and the share of time in blocks of 25 minutes or more. */
  medianBlockMinutes: number | null;
  longBlockShare: number | null;
  afterHoursShare: number | null;
}

/** Gaps no longer than this keep one block on one item, and one working stretch, together. */
const SAME_BLOCK_GAP_MS = 2 * 60_000;
const SAME_STRETCH_GAP_MS = 15 * 60_000;
export const LONG_BLOCK_MINUTES = 25;

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };

/** The week's measures from its slices (§2 "The week", "Context switching"). */
export function measure(slices: Slice[], workday: { workdayStart: string; workdayEnd: string }, cal: WorkingCalendar = EW_CALENDAR): WeekMeasures {
  const minutes = zero(EPA_KINDS);
  const after = zero(EPA_KINDS);
  const checking: Record<string, number> = {};
  let measured = 0;
  let total = 0;
  for (const s of slices) {
    // Minute by minute for in and after hours: a slice may cross the end of the working day.
    for (let t = s.start; t < s.end; t += 60_000) {
      const m = Math.min(60_000, s.end - t) / 60_000;
      minutes[s.span.kind] += m;
      if (!inWorkingHours(new Date(t).toISOString(), workday, cal)) after[s.span.kind] += m;
    }
    const m = (s.end - s.start) / 60_000;
    total += m;
    if (s.span.source === 'focus' || s.span.source === 'compose') measured += m;
    if (s.span.kind === 'checking_drafts') { const k = s.span.action ?? s.span.of ?? 'other'; checking[k] = (checking[k] ?? 0) + m; }
  }
  const rag = { red: 0, amber: 0, green: 0 };
  for (const k of EPA_KINDS) { const r = EPA_SPEC[k].rag; if (r !== 'none') rag[r] += minutes[k]; }
  const counted = rag.red + rag.amber + rag.green;

  // Stretches and blocks, in time order.
  const ordered = [...slices].sort((a, b) => a.start - b.start);
  let switches = 0;
  let unattributed = 0;
  const blocks: number[] = [];
  let block: { item: string; start: number; end: number } | null = null;
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    const prev = ordered[i - 1];
    const gap = prev ? s.start - prev.end : Infinity;
    if (prev && gap <= SAME_STRETCH_GAP_MS) {
      unattributed += Math.max(0, gap) / 60_000;
      if (s.span.item !== prev.span.item) switches += 1;
    }
    if (block && block.item === s.span.item && s.start - block.end <= SAME_BLOCK_GAP_MS) block.end = s.end;
    else { if (block) blocks.push((block.end - block.start) / 60_000); block = { item: s.span.item, start: s.start, end: s.end }; }
  }
  if (block) blocks.push((block.end - block.start) / 60_000);
  const inBlocks = blocks.reduce((a, b) => a + b, 0);
  const afterTotal = EPA_KINDS.filter((k) => EPA_SPEC[k].rag !== 'none').reduce((a, k) => a + after[k], 0);
  return {
    minutes,
    afterHoursMinutes: after,
    checkingByAction: checking,
    rag,
    efficiency: counted ? rag.green / counted : null,
    measuredShare: total ? measured / total : null,
    unattributedMinutes: unattributed,
    switchesPerHour: total ? switches / (total / 60) : null,
    medianBlockMinutes: median(blocks),
    longBlockShare: inBlocks ? blocks.filter((b) => b >= LONG_BLOCK_MINUTES).reduce((a, b) => a + b, 0) / inBlocks : null,
    afterHoursShare: counted ? afterTotal / counted : null,
  };
}
