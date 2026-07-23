import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { rowToSafeTemplate } from '@/lib/server/text';
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
        attachDocTemplateId: z.string().uuid().nullable().optional(),
        isActive: z.boolean().optional(),
      })
      .parse(await req.json());

    // Attachment set separately so it can be cleared to null (coalesce can't), and guarded so
    // a deploy before migration 054 still saves the rest of the template.
    if (body.attachDocTemplateId !== undefined) {
      await queryOne(
        `update template set attach_doc_template_id = $1, updated_at = now() where id = $2 and tenant_id = $3`,
        [body.attachDocTemplateId, templateId, user.tenantId]
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
        body.name ?? null,
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
