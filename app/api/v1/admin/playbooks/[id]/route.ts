import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { indexPlaybook } from '@/lib/server/playbooks';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const Step = z.object({ type: z.enum(['CREATE_MATTER', 'GENERATE_DOCS', 'CREATE_TASK', 'DRAFT_REPLY']), config: z.record(z.any()).default({}) });

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);
    const body = z
      .object({
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        steps: z.array(Step).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(await req.json());

    const row = await queryOne<{ name: string; description: string | null }>(
      `update playbook set
         name = coalesce($1, name),
         description = case when $2::boolean then $3 else description end,
         steps = coalesce($4::jsonb, steps),
         enabled = coalesce($5, enabled),
         updated_at = now()
       where id = $6 and tenant_id = $7
       returning name, description`,
      [
        body.name ?? null,
        body.description !== undefined,
        body.description ?? null,
        body.steps ? JSON.stringify(body.steps) : null,
        body.enabled ?? null,
        id,
        user.tenantId,
      ]
    );
    if (row) await indexPlaybook(user.tenantId, id, row.name, row.description);
    return ok({ updated: true });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);
    await query(`delete from playbook where id = $1 and tenant_id = $2`, [id, user.tenantId]);
    return ok({ deleted: true });
  } catch (error) {
    return fail(error);
  }
}
