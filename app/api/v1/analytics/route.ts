import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { loadAnalyticsInput } from '@/lib/server/analytics/load';
import { computeAnalytics } from '@/lib/server/analytics/kpis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The firm's analytics (lib/server/analytics). Everyone sees the firm's figures and their own; an admin
 * sees each person's too. People are listed by name, never ranked (docs/analytics.md).
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const q = z.object({ person: z.string().uuid().optional(), side: z.enum(['purchase', 'sale', 'remortgage', 'transfer']).optional() }).parse(Object.fromEntries(req.nextUrl.searchParams));
    const admin = user.role === 'ADMIN';
    if (q.person && !admin && q.person !== user.userId) throw Object.assign(new Error('You can see your own figures and the firm\'s.'), { status: 403 });
    const input = await loadAnalyticsInput(user.tenantId);
    const report = computeAnalytics(input, { personId: q.person ?? null, side: q.side ?? null });
    if (!admin) {
      report.people = report.people.filter((p) => p.id === user.userId);
      // Someone who is not an admin sees their own bars beside the team's line, not their colleagues'.
      const keep = report.team.people.map((p, i) => (p.id === user.userId ? i : -1)).filter((i) => i >= 0);
      report.team.people = keep.map((i) => report.team.people[i]);
      for (const m of Object.values(report.team.metrics)) m.perPerson = keep.map((i) => m.perPerson[i]);
    }
    const people = admin ? input.people.filter((p) => input.cases.some((c) => c.handlerId === p.id)) : input.people.filter((p) => p.id === user.userId);
    return ok({ report, people: people.sort((a, b) => a.name.localeCompare(b.name)), me: user.userId, admin });
  } catch (error) {
    return fail(error);
  }
}
