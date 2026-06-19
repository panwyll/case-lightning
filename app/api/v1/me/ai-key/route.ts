import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { encryptSecret } from '@/lib/server/crypto';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const row = await queryOne<{ ai_key_updated_at: string | null; ai_api_key_enc: string | null }>(
      `select ai_api_key_enc, ai_key_updated_at from app_user where id = $1`,
      [user.userId]
    );
    return ok({ connected: Boolean(row?.ai_api_key_enc), updatedAt: row?.ai_key_updated_at ?? null });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { apiKey } = z.object({ apiKey: z.string().min(20) }).parse(await req.json());
    await query(
      `update app_user set ai_api_key_enc = $1, ai_key_updated_at = now() where id = $2 and tenant_id = $3`,
      [encryptSecret(apiKey.trim()), user.userId, user.tenantId]
    );
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'AI_KEY_SET', actionStatus: 'SUCCESS' });
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    await query(
      `update app_user set ai_api_key_enc = null, ai_key_updated_at = null where id = $1 and tenant_id = $2`,
      [user.userId, user.tenantId]
    );
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'AI_KEY_REMOVED', actionStatus: 'SUCCESS' });
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
