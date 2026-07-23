import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { createInvite, listInvites, revokeInvite } from '@/lib/server/invites';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    return ok({ invites: await listInvites(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}

/** Invite a colleague by email and send them a sign-in link. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const body = z.object({ email: z.string().email(), role: z.enum(['ADMIN', 'CONVEYANCER', 'ASSISTANT']).optional() }).parse(await req.json());
    const firm = await queryOne<{ name: string | null }>(`select name from tenant where id = $1`, [user.tenantId]);
    const invite = await createInvite(user, body.email, body.role ?? 'CONVEYANCER', firm?.name || 'our firm');
    return ok({ invite });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const id = z.string().uuid().parse(req.nextUrl.searchParams.get('id'));
    await revokeInvite(user.tenantId, id);
    return ok({ revoked: true });
  } catch (error) {
    return fail(error);
  }
}
