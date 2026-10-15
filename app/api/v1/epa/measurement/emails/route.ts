import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';
import { latestScan } from '@/lib/server/workload/scan';
import { FILTERED_LABEL, IN_SPEC, type Filtered, type InCategory } from '@/lib/server/workload/taxonomy';
import { EPA_SPEC, fromEmail } from '@/lib/server/epa/taxonomy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE = 50;

/**
 * What your own latest scan read, a page at a time: when, which way, who with, and the label it was given. Read-only, to see
 * that the scan did what it says; nobody is asked to mark anything. All from what the scan kept: nothing is read again from
 * the mailbox. Only ever your own.
 */
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const scan = await latestScan(user.userId);
    if (!scan) return ok({ total: 0, page: 1, pages: 0, emails: [] });
    const page = Math.max(1, Number(req.nextUrl.searchParams.get('page')) || 1);
    // What it read from InTouch: each document or note the firm filed, newest first, with its case and the kind of work.
    if (req.nextUrl.searchParams.get('source') === 'intouch') {
      const items = [...(scan.intouch?.items ?? [])].sort((a, b) => b.at.localeCompare(a.at));
      const refs = scan.intouch?.refs ?? {};
      const slice = items.slice((page - 1) * PAGE, page * PAGE).map((i) => ({ at: i.at, caseRef: (i.caseId && refs[i.caseId]) || null, name: i.name ?? null, label: EPA_SPEC[i.kind as keyof typeof EPA_SPEC]?.label ?? i.kind }));
      return ok({ total: items.length, page, pages: Math.ceil(items.length / PAGE), items: slice });
    }
    const [{ total }] = await query<{ total: number }>(`select count(*)::int as total from workload_email where scan_id = $1`, [scan.id]);
    const rows = await query<{ graph_message_id: string; direction: 'out' | 'in'; sent_at: Date; recipient_roles: string[] | null; filtered: Filtered | null; category: string | null; subject: string | null; who: string | null }>(
      `select * from workload_email where scan_id = $1 order by sent_at desc limit $2 offset $3`,
      [scan.id, PAGE, (page - 1) * PAGE]
    );
    const emails = rows.map((r) => {
      const label = r.filtered ? `Set Aside: ${FILTERED_LABEL[r.filtered] ?? r.filtered}`
        : !r.category ? 'Not Classified'
        : r.direction === 'out' ? (r.category === 'internal' ? 'To Colleagues (Not Counted)' : r.category === 'non_case' ? 'Not Case Work (Not Counted)' : EPA_SPEC[fromEmail(r.category, r.recipient_roles)].label)
        : `Received: ${IN_SPEC[r.category as InCategory]?.label ?? r.category}`;
      // Outlook opens a message by its id (the shape of Graph's own webLink).
      const webLink = `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(r.graph_message_id)}&exvsurl=1&viewmodel=ReadMessageItem`;
      return { at: r.sent_at.toISOString(), direction: r.direction, roles: r.recipient_roles ?? [], label, subject: r.subject ?? null, people: r.who ?? null, webLink };
    });
    return ok({ total, page, pages: Math.ceil(total / PAGE), emails });
  } catch (e) {
    return fail(e);
  }
}
