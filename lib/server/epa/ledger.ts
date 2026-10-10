/**
 * The attention timeline (docs/epa.md §2): evidence spans → one person's time, each moment given to at most one item, so the
 * total can never exceed the time that passed. Then the week's measures from it. Pure, and unit-tested against cases worked by
 * hand (the in-tray of three, a switch and back, a draft left open behind a review).
 */
import { EW_CALENDAR, type WorkingCalendar } from '../engine/working-days';
import { inWorkingHours } from '../workload/model';
import { isWorkingDay } from '../engine/working-days';
import { EPA_KINDS, EPA_SPEC, type EpaKind, type Rag } from './taxonomy';

/** Where a span's evidence came from, strongest first (§2 "Evidence"). */
export const SOURCES = ['focus', 'compose', 'interval', 'reading', 'estimate'] as const;
export type Source = (typeof SOURCES)[number];
const RANK: Record<Source, number> = { focus: 0, compose: 1, interval: 2, reading: 3, estimate: 4 };

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

/** Something a person finished: a task closed, an email sent. */
export interface Completion { at: number; item: string; kind: EpaKind; of?: EpaKind | null; action?: string | null }
export interface ClipRules { workdayStart: string; workdayEnd: string; lunchStart: string; lunchEnd: string }
export const DEFAULT_LUNCH = { lunchStart: '13:00', lunchEnd: '14:00' };
/** The most one completion can be given: an hour for routine work (in case the gap was lunch or a meeting), longer for legal work. */
export const CAP_MINUTES: Record<Rag, number> = { red: 60, amber: 60, green: 180, none: 60 };
/** Completions this close together are one sitting (a run of approvals): the time before them is shared equally. */
const BURST_MS = 60_000;

const LONDON = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const hm = (s: string) => { const [h, m] = s.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
/** Local midnight (as epoch ms) and minute of the day, UK time. */
function local(ms: number): { midnight: number; minute: number; day: Date } {
  const p = Object.fromEntries(LONDON.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const minute = (Number(p.hour) % 24) * 60 + Number(p.minute);
  return { midnight: ms - minute * 60_000 - Number(p.second) * 1000 - (ms % 1000), minute, day: new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`) };
}

/**
 * The time since the last thing finished (§2 "Completions"): each completion is given the time back to the one before it,
 * clipped to the working day when it was done in it, less lunch, and capped by its kind (the minutes nearest the completion
 * kept). In-tray items finished one after another each get their own gap, so nothing counts twice.
 */
export function completionSpans(events: Completion[], rules: ClipRules, cal: WorkingCalendar = EW_CALENDAR): Span[] {
  const ev = [...events].sort((a, b) => a.at - b.at || (a.item < b.item ? -1 : 1));
  const out: Span[] = [];
  let prev = -Infinity;
  for (let i = 0; i < ev.length; ) {
    // A burst: this completion and any within a minute of the last one in it.
    let j = i + 1;
    while (j < ev.length && ev[j].at - ev[j - 1].at <= BURST_MS) j++;
    const burst = ev.slice(i, j);
    const end = burst[burst.length - 1].at;
    const L = local(end);
    const inHours = isWorkingDay(L.day, cal) && L.minute >= hm(rules.workdayStart) && L.minute < hm(rules.workdayEnd);
    const cap = Math.max(...burst.map((e) => CAP_MINUTES[EPA_SPEC[e.kind].rag])) * 60_000 * burst.length;
    let from = Math.max(prev, end - cap);
    if (inHours) from = Math.max(from, L.midnight + hm(rules.workdayStart) * 60_000);
    // The stretch, less lunch when it was in the working day.
    let pieces: Array<[number, number]> = [[from, end]];
    if (inHours) {
      const [ls, le] = [L.midnight + hm(rules.lunchStart) * 60_000, L.midnight + hm(rules.lunchEnd) * 60_000];
      pieces = pieces.flatMap(([a, b]) => [[a, Math.min(b, ls)], [Math.max(a, le), b]] as Array<[number, number]>).filter(([a, b]) => b > a);
    }
    // Shared equally across the burst, in the order they were finished.
    const total = pieces.reduce((t, [a, b]) => t + (b - a), 0);
    const share = total / burst.length;
    let k = 0;
    let left = share;
    for (const [a0, b] of pieces) {
      let a = a0;
      while (a < b && k < burst.length) {
        const take = Math.min(left, b - a);
        const e = burst[k];
        if (take > 0) out.push({ start: a, end: a + take, item: e.item, kind: e.kind, of: e.of ?? null, action: e.action ?? null, source: 'interval' });
        a += take; left -= take;
        if (left <= 1e-6) { k++; left = share; }
      }
    }
    prev = end;
    i = j;
  }
  return out;
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
  /** Share of attributed minutes from evidence (a task open, an email timed, a completion) rather than estimates. */
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
    if (s.span.source !== 'estimate') measured += m;
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
