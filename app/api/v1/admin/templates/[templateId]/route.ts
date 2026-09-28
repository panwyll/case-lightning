import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { rowToSafeTemplate, uniqueName } from '@/lib/server/text';
import { ok, fail } from '@/lib/server/http';

import { messageInfo } from '@/lib/server/engine/messages';

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

    // An Engine template is the wording of a message the engine sends: the firm may rewrite
    // it, but not rename, recategorise or retire it, and every placeholder the send needs must stay.
    const existing = await queryOne<{ name: string; category: string; subject_template: string | null; body_template: string }>(`select name, category, subject_template, body_template from template where id = $1 and tenant_id = $2`, [templateId, user.tenantId]);
    if (existing?.category === 'Engine') {
      if ((body.name !== undefined && body.name !== existing.name) || (body.category !== undefined && body.category !== 'Engine') || body.isActive === false) {
        return fail(Object.assign(new Error('This message is sent by the engine. Change its wording, not its name; it cannot be archived.'), { status: 400 }));
      }
      const info = messageInfo()[existing.name];
      if (info && (body.bodyTemplate !== undefined || body.subjectTemplate !== undefined)) {
        const text = `${body.subjectTemplate ?? existing.subject_template ?? ''}\n${body.bodyTemplate ?? existing.body_template}`;
        const missing = info.requires.filter((k) => !text.includes(`{{${k}}}`));
        if (missing.length) return fail(Object.assign(new Error(`The engine fills ${missing.map((k) => `{{${k}}}`).join(', ')} when it sends this; keep ${missing.length === 1 ? 'it' : 'them'} in the text.`), { status: 400 }));
      }
    }

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
        `update template set attach_doc_template_ids = $1::uuid[], updated_at = case when updated_at = created_at then created_at else now() end where id = $2 and tenant_id = $3`,
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
