import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query, queryOne } from '@/lib/server/db';
import { baselineScan, cancelScan, estimatesOf, firmSettings, latestScan, reportFor, startScan, type ScanRow } from '@/lib/server/workload/scan';
import { handoverSince } from '@/lib/server/workload/handover';
import { IN_SPEC, OUT_SPEC, TIER_LABEL, FILTERED_LABEL } from '@/lib/server/workload/taxonomy';
import type { SessionUser } from '@/lib/server/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Scans a person may start in 30 days: each costs model calls on up to 5,000 messages. */
const SCANS_PER_MONTH = 4;

const scanView = (s: ScanRow | null) => s && { id: s.id, status: s.status, since: s.since, until: s.until, messagesRead: s.messages_read, classified: s.classified, maxMessages: s.max_messages, model: s.model, promptVersion: s.prompt_version, error: s.error, createdAt: s.created_at, completedAt: s.completed_at };

/** Whose report: your own, or (an admin) anyone's at the firm. */
async function whose(user: SessionUser, person: string | null): Promise<{ userId: string; name: string }> {
  if (!person || person === user.userId) return { userId: user.userId, name: user.displayName ?? user.email };
  if (user.role !== 'ADMIN') throw Object.assign(new Error('Only an admin can see another person’s baseline.'), { status: 403 });
  const p = await queryOne<{ id: string; name: string }>(`select id, coalesce(display_name, email) as name from app_user where id = $1 and tenant_id = $2`, [person, user.tenantId]);
  if (!p) throw Object.assign(new Error('No such person at the firm.'), { status: 404 });
  return { userId: p.id, name: p.name };
}

/** The baseline for one person: the running scan, the baseline report, a later re-scan to compare, and what CONVEYi has sent since. */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const who = await whose(user, req.nextUrl.searchParams.get('person'));
    const [settings, estimates, latest, base] = await Promise.all([firmSettings(user.tenantId), estimatesOf(who.userId), latestScan(who.userId), baselineScan(who.userId)]);
    const baseline = base ? await reportFor(base, settings, estimates) : null;
    const later = latest && base && latest.id !== base.id && (latest.status === 'CHECKING' || latest.status === 'COMPLETE') ? await reportFor(latest, settings, estimates) : null;
    const handover = base && baseline ? await handoverSince(user.tenantId, who.userId, base.until, baseline).catch(() => null) : null;
    // An admin sees each person's headline beside their own.
    const people = user.role === 'ADMIN'
      ? await Promise.all((await query<{ id: string; name: string }>(`select id, coalesce(display_name, email) as name from app_user where tenant_id = $1 order by 2`, [user.tenantId])).map(async (p) => {
          const b = await baselineScan(p.id);
          if (!b) return { id: p.id, name: p.name, scanned: false, freedHoursPerWeek: null as number | null, emails: null as number | null };
          const r = await reportFor(b, settings, await estimatesOf(p.id));
          return { id: p.id, name: p.name, scanned: true, freedHoursPerWeek: r.freed.hoursPerWeek, emails: r.read.total };
        }))
      : null;
    return ok({
      me: user.userId,
      person: who,
      isOwn: who.userId === user.userId,
      admin: user.role === 'ADMIN',
      scan: scanView(latest),
      baselineScan: scanView(base),
      baseline,
      later: later && { scan: scanView(latest), report: later },
      handover,
      estimates,
      people,
      spec: { out: OUT_SPEC, in: IN_SPEC, tiers: TIER_LABEL, filtered: FILTERED_LABEL },
    });
  } catch (error) {
    return fail(needsMigration(error));
  }
}

/** Before migration 124 the tables are not there: say so, not the database's words. */
const needsMigration = (e: unknown) => (/relation "workload_|column .* does not exist/.test(String((e as Error)?.message)) ? Object.assign(new Error('The baseline needs migration 124.'), { status: 503 }) : e);

/** Start a scan of your own mailbox: the last N weeks, or the weeks since go-live (a re-scan). */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    assertFeature('ai');
    const user = await requireUser();
    const body = z.object({ weeks: z.number().int().min(2).max(52).optional(), sinceBaseline: z.boolean().optional() }).parse(await req.json().catch(() => ({})));
    const recent = await queryOne<{ n: number }>(`select count(*)::int as n from workload_scan where user_id = $1 and created_at > now() - interval '30 days'`, [user.userId]);
    if ((recent?.n ?? 0) >= SCANS_PER_MONTH) throw Object.assign(new Error(`${SCANS_PER_MONTH} scans a month is the most; the next can start when the oldest is a month old.`), { status: 429 });
    let since: string | undefined;
    if (body.sinceBaseline) {
      const base = await baselineScan(user.userId);
      if (!base) throw Object.assign(new Error('Scan the weeks before CONVEYi first: that is the baseline.'), { status: 400 });
      since = base.until;
    }
    const scan = await startScan(user, { weeks: body.weeks, since });
    return ok({ scan: scanView(scan) });
  } catch (error) {
    return fail(needsMigration(error));
  }
}

export async function DELETE() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    await cancelScan(user.userId);
    return ok({ cancelled: true });
  } catch (error) {
    return fail(error);
  }
}
