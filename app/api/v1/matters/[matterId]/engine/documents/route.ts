import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { query } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Every document on the case, newest first — what a completion sheet picks from. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const documents = await query<{ id: string; file_name: string | null; doc_type: string | null; web_url: string | null; created_at: string }>(
      `select id, file_name, doc_type, web_url, created_at from document where tenant_id = $1 and matter_id = $2 and superseded_at is null order by created_at desc limit 300`,
      [user.tenantId, matterId]
    );
    return ok({ documents: documents.map((d) => ({ id: d.id, fileName: d.file_name, docType: d.doc_type, webUrl: d.web_url, createdAt: d.created_at })) });
  } catch (error) {
    return fail(error);
  }
}
