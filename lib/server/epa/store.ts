/** EPA's storage (docs/epa.md): attention spans in, the firm's report out. */
import { query } from '../db';
import { engine } from '../engine/adapters';
import { DEFAULT_SETTINGS } from '../workload/model';
import { baselineScan, estimatesOf, firmSettings, reportFor } from '../workload/scan';
import type { SessionUser } from '../types';
import { completionSpans, DEFAULT_LUNCH, type Completion, type Span } from './ledger';
import { baselineSplit, buildEpaReport, emailEvidence, weekStart, type EpaReport } from './report';
import { buildMeasurement, READ_MINUTES, type Measurement, type PersonScan } from './measure';
import { DEFAULT_SETTINGS as WL_DEFAULTS, workingWeeks } from '../workload/model';
import { asKind, EPA_KINDS, EPA_SPEC, LEGACY_KINDS, fromEmail, fromTask, type EpaKind } from './taxonomy';

export interface SpanIn { start: string; end: string; source: 'focus' | 'reading'; item: string; matterId?: string | null; kind: string; of?: string | null; action?: string | null }

const MAX_SPAN_MS = 4 * 3_600_000;
const UUID = /^[0-9a-f-]{36}$/i;

/** A batch from the page: kept only if it is a plausible stretch of the person's own recent time. */
export async function recordSpans(user: SessionUser, spans: SpanIn[]): Promise<number> {
  const now = Date.now();
  let n = 0;
  for (const s of spans.slice(0, 200)) {
    const a = Date.parse(s.start);
    const b = Math.min(Date.parse(s.end), now + 60_000);
    if (!(b > a) || b - a > MAX_SPAN_MS || a < now - 14 * 86_400_000) continue;
    if (!(EPA_KINDS as readonly string[]).includes(s.kind) && !LEGACY_KINDS[s.kind]) continue;
    const of = s.of ? asKind(s.of) : null;
    await query(
      `insert into activity_span (tenant_id, user_id, started_at, ended_at, source, item, matter_id, kind, draft_of, action) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [user.tenantId, user.userId, new Date(a), new Date(b), s.source === 'reading' ? 'reading' : 'focus', String(s.item).slice(0, 200), s.matterId && UUID.test(s.matterId) ? s.matterId : null, asKind(s.kind), of, s.action ? String(s.action).slice(0, 60) : null]
    );
    n += 1;
  }
  return n;
}

/** One person's evidence since `since`: focus spans, Outlook drafting, and the time since each thing they finished. */
async function personSpans(tenantId: string, userId: string, since: Date, clip: { workdayStart: string; workdayEnd: string }): Promise<Span[]> {
  const [focus, sent, tasks, live] = await Promise.all([
    query<{ started_at: Date; ended_at: Date; source: 'focus' | 'reading'; item: string; kind: string; draft_of: string | null; action: string | null }>(
      `select started_at, ended_at, source, item, kind, draft_of, action from activity_span where user_id = $1 and ended_at > $2 order by started_at`, [userId, since]
    ).catch(() => []),
    // The same message in two scans is one email.
    query<{ id: string; category: string | null; drafted_at: Date | null; sent_at: Date; recipient_roles: string[] | null }>(
      `select distinct on (graph_message_id) graph_message_id as id, category, drafted_at, sent_at, recipient_roles
         from workload_email where user_id = $1 and direction = 'out' and filtered is null and sent_at > $2 order by graph_message_id, created_at desc`, [userId, since]
    ).catch(() => []),
    query<{ id: string; kind: string | null; chip: string | null; closed_at: Date }>(
      `select id, kind, chip, closed_at from task_record where tenant_id = $1 and closed_at > $2 and closed_by = $3::text and closed_how = 'done'`, [tenantId, since, userId]
    ).catch(() => []),
    // Recorded as they happened (live.ts): email classified as sent, and what was filed or completed in InTouch.
    query<{ source: string; ref: string; at: Date; drafted_at: Date | null; category: string | null; roles: string[] | null; kind: string | null; case_id: string | null }>(
      `select source, ref, at, drafted_at, category, roles, kind, case_id from epa_action where user_id = $1 and at > $2`, [userId, since]
    ).catch(() => []),
  ]);
  const spans: Span[] = focus.map((f) => ({ start: f.started_at.getTime(), end: f.ended_at.getTime(), item: f.item, kind: asKind(f.kind), of: f.draft_of ? asKind(f.draft_of) : null, action: f.action, source: f.source }));
  // Completions (docs/epa.md §2): what this person finished, each given the time since the one before.
  const done: Completion[] = tasks.map((t) => { const w = fromTask({ kind: t.kind, chip: t.chip }); return { at: t.closed_at.getTime(), item: `task:${t.id}`, kind: w.kind, of: w.of ?? null, action: w.action ?? null }; });
  const emails = new Map(sent.map((e) => [e.id, e]));
  // Emails opened on the Email tab: their reading is already timed there.
  const opened = new Set(focus.filter((f) => f.item.startsWith('email:')).map((f) => f.item.slice('email:'.length)));
  for (const a of live) {
    if (a.source === 'sent') {
      // CONVEYi sent it: CONVEYi's work, not the person's. A CONVEYi draft they sent: their time was checking it.
      if (a.kind === 'conveyi') { emails.delete(a.ref); continue; }
      if (a.kind === 'checking_drafts') { emails.delete(a.ref); done.push({ at: a.at.getTime(), item: `email:${a.ref}`, kind: 'checking_drafts', of: fromEmail(a.category, a.roles) }); continue; }
      if (!emails.has(a.ref)) emails.set(a.ref, { id: a.ref, category: a.category, drafted_at: a.drafted_at, sent_at: a.at, recipient_roles: a.roles });
    } else if (a.source === 'received') {
      // Reading, as the scan counts it, unless it became a CONVEYi task (filed to a case) or was opened in the app: timed there.
      const mins = READ_MINUTES[a.category ?? ''] ?? 0;
      const kind = fromEmail(a.category, a.roles);
      if (a.case_id || opened.has(a.ref) || !mins || EPA_SPEC[kind].rag === 'none') continue;
      spans.push({ start: a.at.getTime(), end: a.at.getTime() + mins * 60_000, item: `in:${a.ref}`, kind, source: 'estimate' });
    } else if (a.kind) done.push({ at: a.at.getTime(), item: `${a.source}:${a.ref}`, kind: asKind(a.kind) });
  }
  for (const e of emails.values()) {
    const ev = emailEvidence({ id: e.id, category: e.category, draftedAt: e.drafted_at?.toISOString() ?? null, sentAt: e.sent_at.toISOString(), roles: e.recipient_roles });
    if (!ev) continue;
    done.push(ev.done);
    if (ev.compose) spans.push(ev.compose);
  }
  spans.push(...completionSpans(done, { ...clip, ...DEFAULT_LUNCH }));
  return spans;
}

/** The firm's report over `weeks` weeks to now: everyone's time, added up. */
export async function epaReport(tenantId: string, weeks: number): Promise<EpaReport> {
  const now = Date.now();
  const since = new Date(weekStart(now) - (weeks - 1) * 7 * 86_400_000);
  const [settings, levels, people] = await Promise.all([
    firmSettings(tenantId),
    engine().eventStore.loadLevels(tenantId),
    query<{ id: string }>(`select id from app_user where tenant_id = $1`, [tenantId]),
  ]);
  const st = { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v != null)) };
  const perPerson = await Promise.all(people.map(async (p) => {
    const [spans, base, estimates] = await Promise.all([personSpans(tenantId, p.id, since, st), baselineScan(p.id), estimatesOf(p.id)]);
    const lines = base ? (await reportFor(base, settings, estimates).catch(() => null))?.lines ?? [] : [];
    return { spans, lines };
  }));
  // Before CONVEYi: every scanned person's hours per category, added up.
  const sum = new Map<string, number>();
  for (const p of perPerson) for (const l of p.lines) sum.set(l.category, (sum.get(l.category) ?? 0) + l.hoursPerWeek);
  return buildEpaReport({
    people: perPerson.map((p) => p.spans).filter((s) => s.length), now, weeks, workday: st, levels,
    baseline: sum.size ? baselineSplit([...sum].map(([category, hoursPerWeek]) => ({ category, hoursPerWeek }))) : null,
  });
}

/** The firm's measurement: everyone's latest finished scan, as a typical week (measure.ts), and when the latest was run. */
export async function firmMeasurement(tenantId: string): Promise<{ measurement: Measurement | null; scanned: number; scannedAt: string | null }> {
  const scans = await query<{ id: string; since: Date; until: Date; created_at: Date; intouch: PersonScan['intouch'] }>(
    `select distinct on (user_id) id, since, until, created_at, intouch from workload_scan
      where tenant_id = $1 and status in ('CHECKING', 'COMPLETE') order by user_id, created_at desc`, [tenantId]
  ).catch(() => []);
  if (!scans.length) return { measurement: null, scanned: 0, scannedAt: null };
  const [settings, levels] = await Promise.all([firmSettings(tenantId), engine().eventStore.loadLevels(tenantId)]);
  const people: PersonScan[] = [];
  for (const s of scans) {
    // Each email with its time: the measurement places them on the person's day.
    const rows = await query<{ id: string; direction: 'out' | 'in'; sent_at: Date; drafted_at: Date | null; category: string; roles: string[] | null; conversation_id: string | null }>(
      `select id, direction, sent_at, drafted_at, category, recipient_roles as roles, conversation_id from workload_email
        where scan_id = $1 and filtered is null and category is not null`, [s.id]
    );
    const as = (r: (typeof rows)[number]) => ({ id: r.id, at: r.sent_at.getTime(), draftedAt: r.drafted_at ? r.drafted_at.getTime() : null, category: r.category, roles: r.roles ?? [], conversationId: r.conversation_id });
    people.push({
      weeks: workingWeeks(new Date(s.since).toISOString(), new Date(s.until).toISOString()),
      sent: rows.filter((r) => r.direction === 'out').map(as),
      received: rows.filter((r) => r.direction === 'in').map(as),
      intouch: s.intouch ?? null,
    });
  }
  const measurement = buildMeasurement({
    people, levels, contractedHours: Number(settings.contractedHours ?? WL_DEFAULTS.contractedHours),
    workday: { workdayStart: settings.workdayStart ?? WL_DEFAULTS.workdayStart, workdayEnd: settings.workdayEnd ?? WL_DEFAULTS.workdayEnd },
  });
  const latest = Math.max(...scans.map((s) => new Date(s.created_at).getTime()));
  return { measurement, scanned: people.length, scannedAt: new Date(latest).toISOString() };
}
