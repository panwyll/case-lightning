import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';
import { getMessageForCheck } from '@/lib/server/graph';
import { latestScan } from '@/lib/server/workload/scan';
import { FILTERED_LABEL, IN_SPEC, type Filtered, type InCategory } from '@/lib/server/workload/taxonomy';
import { EPA_SPEC, fromEmail } from '@/lib/server/epa/taxonomy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE = 50;

/**
 * What your own latest scan read, a page at a time: when, which way, who with, and the label it was given. Read-only, to see
 * that the scan did what it says; nobody is asked to mark anything. The subject is read live from your mailbox (the scan
 * keeps no text), and only ever your own.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const scan = await latestScan(user.userId);
    if (!scan) return ok({ total: 0, page: 1, pages: 0, emails: [] });
    const page = Math.max(1, Number(req.nextUrl.searchParams.get('page')) || 1);
    const [{ total }] = await query<{ total: number }>(`select count(*)::int as total from workload_email where scan_id = $1`, [scan.id]);
    const rows = await query<{ graph_message_id: string; direction: 'out' | 'in'; sent_at: Date; recipient_roles: string[] | null; filtered: Filtered | null; category: string | null }>(
      `select graph_message_id, direction, sent_at, recipient_roles, filtered, category from workload_email where scan_id = $1 order by sent_at desc limit $2 offset $3`,
      [scan.id, PAGE, (page - 1) * PAGE]
    );
    const emails = [];
    // Five at a time against Graph.
    for (let i = 0; i < rows.length; i += 5) {
      const chunk = await Promise.all(rows.slice(i, i + 5).map(async (r) => {
        const m = await getMessageForCheck(user.userId, r.graph_message_id).catch(() => null);
        const label = r.filtered ? `Set Aside: ${FILTERED_LABEL[r.filtered] ?? r.filtered}`
          : !r.category ? 'Not Classified'
          : r.direction === 'out' ? (r.category === 'internal' ? 'To Colleagues (Not Counted)' : r.category === 'non_case' ? 'Not Case Work (Not Counted)' : EPA_SPEC[fromEmail(r.category, r.recipient_roles)].label)
          : `Received: ${IN_SPEC[r.category as InCategory]?.label ?? r.category}`;
        return { at: r.sent_at.toISOString(), direction: r.direction, roles: r.recipient_roles ?? [], label, subject: m?.subject ?? null, people: m?.people ?? null, webLink: m?.webLink ?? null };
      }));
      emails.push(...chunk);
    }
    return ok({ total, page, pages: Math.ceil(total / PAGE), emails });
  } catch (e) {
    return fail(e);
  }
}
