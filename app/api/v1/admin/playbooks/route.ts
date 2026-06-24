import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { listPlaybooks, indexPlaybook } from '@/lib/server/playbooks';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Step = z.object({ type: z.enum(['CREATE_MATTER', 'GENERATE_DOCS', 'CREATE_TASK', 'DRAFT_REPLY']), config: z.record(z.any()).default({}) });

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    return ok({ playbooks: await listPlaybooks(user.tenantId) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const body = z
      .object({ name: z.string().min(1), description: z.string().optional(), steps: z.array(Step).default([]) })
      .parse(await req.json());

    const row = await queryOne<{ id: string }>(
      `insert into playbook (tenant_id, name, description, steps, created_by)
       values ($1,$2,$3,$4::jsonb,$5) returning id`,
      [user.tenantId, body.name, body.description ?? null, JSON.stringify(body.steps), user.userId]
    );
    await indexPlaybook(user.tenantId, row!.id, body.name, body.description ?? null);
    return ok({ id: row!.id });
  } catch (error) {
    return fail(error);
  }
}
