/**
 * Per-matter Outlook Inbox subfolders — opt-in preference.
 *   GET  → { enabled, prompted }  (any signed-in user; the taskpane reads it to decide
 *          whether to show the one-time nudge on first historical import)
 *   POST → { enabled }            (ADMIN only; records the choice + marks prompted)
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser, requireRole } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const row = await queryOne<{ mail_subfolders_enabled: boolean; mail_subfolders_prompted: boolean }>(
      `select mail_subfolders_enabled, mail_subfolders_prompted from policy_config where tenant_id = $1`,
      [user.tenantId]
    );
    return ok({ enabled: row?.mail_subfolders_enabled ?? false, prompted: row?.mail_subfolders_prompted ?? false });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await req.json());
    await queryOne(
      `insert into policy_config (tenant_id, mail_subfolders_enabled, mail_subfolders_prompted, updated_by)
       values ($1,$2,true,$3)
       on conflict (tenant_id) do update set
         mail_subfolders_enabled = excluded.mail_subfolders_enabled,
         mail_subfolders_prompted = true,
         updated_by = excluded.updated_by,
         updated_at = now()
       returning tenant_id`,
      [user.tenantId, enabled, user.userId]
    );
    return ok({ enabled, prompted: true });
  } catch (error) {
    return fail(error);
  }
}
