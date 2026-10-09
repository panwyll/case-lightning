/** EPA's storage (docs/epa.md): attention spans in, a person's or the team's report out. */
import { query } from '../db';
import { engine } from '../engine/adapters';
import { DEFAULT_SETTINGS } from '../workload/model';
import { baselineScan, estimatesOf, firmSettings, reportFor } from '../workload/scan';
import type { SessionUser } from '../types';
import type { Span } from './ledger';
import { baselineEfficiency, buildEpaReport, emailSpan, weekStart, type EpaReport } from './report';
import { EPA_KINDS, fromTask, type EpaKind } from './taxonomy';

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
    if (!(EPA_KINDS as readonly string[]).includes(s.kind)) continue;
    const of = s.of && (EPA_KINDS as readonly string[]).includes(s.of) ? s.of : null;
    await query(
      `insert into activity_span (tenant_id, user_id, started_at, ended_at, source, item, matter_id, kind, draft_of, action) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [user.tenantId, user.userId, new Date(a), new Date(b), s.source === 'reading' ? 'reading' : 'focus', String(s.item).slice(0, 200), s.matterId && UUID.test(s.matterId) ? s.matterId : null, s.kind, of, s.action ? String(s.action).slice(0, 60) : null]
    );
    n += 1;
  }
  return n;
}

/** One person's report over `weeks` weeks to now. */
export async function epaReport(tenantId: string, userId: string, weeks: number): Promise<EpaReport & { measuredFrom: string | null }> {
  const now = Date.now();
  const since = new Date(weekStart(now) - (weeks - 1) * 7 * 86_400_000);
  const [settings, estimates, base, levels] = await Promise.all([firmSettings(tenantId), estimatesOf(userId), baselineScan(userId), engine().eventStore.loadLevels(tenantId)]);
  const st = { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(settings).filter(([, v]) => v != null)) };
  const baseline = base ? await reportFor(base, settings, estimates).catch(() => null) : null;
  const perEmail = new Map((baseline?.lines ?? []).map((l) => [l.category as string, l.minutes]));

  const [focus, sent, tasks] = await Promise.all([
    query<{ started_at: Date; ended_at: Date; source: 'focus' | 'reading'; item: string; kind: EpaKind; draft_of: EpaKind | null; action: string | null }>(
      `select started_at, ended_at, source, item, kind, draft_of, action from activity_span where user_id = $1 and ended_at > $2 order by started_at`, [userId, since]
    ).catch(() => []),
    // The same message in two scans is one email.
    query<{ id: string; category: string | null; drafted_at: Date | null; sent_at: Date; words_written: number }>(
      `select distinct on (graph_message_id) graph_message_id as id, category, drafted_at, sent_at, words_written
         from workload_email where user_id = $1 and direction = 'out' and filtered is null and sent_at > $2 order by graph_message_id, created_at desc`, [userId, since]
    ).catch(() => []),
    query<{ kind: string | null; chip: string | null; opened_at: Date; closed_at: Date }>(
      `select kind, chip, opened_at, closed_at from task_record where tenant_id = $1 and closed_at > $2
          and (closed_by = $3::text or (closed_by is null and assigned_to = $3::uuid))`, [tenantId, since, userId]
    ).catch(() => []),
  ]);

  const spans: Span[] = focus.map((f) => ({ start: f.started_at.getTime(), end: f.ended_at.getTime(), item: f.item, kind: f.kind, of: f.draft_of, action: f.action, source: f.source }));
  for (const e of sent) {
    const s = emailSpan({ id: e.id, category: e.category, draftedAt: e.drafted_at?.toISOString() ?? null, sentAt: e.sent_at.toISOString(), wordsWritten: e.words_written }, (c, words) => perEmail.get(c) ?? words / st.wpm);
    if (s) spans.push(s);
  }
  const report = buildEpaReport({
    spans, now, weeks, workday: st, levels,
    tasks: tasks.map((t) => ({ kind: fromTask({ kind: t.kind, chip: t.chip }).kind, openedAt: t.opened_at.getTime(), closedAt: t.closed_at.getTime() })),
    baselineEfficiency: baseline ? baselineEfficiency(baseline.lines) : null,
  });
  const firstFocus = await query<{ at: Date | null }>(`select min(started_at) as at from activity_span where user_id = $1`, [userId]).catch(() => []);
  return { ...report, measuredFrom: firstFocus[0]?.at?.toISOString() ?? null };
}

/** The people at the firm, for the admin's picker. */
export const firmPeople = (tenantId: string) => query<{ id: string; name: string }>(`select id, coalesce(display_name, email) as name from app_user where tenant_id = $1 order by 2`, [tenantId]);
