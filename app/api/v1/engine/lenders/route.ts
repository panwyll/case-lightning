import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { writeAudit } from '@/lib/server/audit';
import { deleteLender, listLenders, upsertLender } from '@/lib/server/engine/lender-directory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The firm's lender directory (Part 2 requirements the engine applies). Admins only. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    return ok({ lenders: await listLenders(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const body = z.object({ lenderName: z.string().min(2).max(120), minUnexpiredYears: z.number().int().min(0).max(999).nullish(), maxSearchAgeMonths: z.number().int().min(1).max(24).nullish(), acceptsNonFamilyGift: z.boolean().nullish(), requiresEws1: z.boolean().nullish(), acceptsDigitalDeed: z.boolean().nullish(), note: z.string().max(2000).nullish() }).parse(await req.json());
    const lender = await upsertLender(user.tenantId, user.userId, { lenderName: body.lenderName, minUnexpiredYears: body.minUnexpiredYears ?? null, maxSearchAgeMonths: body.maxSearchAgeMonths ?? null, acceptsNonFamilyGift: body.acceptsNonFamilyGift ?? null, requiresEws1: body.requiresEws1 ?? null, acceptsDigitalDeed: body.acceptsDigitalDeed ?? null, note: body.note?.trim() || null });
    await writeAudit({ tenantId: user.tenantId, matterId: null, actorUserId: user.userId, actionType: 'LENDER_PROFILE_SAVED', actionStatus: 'SUCCESS', payload: { lenderName: lender.lenderName } }).catch(() => {});
    return ok({ lender });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { id } = z.object({ id: z.string().uuid() }).parse(await req.json());
    await deleteLender(user.tenantId, id);
    return ok({ deleted: id });
  } catch (error) {
    return fail(error);
  }
}
