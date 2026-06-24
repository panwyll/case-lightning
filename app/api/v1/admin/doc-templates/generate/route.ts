/**
 * POST /api/v1/admin/doc-templates/generate   (multipart form)
 *   name, instructions?, file?   (file = an existing .docx/.txt to templatise)
 * Generate a .docx document template — either from a natural-language description, or
 * by turning an uploaded existing document into a template — and store it like an
 * uploaded one. ADMIN only. The model only decides content; the template is built +
 * sanitised server-side. AI [[blocks]] are only permitted on premium plans.
 */
import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { queryOne } from '@/lib/server/db';
import { isPremiumTenant } from '@/lib/server/plan';
import { generateDocTemplate } from '@/lib/server/doc-templates';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('ai');
    const user = await requireRole(['ADMIN']);

    const form = await req.formData();
    const name = (form.get('name') as string | null)?.trim() ?? '';
    const instructions = ((form.get('instructions') as string | null) ?? '').trim().slice(0, 4000);
    const file = form.get('file') as File | null;

    if (!name) return fail(bad('Give the template a name.'));
    if (!file && instructions.length < 10) {
      return fail(bad('Describe the document, or upload an existing one to turn into a template.'));
    }

    let source: { fileName: string; bytes: Buffer } | undefined;
    if (file) {
      if (!/\.(docx|txt)$/i.test(file.name)) {
        return fail(bad('To templatise an existing document, upload a Word (.docx) or text (.txt) file.'));
      }
      if (file.size > 10 * 1024 * 1024) return fail(bad('File too large (max 10 MB).'));
      source = { fileName: file.name, bytes: Buffer.from(await file.arrayBuffer()) };
    }

    const allowAiBlocks = await isPremiumTenant(user.tenantId);
    const { content, fileName, hasLlmPrompts, description } = await generateDocTemplate(
      user,
      name,
      instructions,
      allowAiBlocks,
      source
    );

    const row = await queryOne<{ id: string }>(
      `insert into doc_template
         (tenant_id, name, description, file_name, file_content, file_size_bytes, has_llm_prompts, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning id`,
      [user.tenantId, name, description || null, fileName, content, content.length, hasLlmPrompts, user.userId]
    );

    return ok({ id: row!.id, name, fileName, hasLlmPrompts, description, fromDocument: Boolean(source) });
  } catch (error) {
    return fail(error);
  }
}
