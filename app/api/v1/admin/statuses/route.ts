import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ensureDefaultStatuses, listStatuses, saveStatus, deleteStatus } from '@/lib/server/statuses';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    await ensureDefaultStatuses(user.tenantId);
    return ok({ statuses: await listStatuses(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const body = z
      .object({
        id: z.string().uuid().nullable().optional(),
        name: z.string().min(1).max(40),
        kind: z.enum(['OPEN', 'IN_PROGRESS', 'DONE']),
        color: z.string().max(20).nullable().optional(),
        sortOrder: z.number().int().optional(),
        active: z.boolean().optional(),
      })
      .parse(await req.json());
    return ok({ status: await saveStatus(user, body) });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const id = z.string().uuid().parse(req.nextUrl.searchParams.get('id'));
    await deleteStatus(user, id);
    return ok({ deleted: true });
  } catch (error) {
    return fail(error);
  }
}
