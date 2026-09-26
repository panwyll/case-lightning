import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { upsertChunks } from '@/lib/server/ai';
import { rowToSafeTemplate, uniqueName } from '@/lib/server/text';
import { ok, fail } from '@/lib/server/http';

import { ACKS, CHASES, CLIENT_UPDATES, PARTY_NOTICES } from '@/lib/server/comms/templates';
import { messageInfo } from '@/lib/server/engine/messages';

/** Every message the engine can send, as a row the firm can rewrite. Keyed by the template key; the engine reads the firm's version when one exists. */
async function ensureEngineTemplates(tenantId: string, userId: string): Promise<void> {
  const have = new Set((await query<{ name: string }>(`select name from template where tenant_id = $1 and category = 'Engine'`, [tenantId]).catch(() => [])).map((r) => r.name));
  const all = [...Object.values(CLIENT_UPDATES), ...Object.values(CHASES), ...Object.values(PARTY_NOTICES), ...Object.values(ACKS)];
  for (const t of all) {
    if (have.has(t.key)) continue;
    await query(`insert into template (tenant_id, name, category, subject_template, body_template, style_tag, policy_tags, created_by) values ($1, $2, 'Engine', $3, $4, 'NEUTRAL', '{}', $5) on conflict do nothing`, [tenantId, t.key, t.subject, t.body, userId]).catch(() => {});
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    await ensureEngineTemplates(user.tenantId, user.userId);
    const rows = await query<any>(`select * from template where tenant_id = $1 order by updated_at desc`, [
      user.tenantId,
    ]);
    // Document templates a firm can attach to an email template.
    const docTemplates = await query<{ id: string; name: string }>(
      `select id, name from doc_template where tenant_id = $1 order by sort_order, created_at`,
      [user.tenantId]
    ).catch(() => []);
    return ok({ templates: rows.map(rowToSafeTemplate), docTemplates, engine: messageInfo() });
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

    // Keep template names unique within the firm (macOS-style: "name", "name_1", "name_2"…).
    const taken = (await query<{ name: string }>(`select name from template where tenant_id = $1 and is_active = true`, [user.tenantId])).map((r) => r.name);
    const name = uniqueName(taken, body.name);

    const row = await queryOne<any>(
      `insert into template (tenant_id, name, category, subject_template, body_template, style_tag, policy_tags, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [
        user.tenantId,
        name,
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
      text: `${name}\n${body.subjectTemplate ?? ''}\n${body.bodyTemplate}`,
      metadata: { category: body.category, styleTag: body.styleTag },
    }).catch(() => {});

    return ok({ template: rowToSafeTemplate(row) });
  } catch (error) {
    return fail(error);
  }
}
