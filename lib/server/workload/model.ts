/**
 * The workload baseline report, from the stored rows and the settings shown under it
 * (docs/workload-baseline.md §3–6). A pure function: change a setting and it recomputes.
 */
import { EW_CALENDAR, isWorkingDay, workingDaysBetween, type WorkingCalendar } from '../engine/working-days';
import { IN_CATEGORIES, OUT_CATEGORIES, OUT_SPEC, type InCategory, type OutCategory, type Tier, type Filtered } from './taxonomy';

export interface Row {
  direction: 'out' | 'in';
  category: string | null;
  filtered: Filtered | null;
  sentAt: string;
  draftedAt: string | null;
  wordsWritten: number;
  inSample: boolean;
  checkedCategory: string | null;
}

export interface Settings {
  /** Typing speed for the floor, words a minute (default 40). */
  wpm: number;
  /** The contracted week the hours are a share of (default 37.5). */
  contractedHours: number;
  /** The working day, 'HH:MM' UK time (default 09:00–17:30). */
  workdayStart: string;
  workdayEnd: string;
  /** The firm's figures for the money (null where not given). */
  hoursPerCompletion: number | null;
  feePerCompletionPennies: number | null;
  payPerCompletionPennies: number | null;
}
export const DEFAULT_SETTINGS: Settings = { wpm: 40, contractedHours: 37.5, workdayStart: '09:00', workdayEnd: '17:30', hoursPerCompletion: null, feePerCompletionPennies: null, payPerCompletionPennies: null };

/** Timed messages a category needs before Outlook's timings replace typing plus estimate. */
export const TIMED_MIN = 10;
/** A draft open for less than this, or longer, is not a timing of writing it (minutes). */
export const TIMED_RANGE: [number, number] = [0.25, 45];
/** Checked emails asked for. */
export const SAMPLE_SIZE = 50;

export type MinutesBasis = 'timed' | 'estimate' | 'typing_only';

export interface CategoryLine {
  category: OutCategory;
  label: string;
  tier: Tier;
  /** As classified, and corrected by the checked sample (equal until it is checked). */
  count: number;
  corrected: number;
  perWeek: number;
  avgWords: number;
  /** Typing time per email, the floor. */
  typingMinutes: number;
  /** The conveyancer's estimate of finding what to say, if given. */
  estimateMinutes: number | null;
  /** Outlook's timings: how many, and their median. */
  timed: number;
  timedMedian: number | null;
  /** The figure used, and its basis. */
  minutes: number;
  basis: MinutesBasis;
  hoursPerWeekFloor: number;
  hoursPerWeek: number;
  shareOfWeek: number;
  afterHours: number;
}

export interface Report {
  window: { since: string; until: string; workingWeeks: number };
  read: { total: number; sent: number; received: number; filtered: Record<string, number>; classified: number };
  accuracy: { checked: number; agreed: number; rate: number | null; low: number | null; high: number | null; asked: number };
  lines: CategoryLine[];
  received: Array<{ category: InCategory; count: number; perWeek: number }>;
  tiers: Record<Tier, { hoursPerWeek: number; hoursPerWeekFloor: number; perWeek: number }>;
  /** What CONVEYi takes: the 'Sent by' tier in full, the 'Drafted by' tier's typing. */
  freed: { hoursPerWeek: number; hoursPerWeekFloor: number; shareOfWeek: number; hoursPerMonth: number; completionsPerMonth: number | null; firmPerMonthPennies: number | null; payPerMonthPennies: number | null };
  afterHoursShare: number | null;
  settings: Settings;
}

// ── statistics ──

/** The Wilson score interval for k successes in n (95% by default). */
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (c - m) / d), high: Math.min(1, (c + m) / d) };
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

/**
 * Counts re-spread by what the checked sample found (§3). For each category the model gave, the
 * sample says how often it was really each category. With 50 checked across eleven categories a
 * category may have two or three checked, so its own rate is shrunk towards the whole sample's
 * (empirical Bayes, prior weight `strength` checked emails): agreement at the overall rate, and
 * mistakes spread like the overall mistakes. A category with many checked follows its own; one
 * with none follows the overall. Nothing is gained or lost: every count is only re-spread.
 */
export function correctCounts<C extends string>(counts: Record<C, number>, checked: Array<{ given: C; truth: C }>, categories: readonly C[], strength = 5): Record<C, number> {
  const out = Object.fromEntries(categories.map((c) => [c, 0])) as Record<C, number>;
  if (!checked.length) { for (const c of categories) out[c] = counts[c] ?? 0; return out; }
  const agreeAll = checked.filter((x) => x.given === x.truth).length / checked.length;
  const wrong = checked.filter((x) => x.given !== x.truth);
  for (const given of categories) {
    const n = counts[given] ?? 0;
    if (!n) continue;
    const rows = checked.filter((x) => x.given === given);
    // Where the overall mistakes went, leaving out this category (a mistake is never "really itself").
    const elsewhere = wrong.filter((x) => x.truth !== given);
    const prior = (truth: C) => truth === given
      ? strength * (elsewhere.length ? agreeAll : 1)
      : elsewhere.length ? (strength * (1 - agreeAll) * elsewhere.filter((x) => x.truth === truth).length) / elsewhere.length : 0;
    const total = rows.length + strength;
    for (const truth of categories) out[truth] += (n * (rows.filter((x) => x.truth === truth).length + prior(truth))) / total;
  }
  return out;
}

// ── time ──

const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const LONDON = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

/** Sent inside the firm's working day, on a working day, UK time. */
export function inWorkingHours(iso: string, s: Pick<Settings, 'workdayStart' | 'workdayEnd'>, cal: WorkingCalendar = EW_CALENDAR): boolean {
  const parts = Object.fromEntries(LONDON.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  const day = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
  if (!isWorkingDay(day, cal)) return false;
  const t = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  return t >= minutesOf(s.workdayStart) && t < minutesOf(s.workdayEnd);
}

/** Working weeks in the window: working days ÷ 5, at least a fifth of a week. */
export function workingWeeks(since: string, until: string, cal: WorkingCalendar = EW_CALENDAR): number {
  return Math.max(0.2, workingDaysBetween(new Date(since), new Date(until), cal) / 5);
}

/** Minutes from the draft being started to it being sent, when that is a timing of writing it. */
export function timedMinutes(r: Pick<Row, 'draftedAt' | 'sentAt'>): number | null {
  if (!r.draftedAt) return null;
  const m = (Date.parse(r.sentAt) - Date.parse(r.draftedAt)) / 60_000;
  return m >= TIMED_RANGE[0] && m <= TIMED_RANGE[1] ? m : null;
}

const round = (x: number, dp = 1) => Math.round(x * 10 ** dp) / 10 ** dp;

/** The report (§3–6). `estimates`: the conveyancer's minutes per category spent finding what to say. */
export function buildReport(input: { rows: Row[]; since: string; until: string; settings?: Partial<Settings>; estimates?: Partial<Record<OutCategory, number>>; cal?: WorkingCalendar }): Report {
  const st: Settings = { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(input.settings ?? {}).filter(([, v]) => v != null)) } as Settings;
  const cal = input.cal ?? EW_CALENDAR;
  const weeks = workingWeeks(input.since, input.until, cal);
  const rows = input.rows;
  const sent = rows.filter((r) => r.direction === 'out');
  const received = rows.filter((r) => r.direction === 'in');
  const filtered: Record<string, number> = {};
  for (const r of rows) if (r.filtered) filtered[r.filtered] = (filtered[r.filtered] ?? 0) + 1;
  const out = sent.filter((r) => !r.filtered && OUT_CATEGORIES.includes(r.category as OutCategory));

  // Accuracy, from the checked sample of sent emails.
  const checked = out.filter((r) => r.inSample && r.checkedCategory).map((r) => ({ given: r.category as OutCategory, truth: r.checkedCategory as OutCategory }));
  const agreed = checked.filter((x) => x.given === x.truth).length;
  const ci = wilson(agreed, checked.length);
  const raw = Object.fromEntries(OUT_CATEGORIES.map((c) => [c, out.filter((r) => r.category === c).length])) as Record<OutCategory, number>;
  const corrected = checked.length ? correctCounts(raw, checked, OUT_CATEGORIES) : raw;

  const lines: CategoryLine[] = OUT_CATEGORIES.map((c) => {
    const mine = out.filter((r) => r.category === c);
    const avgWords = mine.length ? mine.reduce((a, r) => a + r.wordsWritten, 0) / mine.length : 0;
    const typing = avgWords / st.wpm;
    const times = mine.map(timedMinutes).filter((x): x is number => x != null);
    const tm = median(times);
    const est = input.estimates?.[c] ?? null;
    const basis: MinutesBasis = times.length >= TIMED_MIN ? 'timed' : est != null ? 'estimate' : 'typing_only';
    // Timed already includes the typing; it never goes below the floor.
    const minutes = basis === 'timed' ? Math.max(tm!, typing) : basis === 'estimate' ? typing + est! : typing;
    const perWeek = corrected[c] / weeks;
    const after = mine.filter((r) => !inWorkingHours(r.sentAt, st, cal)).length;
    return {
      category: c, label: OUT_SPEC[c].label, tier: OUT_SPEC[c].tier,
      count: raw[c], corrected: round(corrected[c]), perWeek: round(perWeek),
      avgWords: Math.round(avgWords), typingMinutes: round(typing, 2), estimateMinutes: est,
      timed: times.length, timedMedian: tm == null ? null : round(tm, 2),
      minutes: round(minutes, 2), basis,
      hoursPerWeekFloor: round((perWeek * typing) / 60, 2), hoursPerWeek: round((perWeek * minutes) / 60, 2),
      shareOfWeek: round((perWeek * minutes) / 60 / st.contractedHours, 3),
      afterHours: after,
    };
  });

  const tiers = Object.fromEntries((['automated', 'drafted', 'conveyancer', 'excluded'] as Tier[]).map((t) => {
    const ls = lines.filter((l) => l.tier === t);
    return [t, { hoursPerWeek: round(ls.reduce((a, l) => a + l.hoursPerWeek, 0), 2), hoursPerWeekFloor: round(ls.reduce((a, l) => a + l.hoursPerWeekFloor, 0), 2), perWeek: round(ls.reduce((a, l) => a + l.perWeek, 0)) }];
  })) as Report['tiers'];

  // §6: the 'Sent by' tier in full; for the 'Drafted by' tier, only the typing.
  const freedWeek = round(tiers.automated.hoursPerWeek + tiers.drafted.hoursPerWeekFloor, 1);
  const freedFloor = tiers.automated.hoursPerWeekFloor + tiers.drafted.hoursPerWeekFloor;
  const freedMonth = round((freedWeek * 52) / 12, 1);
  // Rounded as shown, so the money can be checked by hand from the figures on the page.
  const completions = st.hoursPerCompletion && st.hoursPerCompletion > 0 ? round(round(freedMonth, 1) / st.hoursPerCompletion, 2) : null;

  const counted = out.filter((r) => OUT_SPEC[r.category as OutCategory].tier !== 'excluded');
  return {
    window: { since: input.since, until: input.until, workingWeeks: round(weeks) },
    read: { total: rows.length, sent: sent.length, received: received.length, filtered, classified: rows.filter((r) => !r.filtered && r.category).length },
    accuracy: { checked: checked.length, agreed, rate: checked.length ? round(agreed / checked.length, 3) : null, low: ci ? round(ci.low, 3) : null, high: ci ? round(ci.high, 3) : null, asked: out.filter((r) => r.inSample).length },
    lines,
    received: IN_CATEGORIES.map((c) => { const n = received.filter((r) => !r.filtered && r.category === c).length; return { category: c, count: n, perWeek: round(n / weeks) }; }),
    tiers,
    freed: {
      hoursPerWeek: round(freedWeek, 1), hoursPerWeekFloor: round(freedFloor, 1), shareOfWeek: round(freedWeek / st.contractedHours, 3), hoursPerMonth: round(freedMonth, 1),
      completionsPerMonth: completions,
      firmPerMonthPennies: completions != null && st.feePerCompletionPennies != null ? Math.round(completions * st.feePerCompletionPennies) : null,
      payPerMonthPennies: completions != null && st.payPerCompletionPennies != null ? Math.round(completions * st.payPerCompletionPennies) : null,
    },
    afterHoursShare: counted.length ? round(counted.filter((r) => !inWorkingHours(r.sentAt, st, cal)).length / counted.length, 3) : null,
    settings: st,
  };
}

/** A random sample of `n` ids, reproducible from a seed (the scan's id), so a re-draw asks for the same ones. */
export function drawSample<T extends { id: string }>(rows: T[], n: number, seed: string): T[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const rand = () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  const a = [...rows];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}
