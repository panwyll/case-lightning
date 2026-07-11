import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ensureDefaultStages, listStages, saveStage, saveStageOrder, deleteStage } from '@/lib/server/stages';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    await ensureDefaultStages(user.tenantId);
    return ok({ stages: await listStages(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const body = await req.json();
    // Reorder: { order: [{id, sortOrder}] }. Otherwise a single create/update.
    if (Array.isArray(body?.order)) {
      const order = z.array(z.object({ id: z.string().uuid(), sortOrder: z.number().int() })).parse(body.order);
      await saveStageOrder(user, order);
      return ok({ ok: true });
    }
    const input = z.object({ id: z.string().uuid().nullable().optional(), name: z.string().min(1).max(40), sortOrder: z.number().int().optional(), active: z.boolean().optional() }).parse(body);
    return ok({ stage: await saveStage(user, input) });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const id = z.string().uuid().parse(req.nextUrl.searchParams.get('id'));
    await deleteStage(user, id);
    return ok({ deleted: true });
  } catch (error) {
    return fail(error);
  }
}
