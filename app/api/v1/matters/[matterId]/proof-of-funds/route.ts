import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { listRequests } from '@/lib/server/engine/pof-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The proof-of-funds rounds on a matter (the link itself is never returned: the token is stored hashed). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const rows = await listRequests(user.tenantId, matterId);
    return ok({
      requests: rows.map((r) => ({ id: r.id, status: r.status, requestedAt: new Date(r.requested_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString(), submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null, followUpOf: r.follow_up_of, noteToClient: r.note_to_client, documentId: r.document_id, sources: r.submission?.sources.length ?? null })),
    });
  } catch (error) {
    return fail(error);
  }
}
