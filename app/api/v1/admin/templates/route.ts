import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { upsertChunks } from '@/lib/server/ai';
import { rowToSafeTemplate } from '@/lib/server/text';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const rows = await query<any>(`select * from template where tenant_id = $1 order by updated_at desc`, [
      user.tenantId,
    ]);
    // Document templates a firm can attach to an email template.
    const docTemplates = await query<{ id: string; name: string }>(
      `select id, name from doc_template where tenant_id = $1 order by sort_order, created_at`,
      [user.tenantId]
    ).catch(() => []);
    return ok({ templates: rows.map(rowToSafeTemplate), docTemplates });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const body = z
      .object({
        name: z.string().min(1),
        category: z.string().min(1),
        subjectTemplate: z.string().optional(),
        bodyTemplate: z.string().min(1),
        styleTag: z.string().default('NEUTRAL'),
        policyTags: z.array(z.string()).default([]),
      })
      .parse(await req.json());

    const row = await queryOne<any>(
      `insert into template (tenant_id, name, category, subject_template, body_template, style_tag, policy_tags, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [
        user.tenantId,
        body.name,
        body.category,
        body.subjectTemplate ?? null,
        body.bodyTemplate,
        body.styleTag,
        body.policyTags,
        user.userId,
      ]
    );

    await upsertChunks({
      tenantId: user.tenantId,
      sourceKind: 'TEMPLATE',
      sourceId: row!.id,
      text: `${body.name}\n${body.subjectTemplate ?? ''}\n${body.bodyTemplate}`,
      metadata: { category: body.category, styleTag: body.styleTag },
    }).catch(() => {});

    return ok({ template: rowToSafeTemplate(row) });
  } catch (error) {
    return fail(error);
  }
}
