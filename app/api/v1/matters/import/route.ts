import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { assertEntitled } from '@/lib/server/plan';
import { previewImport, runImport, MAX_IMPORT_ROWS } from '@/lib/server/matter-import';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A CSV of a few hundred matters is well under this; the cap is here so a stray
// upload can't push a huge body through the JSON parser.
const MAX_CSV_BYTES = 2_000_000;

// Matters are provisioned one at a time (each creates a OneDrive folder and an Excel
// tracker), so a big import is drained across several calls rather than risking the
// serverless timeout. The client loops until `remaining` is 0.
const CREATE_PER_CALL = 15;

const Body = z.object({
  csv: z.string().max(MAX_CSV_BYTES),
  /** Preview only — parse, map and report, create nothing. */
  dryRun: z.boolean().optional(),
  /** Skip rows already handled by an earlier call in this run. */
  offset: z.number().int().min(0).optional(),
});

/**
 * Import a firm's existing matters from a case management system CSV export.
 *
 * Admin-only and entitlement-gated: it provisions real matters with real M365
 * surfaces. Two phases so nothing is created by surprise — POST with dryRun to see
 * the parsed mapping and exactly which rows would be created, then POST again to
 * commit.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireRole(['ADMIN']);
    await assertEntitled(user.tenantId);
    const body = Body.parse(await req.json());

    const preview = await previewImport(user, body.csv);

    if (body.dryRun) {
      return ok({
        ...preview,
        maxRows: MAX_IMPORT_ROWS,
        // Nothing recognisable is worth saying plainly — usually the wrong file.
        usable: Object.keys(preview.mapping).length > 0,
      });
    }

    const importable = preview.rows.filter((r) => !r.skip);
    const offset = body.offset ?? 0;
    const slice = importable.slice(offset, offset + CREATE_PER_CALL);
    const outcome = await runImport(user, slice);
    const done = offset + slice.length;

    await writeAudit({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actionType: 'MATTERS_IMPORTED',
      // Some rows failing doesn't fail the import — the count is in the payload.
      actionStatus: outcome.created ? 'SUCCESS' : 'FAILED',
      payload: { created: outcome.created, failed: outcome.failed.length, offset, total: importable.length },
    }).catch(() => {});

    return ok({
      created: outcome.created,
      failed: outcome.failed,
      done,
      total: importable.length,
      remaining: Math.max(0, importable.length - done),
    });
  } catch (error) {
    return fail(error);
  }
}
