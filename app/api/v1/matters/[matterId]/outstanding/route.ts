import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const summary = await queryOne<{ outstanding_items: unknown[] }>(
      `select outstanding_items from matter_summary where matter_id = $1 and tenant_id = $2`,
      [matterId, user.tenantId]
    );
    return ok({ outstanding: summary?.outstanding_items ?? [] });
  } catch (error) {
    return fail(error);
  }
}
