import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { query } from '@/lib/server/db';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { listLenders } from '@/lib/server/engine/lender-directory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The firm's lenders and their requirements, for filling in a form (any user; editing stays with admins). */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    return ok({ lenders: await listLenders(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}

/** A lender added from a form (New Case): joins the directory by name only, never overwriting one already there. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { lenderName } = z.object({ lenderName: z.string().trim().min(2).max(120) }).parse(await req.json());
    await query(`insert into lender_profile (tenant_id, lender_name, updated_by) values ($1, $2, $3) on conflict (tenant_id, lower(lender_name)) do nothing`, [user.tenantId, lenderName, user.userId]);
    return ok({ lenderName });
  } catch (error) {
    return fail(error);
  }
}
