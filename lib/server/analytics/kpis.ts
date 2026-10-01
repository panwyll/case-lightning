/**
 * Firm analytics (docs/analytics.md): how a conveyancing firm is pacing, where its cases wait, and how
 * each person is doing, built the way target-driven teams read their numbers.
 *
 * - Every outcome has a comparison: target and pace, the same point last year, the firm's record, its own past.
 * - Percentiles, not averages (cycle times are skewed); every figure carries how many cases it rests on,
 *   and a figure on fewer than MIN_SAMPLE is marked thin, not hidden.
 * - Delay is attributed: at any moment a case is with us (something waits on a person here), waiting on
 *   someone else (the client, the other side, the lender, the searches, the Land Registry), or has nothing open.
 * - Leading indicators beside lagging ones: instructions and banked exchanges say what completions will be.
 * Pure: the loader (load.ts) turns stored cases into CaseFacts.
 */
import { EW_CALENDAR, workingDaysBetween } from '../engine/working-days';

export type Party = 'us' | 'client' | 'other_side' | 'lender' | 'searches' | 'land_registry' | 'other';
export const PARTY_LABEL: Record<Party | 'none', string> = { us: 'With Us', client: 'Waiting On The Client', other_side: 'Waiting On The Other Side', lender: 'Waiting On The Lender', searches: 'Waiting On Searches', land_registry: 'Waiting On The Land Registry', other: 'Waiting On Others', none: 'Nothing Outstanding' };
export type CaseSide = 'purchase' | 'sale' | 'remortgage' | 'transfer' | 'other';

export interface CaseFacts {
  id: string;
  ref: string;
  handlerId: string | null;
  side: CaseSide;
  leasehold: boolean;
  instructedAt: string;
  exchangedAt: string | null;
  completedAt: string | null;
  abandoned: { at: string; reason: string } | null;
  completionDate: string | null;
  /** Our fee for the case, ex VAT, from the firm's fee scale (fees.ts); null when the firm has not set its fees. */
  fee?: number | null;
  waits: Array<{ key: string; party: Party; openedAt: string; closedAt: string | null; chases: string[] }>;
  decisions: Array<{ kind: string; createdAt: string; resolvedAt: string | null; resolvedBy: string | null }>;
}
export interface FeedbackFact { matterId: string; handlerId: string | null; kind: 'csat' | 'nps'; score: number; comment: string | null; at: string }
export interface AnalyticsInput {
  now: Date;
  cases: CaseFacts[];
  feedback: FeedbackFact[];
  targets: { monthlyCompletions: number | null; perPerson: Record<string, number> };
  people: Array<{ id: string; name: string }>;
}
export interface Scope { personId?: string | null; side?: CaseSide | null }

export const MIN_SAMPLE = 5;
/** Published reference points, shown as such (docs/analytics.md has the sources). */
export const INDUSTRY = {
  instructionToCompletionDays: { value: 123, source: 'Landmark, 2025 (England and Wales)' },
  fallThroughRate: { value: 0.237, source: 'TwentyEA, Q1 2026' },
};

export interface Stat { p50: number | null; p85: number | null; n: number; thin: boolean }
export interface PersonRow {
  id: string; name: string; active: number; completionsThisMonth: number; target: number | null; bookedThisMonth: number; feesThisMonth: number; fees12m: number;
  completions12m: number; monthlyAverage6m: number; cycle: Stat; taskHours: Stat; overdueTasks: number; withUsShare: number | null;
  csat: { pct: number | null; n: number }; nps: { score: number | null; n: number }; fallThrough: { rate: number | null; n: number };
}
export interface AnalyticsReport {
  generatedAt: string;
  scope: { personId: string | null; personName: string | null; side: CaseSide | null };
  pace: {
    month: string; completions: number; booked: number; forecast: number; runRate: number | null; target: number | null;
    workingDaysGone: number; workingDaysInMonth: number; samePointLastYear: number; lastYearMonth: number;
    record: { month: string; completions: number } | null; yearToDate: number; lastYearToDate: number;
  };
  instructions: { thisMonth: number; samePointLastYear: number; last4Weeks: number; same4WeeksLastYear: number };
  months: Array<{ month: string; instructions: number; exchanges: number; completions: number; fellThrough: number; completionsLastYear: number; fees: number }>;
  /** Fee income, counted on completion. `set` false until the firm sets its fees. */
  fees: { set: boolean; thisMonth: number; booked: number; forecast: number; lastYearMonth: number; yearToDate: number; lastYearToDate: number; perCompletion: number | null; pipeline: number; lostToFallThrough: number };
  pipeline: { open: number; byStep: Array<{ step: string; label: string; count: number }>; exchangedAwaiting: number; completingNext30: number };
  cycle: { instructionToExchange: Stat; exchangeToCompletion: Stat; instructionToCompletion: Stat; lastYearInstructionToCompletion: Stat; sle: number | null; industry: typeof INDUSTRY.instructionToCompletionDays };
  ageing: { overSle: number; cases: Array<{ id: string; ref: string; handler: string | null; ageDays: number; step: string; waitingOn: string }> };
  flow: { windowDays: number; shares: Array<{ party: Party | 'none'; label: string; days: number; share: number }>; withUsOfOutstanding: number | null; caseDays: number };
  delays: Array<{ key: string; label: string; party: Party; n: number; p50: number | null; totalDays: number; share: number; open: number }>;
  tasks: { turnaroundHours: Stat; pending: number; overdue: number; slowestKinds: Array<{ kind: string; label: string; p50: number; n: number }> };
  chases: { sent: number; answeredWithin3Days: number | null; medianDaysToReply: number | null; byParty: Array<{ party: Party; label: string; sent: number; answered: number | null }> };
  fallThrough: { rate: number | null; n: number; completed: number; fell: number; reasons: Array<{ reason: string; count: number }>; industry: typeof INDUSTRY.fallThroughRate };
  satisfaction: { csat: { pct: number | null; avg: number | null; n: number }; nps: { score: number | null; promoters: number; detractors: number; n: number }; responseRate: number | null; comments: Array<{ score: number; kind: 'csat' | 'nps'; comment: string; at: string }> };
  people: PersonRow[];
  /** Month by month for each person, with the team's line: completions, instructions, response time (median hours to clear a task), satisfaction (% scoring 4-5 of 5, or 9-10 of 10), survey answers, and survey rate (answers ÷ exchanges and completions, when clients are asked). */
  team: { months: string[]; people: Array<{ id: string; name: string }>; metrics: Record<TeamMetric, { kind: 'count' | 'hours' | 'percent'; perPerson: Array<Array<number | null>>; team: Array<number | null> }> };
  insights: string[];
}
export type TeamMetric = 'completions' | 'instructions' | 'responseHours' | 'satisfaction' | 'surveys' | 'surveyRate';

// ───────────────────────────── helpers ─────────────────────────────

const DAY = 86_400_000;
const t = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const days = (a: string, b: string | Date) => (t(typeof b === 'string' ? b : b.toISOString()) - t(a)) / DAY;
const monthKey = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 7);
const addMonths = (key: string, n: number) => { const [y, m] = key.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const monthStart = (key: string) => new Date(`${key}-01T00:00:00Z`);
export const MONTH_LABEL = (key: string) => monthStart(key).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
const stat = (xs: number[], round = 0): Stat => {
  const r = (v: number | null) => (v === null ? null : Math.round(v * 10 ** round) / 10 ** round);
  return { p50: r(percentile(xs, 50)), p85: r(percentile(xs, 85)), n: xs.length, thin: xs.length < MIN_SAMPLE };
};
const within = (iso: string | null, from: Date, to: Date) => !!iso && t(iso) >= from.getTime() && t(iso) < to.getTime();
const sumFees = (cs: CaseFacts[]) => Math.round(cs.reduce((a, c) => a + (c.fee ?? 0), 0));
const pct = (a: number, b: number) => (b > 0 ? a / b : null);
const STEP_LABEL: Record<string, string> = { pre_exchange: 'Pre-Exchange', exchanged: 'Exchanged' };
const WAIT_LABEL: Record<string, string> = {
  search: 'Searches', enquiry: 'Enquiry Replies', contract_pack: 'Contract Pack', mortgage_offer: 'Mortgage Offer', id_check: 'ID Checks', proof_of_funds: 'Proof Of Funds',
  property_forms: 'Property Forms', management_pack: 'Management Pack', funds: 'Completion Funds', deposit: 'Deposit', signed_documents: 'Signed Documents', survey: 'Survey',
  redemption: 'Redemption Statement', registration: 'Registration', lender_consent: "Lender's Consent", client_decision: 'Client Decisions', insurance: 'Buildings Insurance', discharge: 'Mortgage Discharge',
};
export const waitLabel = (k: string) => WAIT_LABEL[k] ?? k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const KIND_NAMES: Record<string, string> = { id_check: 'ID Check Results', proposal: 'Approvals', search: 'Search Results', enquiry: 'Enquiry Replies', title: 'Title', proof_of_funds: 'Proof Of Funds', report_on_title: 'Report On Title', mortgage: 'Mortgage Offers', bank_details: 'Bank Details', management_pack: 'Management Packs', auto_clear: 'Automatic Clears', note_actions: 'Emails And Notes' };
const KIND_LABEL = (k: string) => KIND_NAMES[k] ?? k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const stepOf = (c: CaseFacts) => (c.completedAt ? 'completed' : c.abandoned ? 'aborted' : c.exchangedAt ? 'exchanged' : 'pre_exchange');
const isOpen = (c: CaseFacts) => !c.completedAt && !c.abandoned;

/** Time on a case, split by who it was waiting on (us first: anything waiting on a person here is ours). */
export function attribute(c: CaseFacts, from: Date, to: Date): Record<Party | 'none', number> {
  const out = { us: 0, client: 0, other_side: 0, lender: 0, searches: 0, land_registry: 0, other: 0, none: 0 } as Record<Party | 'none', number>;
  const end = Math.min(to.getTime(), c.completedAt ? t(c.completedAt) : c.abandoned ? t(c.abandoned.at) : Infinity);
  const start = Math.max(from.getTime(), t(c.instructedAt));
  if (!(end > start)) return out;
  const spans: Array<{ a: number; b: number; who: Party }> = [
    ...c.decisions.map((d) => ({ a: t(d.createdAt), b: d.resolvedAt ? t(d.resolvedAt) : end, who: 'us' as Party })),
    ...c.waits.map((w) => ({ a: t(w.openedAt), b: w.closedAt ? t(w.closedAt) : end, who: w.party })),
  ].filter((s) => s.b > start && s.a < end && s.b > s.a);
  const cuts = Array.from(new Set([start, end, ...spans.flatMap((s) => [s.a, s.b]).filter((x) => x > start && x < end)])).sort((a, b) => a - b);
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i], b = cuts[i + 1], len = (b - a) / DAY;
    const live = spans.filter((s) => s.a <= a && s.b >= b);
    if (live.some((s) => s.who === 'us')) out.us += len;
    else if (live.length) {
      const who = Array.from(new Set(live.map((s) => s.who)));
      for (const w of who) out[w] += len / who.length;
    } else out.none += len;
  }
  return out;
}

// ───────────────────────────── the report ─────────────────────────────

export function computeAnalytics(input: AnalyticsInput, scope: Scope = {}): AnalyticsReport {
  const now = input.now;
  const bySide = (c: CaseFacts) => !scope.side || c.side === scope.side;
  const sided = input.cases.filter(bySide);
  const cases = scope.personId ? sided.filter((c) => c.handlerId === scope.personId) : sided;
  const ids = new Set(cases.map((c) => c.id));
  const feedback = input.feedback.filter((f) => ids.has(f.matterId));
  const name = (id: string | null) => (id ? input.people.find((p) => p.id === id)?.name ?? null : null);
  const target = scope.personId ? input.targets.perPerson[scope.personId] ?? null : input.targets.monthlyCompletions;

  // Pace: this month against target, the record, and the same point last year.
  const thisMonth = monthKey(now);
  const mStart = monthStart(thisMonth);
  const mEnd = monthStart(addMonths(thisMonth, 1));
  const lyNow = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
  const lyStart = monthStart(addMonths(thisMonth, -12));
  const lyEnd = monthStart(addMonths(thisMonth, -11));
  const completions = cases.filter((c) => within(c.completedAt, mStart, now)).length;
  const booked = cases.filter((c) => isOpen(c) && c.exchangedAt && c.completionDate && t(`${c.completionDate.slice(0, 10)}T12:00:00Z`) >= now.getTime() - DAY && t(`${c.completionDate.slice(0, 10)}T00:00:00Z`) < mEnd.getTime()).length;
  const wdGone = workingDaysBetween(mStart, now, EW_CALENDAR);
  const wdAll = workingDaysBetween(mStart, mEnd, EW_CALENDAR);
  const byMonth = new Map<string, number>();
  for (const c of cases) if (c.completedAt) byMonth.set(monthKey(c.completedAt), (byMonth.get(monthKey(c.completedAt)) ?? 0) + 1);
  const past = [...byMonth].filter(([k]) => k < thisMonth).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const yStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const lyYStart = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
  const pace = {
    month: thisMonth, completions, booked, forecast: completions + booked,
    runRate: wdGone >= 3 ? Math.round((completions / wdGone) * wdAll) : null,
    target, workingDaysGone: wdGone, workingDaysInMonth: wdAll,
    samePointLastYear: cases.filter((c) => within(c.completedAt, lyStart, lyNow)).length,
    lastYearMonth: cases.filter((c) => within(c.completedAt, lyStart, lyEnd)).length,
    record: past.length ? { month: past[0][0], completions: past[0][1] } : null,
    yearToDate: cases.filter((c) => within(c.completedAt, yStart, now)).length,
    lastYearToDate: cases.filter((c) => within(c.completedAt, lyYStart, lyNow)).length,
  };

  // Instructions: the leading indicator (completions follow three to four months later).
  const w4 = new Date(now.getTime() - 28 * DAY);
  const instructions = {
    thisMonth: cases.filter((c) => within(c.instructedAt, mStart, now)).length,
    samePointLastYear: cases.filter((c) => within(c.instructedAt, lyStart, lyNow)).length,
    last4Weeks: cases.filter((c) => within(c.instructedAt, w4, now)).length,
    same4WeeksLastYear: cases.filter((c) => within(c.instructedAt, new Date(w4.getTime() - 365 * DAY), new Date(now.getTime() - 365 * DAY))).length,
  };

  const months = Array.from({ length: 24 }, (_, i) => addMonths(thisMonth, i - 23)).map((m) => {
    const a = monthStart(m), b = monthStart(addMonths(m, 1)), la = monthStart(addMonths(m, -12)), lb = monthStart(addMonths(m, -11));
    return {
      month: m,
      instructions: cases.filter((c) => within(c.instructedAt, a, b)).length,
      exchanges: cases.filter((c) => within(c.exchangedAt, a, b)).length,
      completions: cases.filter((c) => within(c.completedAt, a, b)).length,
      fellThrough: cases.filter((c) => within(c.abandoned?.at ?? null, a, b)).length,
      completionsLastYear: cases.filter((c) => within(c.completedAt, la, lb)).length,
      fees: sumFees(cases.filter((c) => within(c.completedAt, a, b))),
    };
  });

  const open = cases.filter(isOpen);
  const stepCounts = ['pre_exchange', 'exchanged'].map((s) => ({ step: s, label: STEP_LABEL[s], count: open.filter((c) => stepOf(c) === s).length }));
  const pipeline = {
    open: open.length, byStep: stepCounts,
    exchangedAwaiting: open.filter((c) => c.exchangedAt).length,
    completingNext30: open.filter((c) => c.completionDate && t(`${c.completionDate.slice(0, 10)}T12:00:00Z`) >= now.getTime() - DAY && t(`${c.completionDate.slice(0, 10)}T12:00:00Z`) <= now.getTime() + 30 * DAY).length,
  };

  const isBooked = (c: CaseFacts) => isOpen(c) && !!c.exchangedAt && !!c.completionDate && t(`${c.completionDate.slice(0, 10)}T12:00:00Z`) >= now.getTime() - DAY && t(`${c.completionDate.slice(0, 10)}T00:00:00Z`) < mEnd.getTime();
  const done12f = cases.filter((c) => within(c.completedAt, new Date(now.getTime() - 365 * DAY), now) && c.fee != null);
  const fees = {
    set: cases.some((c) => c.fee != null),
    thisMonth: sumFees(cases.filter((c) => within(c.completedAt, mStart, now))),
    booked: sumFees(cases.filter(isBooked)),
    forecast: 0,
    lastYearMonth: sumFees(cases.filter((c) => within(c.completedAt, lyStart, lyEnd))),
    yearToDate: sumFees(cases.filter((c) => within(c.completedAt, yStart, now))),
    lastYearToDate: sumFees(cases.filter((c) => within(c.completedAt, lyYStart, lyNow))),
    perCompletion: done12f.length ? Math.round(sumFees(done12f) / done12f.length) : null,
    pipeline: sumFees(open),
    lostToFallThrough: sumFees(cases.filter((c) => within(c.abandoned?.at ?? null, new Date(now.getTime() - 365 * DAY), now))),
  };
  fees.forecast = fees.thisMonth + fees.booked;

  // Cycle times over the last twelve months, and the twelve before.
  const y1 = new Date(now.getTime() - 365 * DAY), y2 = new Date(now.getTime() - 730 * DAY);
  const done12 = cases.filter((c) => within(c.completedAt, y1, now));
  const done24 = cases.filter((c) => within(c.completedAt, y2, y1));
  const i2c = stat(done12.map((c) => days(c.instructedAt, c.completedAt!)));
  const cycle = {
    instructionToExchange: stat(cases.filter((c) => within(c.exchangedAt, y1, now)).map((c) => days(c.instructedAt, c.exchangedAt!))),
    exchangeToCompletion: stat(done12.filter((c) => c.exchangedAt).map((c) => days(c.exchangedAt!, c.completedAt!))),
    instructionToCompletion: i2c,
    lastYearInstructionToCompletion: stat(done24.map((c) => days(c.instructedAt, c.completedAt!))),
    sle: i2c.thin ? null : i2c.p85,
    industry: INDUSTRY.instructionToCompletionDays,
  };

  // Ageing work: open cases older than 85% of completed cases took (or than the industry figure, until the firm has its own).
  const sle = cycle.sle ?? Math.round(INDUSTRY.instructionToCompletionDays.value * 1.3);
  const waitingOn = (c: CaseFacts) => {
    if (c.decisions.some((d) => !d.resolvedAt)) return PARTY_LABEL.us;
    const w = c.waits.filter((x) => !x.closedAt).sort((a, b) => a.openedAt.localeCompare(b.openedAt))[0];
    return w ? `${waitLabel(w.key)} (${PARTY_LABEL[w.party].replace('Waiting On ', '')})` : PARTY_LABEL.none;
  };
  const aged = open.map((c) => ({ c, age: Math.floor(days(c.instructedAt, now)) })).filter((x) => x.age > sle).sort((a, b) => b.age - a.age);
  const ageing = { overSle: aged.length, cases: aged.slice(0, 12).map(({ c, age }) => ({ id: c.id, ref: c.ref, handler: name(c.handlerId), ageDays: age, step: STEP_LABEL[stepOf(c)] ?? stepOf(c), waitingOn: waitingOn(c) })) };

  // Flow: the last 90 days of every case's life, by who it was waiting on.
  const winDays = 90;
  const win = new Date(now.getTime() - winDays * DAY);
  const tot = { us: 0, client: 0, other_side: 0, lender: 0, searches: 0, land_registry: 0, other: 0, none: 0 } as Record<Party | 'none', number>;
  for (const c of cases) { const a = attribute(c, win, now); for (const k of Object.keys(tot) as Array<Party | 'none'>) tot[k] += a[k]; }
  const caseDays = Object.values(tot).reduce((a, b) => a + b, 0);
  const outstanding = caseDays - tot.none;
  const flow = {
    windowDays: winDays, caseDays: Math.round(caseDays),
    shares: (Object.keys(tot) as Array<Party | 'none'>).filter((k) => tot[k] > 0).map((k) => ({ party: k, label: PARTY_LABEL[k], days: Math.round(tot[k]), share: caseDays ? tot[k] / caseDays : 0 })).sort((a, b) => (a.party === 'none' ? 1 : b.party === 'none' ? -1 : b.days - a.days)),
    withUsOfOutstanding: outstanding > 0 ? tot.us / outstanding : null,
  };

  // What cases wait for, by kind: how long each takes and how much of the waiting it is.
  const waits12 = cases.flatMap((c) => c.waits.filter((w) => (w.closedAt ? t(w.closedAt) >= y1.getTime() : isOpen(c))).map((w) => ({ ...w, endAt: w.closedAt ?? now.toISOString() })));
  const keys = Array.from(new Set(waits12.map((w) => w.key)));
  const waitTotal = waits12.reduce((a, w) => a + Math.max(0, days(w.openedAt, w.endAt)), 0);
  const delays = keys.map((k) => {
    const ws = waits12.filter((w) => w.key === k);
    const closed = ws.filter((w) => w.closedAt).map((w) => days(w.openedAt, w.closedAt!));
    const total = ws.reduce((a, w) => a + Math.max(0, days(w.openedAt, w.endAt)), 0);
    return { key: k, label: waitLabel(k), party: ws[0].party, n: closed.length, p50: closed.length ? Math.round(percentile(closed, 50)! * 10) / 10 : null, totalDays: Math.round(total), share: waitTotal ? total / waitTotal : 0, open: ws.filter((w) => !w.closedAt).length };
  }).sort((a, b) => b.totalDays - a.totalDays);

  // Our own turnaround on what comes to a person.
  const q = new Date(now.getTime() - 90 * DAY);
  const resolved = cases.flatMap((c) => c.decisions.filter((d) => within(d.resolvedAt, q, now)));
  const pendingNow = open.flatMap((c) => c.decisions.filter((d) => !d.resolvedAt));
  const kinds = Array.from(new Set(resolved.map((d) => d.kind)));
  const tasks = {
    turnaroundHours: stat(resolved.map((d) => (t(d.resolvedAt!) - t(d.createdAt)) / 3_600_000), 1),
    pending: pendingNow.length,
    overdue: pendingNow.filter((d) => workingDaysBetween(new Date(d.createdAt), now, EW_CALENDAR) > 2).length,
    slowestKinds: kinds.map((k) => { const xs = resolved.filter((d) => d.kind === k).map((d) => (t(d.resolvedAt!) - t(d.createdAt)) / 3_600_000); return { kind: k, label: KIND_LABEL(k), p50: Math.round(percentile(xs, 50)! * 10) / 10, n: xs.length }; }).filter((k) => k.n >= 3).sort((a, b) => b.p50 - a.p50).slice(0, 5),
  };

  // Chasing: does a chase get an answer?
  const chaseRows = cases.flatMap((c) => c.waits.flatMap((w) => w.chases.filter((at) => within(at, q, now)).map((at) => ({ party: w.party, at, closedAt: w.closedAt }))));
  const answered = (r: (typeof chaseRows)[number]) => !!r.closedAt && t(r.closedAt) >= t(r.at) && t(r.closedAt) - t(r.at) <= 3 * DAY;
  const settled = chaseRows.filter((r) => r.closedAt || days(r.at, now) > 3);
  const replyDays = chaseRows.filter((r) => r.closedAt && t(r.closedAt) >= t(r.at)).map((r) => days(r.at, r.closedAt!));
  const parties = Array.from(new Set(chaseRows.map((r) => r.party)));
  const chases = {
    sent: chaseRows.length,
    answeredWithin3Days: pct(settled.filter(answered).length, settled.length),
    medianDaysToReply: replyDays.length ? Math.round(percentile(replyDays, 50)! * 10) / 10 : null,
    byParty: parties.map((p) => { const rs = settled.filter((r) => r.party === p); return { party: p, label: PARTY_LABEL[p].replace('Waiting On ', ''), sent: chaseRows.filter((r) => r.party === p).length, answered: pct(rs.filter(answered).length, rs.length) }; }).sort((a, b) => b.sent - a.sent),
  };

  // Fall-through, against the industry figure.
  const fell = cases.filter((c) => within(c.abandoned?.at ?? null, y1, now));
  const reasons = new Map<string, number>();
  for (const c of fell) reasons.set(c.abandoned!.reason, (reasons.get(c.abandoned!.reason) ?? 0) + 1);
  const fallThrough = { rate: pct(fell.length, fell.length + done12.length), n: fell.length + done12.length, completed: done12.length, fell: fell.length, reasons: [...reasons].map(([reason, count]) => ({ reason: KIND_LABEL(reason), count })).sort((a, b) => b.count - a.count), industry: INDUSTRY.fallThroughRate };

  const satisfaction = satisfactionOf(feedback.filter((f) => t(f.at) >= y1.getTime()), done12.length);

  // People: each against their own past and their own target, never ranked.
  const peopleIds = scope.personId ? [scope.personId] : Array.from(new Set(sided.map((c) => c.handlerId).filter((x): x is string => !!x)));
  const people = peopleIds.map((id) => personRow(id, name(id) ?? 'Unassigned', sided.filter((c) => c.handlerId === id), input.feedback, input.targets.perPerson[id] ?? null, now)).sort((a, b) => a.name.localeCompare(b.name));

  const report: AnalyticsReport = {
    generatedAt: now.toISOString(),
    scope: { personId: scope.personId ?? null, personName: name(scope.personId ?? null), side: scope.side ?? null },
    pace, instructions, months, fees, pipeline, cycle, ageing, flow, delays, tasks, chases, fallThrough, satisfaction, people, team: teamSeries(sided, input.feedback, people.map((p) => ({ id: p.id, name: p.name })), thisMonth), insights: [],
  };
  report.insights = insights(report);
  return report;
}

/** Twelve months of each person's figures beside the team's, for the clustered charts. */
function teamSeries(cases: CaseFacts[], fb: FeedbackFact[], people: Array<{ id: string; name: string }>, thisMonth: string): AnalyticsReport['team'] {
  // Whole months only: a month in progress would read as a fall (this month is the tiles' job).
  const months = Array.from({ length: 12 }, (_, i) => addMonths(thisMonth, i - 12));
  const range = (m: string) => [monthStart(m), monthStart(addMonths(m, 1))] as const;
  const count = (cs: CaseFacts[], at: (c: CaseFacts) => string | null) => months.map((m) => { const [a, b] = range(m); return cs.filter((c) => within(at(c), a, b)).length; });
  const hours = (pred: (d: CaseFacts['decisions'][number]) => boolean) => months.map((m) => {
    const [a, b] = range(m);
    const xs = cases.flatMap((c) => c.decisions).filter((d) => pred(d) && within(d.resolvedAt, a, b)).map((d) => (t(d.resolvedAt!) - t(d.createdAt)) / 3_600_000);
    return xs.length ? Math.round(percentile(xs, 50)! * 10) / 10 : null;
  });
  const happy = (f: FeedbackFact) => (f.kind === 'nps' ? f.score >= 9 : f.score >= 4);
  const ids = new Set(cases.map((c) => c.id));
  const sat = (pred: (f: FeedbackFact) => boolean) => months.map((m) => {
    const [a, b] = range(m);
    const xs = fb.filter((f) => ids.has(f.matterId) && pred(f) && within(f.at, a, b));
    return xs.length ? Math.round((xs.filter(happy).length / xs.length) * 100) : null;
  });
  const mine = (id: string) => cases.filter((c) => c.handlerId === id);
  const responses = (pred: (f: FeedbackFact) => boolean) => months.map((m) => { const [a, b] = range(m); return fb.filter((f) => ids.has(f.matterId) && pred(f) && within(f.at, a, b)).length; });
  // Clients are asked at exchange and at completion: the rate is answers over those moments in the month.
  const asked = (cs: CaseFacts[]) => months.map((m) => { const [a, b] = range(m); return cs.filter((c) => within(c.exchangedAt, a, b)).length + cs.filter((c) => within(c.completedAt, a, b)).length; });
  const rate = (got: number[], of: number[]) => got.map((g, i) => (of[i] ? Math.min(100, Math.round((g / of[i]) * 100)) : null));
  return {
    months,
    people,
    metrics: {
      completions: { kind: 'count', perPerson: people.map((p) => count(mine(p.id), (c) => c.completedAt)), team: count(cases, (c) => c.completedAt) },
      instructions: { kind: 'count', perPerson: people.map((p) => count(mine(p.id), (c) => c.instructedAt)), team: count(cases, (c) => c.instructedAt) },
      responseHours: { kind: 'hours', perPerson: people.map((p) => hours((d) => d.resolvedBy === p.id)), team: hours(() => true) },
      satisfaction: { kind: 'percent', perPerson: people.map((p) => sat((f) => f.handlerId === p.id)), team: sat(() => true) },
      surveys: { kind: 'count', perPerson: people.map((p) => responses((f) => f.handlerId === p.id)), team: responses(() => true) },
      surveyRate: { kind: 'percent', perPerson: people.map((p) => rate(responses((f) => f.handlerId === p.id), asked(mine(p.id)))), team: rate(responses(() => true), asked(cases)) },
    },
  };
}

function satisfactionOf(fb: FeedbackFact[], completions: number): AnalyticsReport['satisfaction'] {
  const csat = fb.filter((f) => f.kind === 'csat');
  const nps = fb.filter((f) => f.kind === 'nps');
  const promoters = nps.filter((f) => f.score >= 9).length;
  const detractors = nps.filter((f) => f.score <= 6).length;
  return {
    csat: { pct: pct(csat.filter((f) => f.score >= 4).length, csat.length), avg: csat.length ? Math.round((csat.reduce((a, f) => a + f.score, 0) / csat.length) * 10) / 10 : null, n: csat.length },
    nps: { score: nps.length ? Math.round(((promoters - detractors) / nps.length) * 100) : null, promoters, detractors, n: nps.length },
    responseRate: pct(nps.length, completions),
    comments: fb.filter((f) => f.comment).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6).map((f) => ({ score: f.score, kind: f.kind, comment: f.comment!, at: f.at })),
  };
}

function personRow(id: string, name: string, cases: CaseFacts[], fb: FeedbackFact[], target: number | null, now: Date): PersonRow {
  const thisMonth = monthKey(now);
  const mStart = monthStart(thisMonth), mEnd = monthStart(addMonths(thisMonth, 1));
  const y1 = new Date(now.getTime() - 365 * DAY), q = new Date(now.getTime() - 90 * DAY);
  const done12 = cases.filter((c) => within(c.completedAt, y1, now));
  const six = cases.filter((c) => within(c.completedAt, monthStart(addMonths(thisMonth, -6)), mStart)).length;
  const fell = cases.filter((c) => within(c.abandoned?.at ?? null, y1, now)).length;
  const mine = cases.flatMap((c) => c.decisions);
  const resolvedByThem = mine.filter((d) => within(d.resolvedAt, q, now));
  let us = 0, out = 0;
  for (const c of cases) { const a = attribute(c, q, now); us += a.us; out += a.us + a.client + a.other_side + a.lender + a.searches + a.land_registry + a.other; }
  const theirFb = fb.filter((f) => f.handlerId === id && t(f.at) >= y1.getTime());
  const s = satisfactionOf(theirFb, done12.length);
  return {
    id, name,
    active: cases.filter(isOpen).length,
    completionsThisMonth: cases.filter((c) => within(c.completedAt, mStart, now)).length,
    bookedThisMonth: cases.filter((c) => isOpen(c) && c.exchangedAt && c.completionDate && t(`${c.completionDate.slice(0, 10)}T12:00:00Z`) >= now.getTime() - DAY && t(`${c.completionDate.slice(0, 10)}T00:00:00Z`) < mEnd.getTime()).length,
    target,
    feesThisMonth: sumFees(cases.filter((c) => within(c.completedAt, mStart, now))),
    fees12m: sumFees(done12),
    completions12m: done12.length,
    monthlyAverage6m: Math.round((six / 6) * 10) / 10,
    cycle: stat(done12.map((c) => days(c.instructedAt, c.completedAt!))),
    taskHours: stat(resolvedByThem.map((d) => (t(d.resolvedAt!) - t(d.createdAt)) / 3_600_000), 1),
    overdueTasks: cases.filter(isOpen).flatMap((c) => c.decisions.filter((d) => !d.resolvedAt)).filter((d) => workingDaysBetween(new Date(d.createdAt), now, EW_CALENDAR) > 2).length,
    withUsShare: out > 0 ? us / out : null,
    csat: { pct: s.csat.pct, n: s.csat.n },
    nps: { score: s.nps.score, n: s.nps.n },
    fallThrough: { rate: pct(fell, fell + done12.length), n: fell + done12.length },
  };
}

const P = (x: number) => `${Math.round(x * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The few sentences worth reading first, most important first. */
export function insights(r: AnalyticsReport): string[] {
  const out: string[] = [];
  const p = r.pace;
  if (p.target) {
    const gap = p.forecast - p.target;
    out.push(gap >= 0 ? `On course for ${p.forecast} completions this month against a target of ${p.target}: ${p.completions} done and ${p.booked} booked.` : `${Math.abs(gap)} short of this month's target of ${p.target} on what is done and booked (${p.completions} done, ${p.booked} booked).`);
  } else if (p.completions || p.booked) out.push(`${plural(p.completions, 'completion')} so far this month and ${p.booked} more booked.`);
  if (p.record && p.forecast > p.record.completions) out.push(`On course for a record month: the best so far is ${p.record.completions} in ${MONTH_LABEL(p.record.month)}.`);
  const top = r.delays.find((d) => d.n >= MIN_SAMPLE);
  if (top && top.share >= 0.15) out.push(`${top.label} take the most waiting: ${P(top.share)} of all waiting time, ${top.p50} days at the median.`);
  if (r.flow.withUsOfOutstanding !== null && r.flow.caseDays > 30) out.push(`When something is outstanding on a case, it is with us ${P(r.flow.withUsOfOutstanding)} of the time${r.tasks.overdue ? `, and ${plural(r.tasks.overdue, 'task')} ${r.tasks.overdue === 1 ? 'has' : 'have'} waited over two working days` : ''}.`);
  const c = r.cycle.instructionToCompletion, ly = r.cycle.lastYearInstructionToCompletion;
  if (!c.thin && c.p50 !== null) out.push(`Instruction to completion takes ${c.p50} days at the median${!ly.thin && ly.p50 !== null && ly.p50 !== c.p50 ? `, ${Math.abs(ly.p50 - c.p50)} days ${c.p50 < ly.p50 ? 'faster' : 'slower'} than the year before` : ''} (industry ${r.cycle.industry.value}).`);
  if (r.ageing.overSle && r.ageing.cases[0]) out.push(`${plural(r.ageing.overSle, 'open case is', 'open cases are')} older than ${r.cycle.sle ? '85% of completed cases took' : 'is usual'}; the oldest, ${r.ageing.cases[0].ref}, is at ${r.ageing.cases[0].ageDays} days, ${r.ageing.cases[0].waitingOn.toLowerCase()}.`);
  const i = r.instructions;
  if (i.same4WeeksLastYear >= MIN_SAMPLE) { const ch = (i.last4Weeks - i.same4WeeksLastYear) / i.same4WeeksLastYear; if (Math.abs(ch) >= 0.15) out.push(`Instructions are ${ch > 0 ? 'up' : 'down'} ${P(Math.abs(ch))} on the same four weeks last year: completions three to four months from now will follow.`); }
  if (r.fallThrough.rate !== null && r.fallThrough.n >= 10) out.push(`${P(r.fallThrough.rate)} of cases fell through in the last year (industry ${P(r.fallThrough.industry.value)})${r.fallThrough.reasons[0] ? `, most often: ${r.fallThrough.reasons[0].reason.toLowerCase()}` : ''}.`);
  if (r.chases.answeredWithin3Days !== null && r.chases.sent >= 10) out.push(`${P(r.chases.answeredWithin3Days)} of chases get an answer within three days${r.chases.byParty[0]?.answered != null ? `; ${r.chases.byParty[0].label.toLowerCase()} ${P(r.chases.byParty[0].answered!)}` : ''}.`);
  return out.slice(0, 6);
}
