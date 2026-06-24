/**
 * POST /api/v1/admin/doc-templates/generate
 *   { name, instructions }
 * Generate a .docx document template from a natural-language description and store
 * it like an uploaded one. ADMIN only. The model only decides content; the template
 * is built + sanitised server-side (see generateDocTemplate). AI [[blocks]] are only
 * permitted on premium plans (they run at fill time).
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { isPremiumTenant } from '@/lib/server/plan';
import { generateDocTemplate } from '@/lib/server/doc-templates';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('ai');
    const user = await requireRole(['ADMIN']);
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        instructions: z.string().trim().min(10).max(4000),
      })
      .parse(await req.json());

    const allowAiBlocks = await isPremiumTenant(user.tenantId);
    const { content, fileName, hasLlmPrompts, description } = await generateDocTemplate(
      user,
      body.name,
      body.instructions,
      allowAiBlocks
    );

    const row = await queryOne<{ id: string }>(
      `insert into doc_template
         (tenant_id, name, description, file_name, file_content, file_size_bytes, has_llm_prompts, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning id`,
      [user.tenantId, body.name, description || null, fileName, content, content.length, hasLlmPrompts, user.userId]
    );

    return ok({ id: row!.id, name: body.name, fileName, hasLlmPrompts, description });
  } catch (error) {
    return fail(error);
  }
}
