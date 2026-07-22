import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { getWorkflow, saveTemplate, deleteTemplate, ensureDefaultWorkflow } from '@/lib/server/workflow';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The whole workflow (task templates + DAG edges) plus the firm's members for the assignee picker. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    await ensureDefaultWorkflow(user.tenantId); // seed the standard conveyancing flow on first open
    const { templates, edges, emailTemplates } = await getWorkflow(user.tenantId);
    const users = await query(
      `select id, coalesce(display_name, email) as name, role from app_user where tenant_id = $1 order by created_at asc`,
      [user.tenantId]
    );
    return ok({ templates, edges, users, emailTemplates });
  } catch (error) {
    return fail(error);
  }
}

/** Create or update a task template (a node on the canvas). */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const body = z
      .object({
        id: z.string().uuid().nullable().optional(),
        stage: z.string().min(1).max(40), // any of the firm's configured stage keys
        detail: z.string().min(1).max(500),
        type: z.string().optional(),
        nodeKind: z.enum(['TASK', 'EMAIL']).optional(),
        emailTemplateId: z.string().uuid().nullable().optional(),
        sendMode: z.enum(['DRAFT', 'SEND']).nullable().optional(),
        assigneeKind: z.enum(['ROLE', 'USER']),
        assigneeRole: z.enum(['OWNER', 'CONVEYANCER', 'ASSISTANT', 'ADMIN']).nullable().optional(),
        assigneeUserId: z.string().uuid().nullable().optional(),
        dueOffsetDays: z.number().int().min(0).max(365).nullable().optional(),
        posX: z.number().optional(),
        posY: z.number().optional(),
        sortOrder: z.number().int().optional(),
        active: z.boolean().optional(),
      })
      .parse(await req.json());
    const template = await saveTemplate(user, body);
    return ok({ template });
  } catch (error) {
    return fail(error);
  }
}

/** Delete a task template (and its edges cascade). */
export async function DELETE(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const id = z.string().uuid().parse(req.nextUrl.searchParams.get('id'));
    await deleteTemplate(user, id);
    return ok({ deleted: true });
  } catch (error) {
    return fail(error);
  }
}
