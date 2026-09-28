import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { queryOne } from '@/lib/server/db';
import { tryUnlockDocument } from '@/lib/server/document-unlock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Unlock a password-protected file on a case. The password is used once and not kept; the unlocked copy is what the case reads from then on. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ documentId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(await params);
    const { password, from } = z.object({ password: z.string().min(1).max(200), from: z.enum(['documents', 'task']).optional() }).parse(await req.json());
    const row = await queryOne<{ matter_id: string }>(`select matter_id from document where id = $1 and tenant_id = $2`, [documentId, user.tenantId]);
    if (!row) return fail(Object.assign(new Error('Document not found.'), { status: 404 }));
    await assertMatterAccess(user, row.matter_id);
    const r = await tryUnlockDocument(user.tenantId, documentId, password, { userId: user.userId, how: from === 'task' ? 'password entered on the task' : 'password entered on the Documents tab' });
    if (!r.unlocked) return fail(Object.assign(new Error(r.reason ?? 'That password does not open the file.'), { status: 422 }));
    return ok({ unlocked: true });
  } catch (error) {
    return fail(error);
  }
}
