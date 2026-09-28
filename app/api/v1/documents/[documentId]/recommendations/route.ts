import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { queryOne } from '@/lib/server/db';
import { engine } from '@/lib/server/engine/adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Send Recommendations: the survey's letter and enquiries, proposed afresh (pending ones replaced). */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ documentId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(await params);
    const row = await queryOne<{ matter_id: string }>(`select matter_id from document where id = $1 and tenant_id = $2`, [documentId, user.tenantId]);
    if (!row) return fail(Object.assign(new Error('Document not found.'), { status: 404 }));
    await assertMatterAccess(user, row.matter_id);
    await engine().sendSurveyRecommendations(user.tenantId, row.matter_id, documentId);
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
