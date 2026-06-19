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
    const documents = await query(
      `select id, file_name, web_url, storage_path, mime_type, created_at
       from document where matter_id = $1 and tenant_id = $2 order by created_at desc`,
      [matterId, user.tenantId]
    );
    return ok({ documents });
  } catch (error) {
    return fail(error);
  }
}
