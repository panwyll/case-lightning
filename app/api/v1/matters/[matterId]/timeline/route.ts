import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query } from '@/lib/server/db';
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
    const timeline = await query(
      `select id, event_at, event_type, title, details, source_ref, created_at
       from matter_timeline_event where matter_id = $1 and tenant_id = $2
       order by coalesce(event_at, created_at) desc`,
      [matterId, user.tenantId]
    );
    return ok({ timeline });
  } catch (error) {
    return fail(error);
  }
}
