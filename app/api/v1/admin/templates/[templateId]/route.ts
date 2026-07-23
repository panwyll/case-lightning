import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { rowToSafeTemplate, uniqueName } from '@/lib/server/text';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ templateId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { templateId } = z.object({ templateId: z.string().uuid() }).parse(await params);
    const body = z
      .object({
        name: z.string().optional(),
        category: z.string().optional(),
        subjectTemplate: z.string().optional(),
        bodyTemplate: z.string().optional(),
        styleTag: z.string().optional(),
        policyTags: z.array(z.string()).optional(),
        attachDocTemplateIds: z.array(z.string().uuid()).max(20).optional(),
        isActive: z.boolean().optional(),
      })
      .parse(await req.json());

    // Keep names unique within the firm (macOS-style suffix), ignoring this template's own row.
    let name = body.name;
    if (name !== undefined) {
      const taken = (await query<{ name: string }>(`select name from template where tenant_id = $1 and is_active = true and id <> $2`, [user.tenantId, templateId])).map((r) => r.name);
      name = uniqueName(taken, name);
    }

    // Attachments set separately (an array of doc templates), guarded so a deploy before
    // migration 055 still saves the rest of the template.
    if (body.attachDocTemplateIds !== undefined) {
      await queryOne(
        `update template set attach_doc_template_ids = $1::uuid[], updated_at = now() where id = $2 and tenant_id = $3`,
        [body.attachDocTemplateIds, templateId, user.tenantId]
      ).catch(() => {});
    }

    const row = await queryOne<any>(
      `update template set
         name = coalesce($1, name),
         category = coalesce($2, category),
         subject_template = coalesce($3, subject_template),
         body_template = coalesce($4, body_template),
         style_tag = coalesce($5, style_tag),
         policy_tags = coalesce($6, policy_tags),
         is_active = coalesce($7, is_active),
         updated_at = now()
       where id = $8 and tenant_id = $9 returning *`,
      [
        name ?? null,
        body.category ?? null,
        body.subjectTemplate ?? null,
        body.bodyTemplate ?? null,
        body.styleTag ?? null,
        body.policyTags ?? null,
        body.isActive ?? null,
        templateId,
        user.tenantId,
      ]
    );
    if (!row) return fail(new Error('Template not found'));
    return ok({ template: rowToSafeTemplate(row) });
  } catch (error) {
    return fail(error);
  }
}
