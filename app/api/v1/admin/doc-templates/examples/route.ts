/**
 * Seed example document templates into the tenant's library.
 * POST /api/v1/admin/doc-templates/examples
 */
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';
import { EXAMPLE_TEMPLATES, createMinimalDocx } from '@/lib/server/doc-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);

    const inserted: string[] = [];
    for (const tpl of EXAMPLE_TEMPLATES) {
      const content = createMinimalDocx(tpl.paragraphs);
      await query(
        `insert into doc_template
           (tenant_id, name, description, file_name, file_content, file_size_bytes, has_llm_prompts, sort_order, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict do nothing`,
        [
          user.tenantId,
          tpl.name,
          tpl.description,
          tpl.fileName,
          content,
          content.length,
          tpl.hasLlmPrompts,
          EXAMPLE_TEMPLATES.indexOf(tpl),
          user.userId,
        ]
      );
      inserted.push(tpl.name);
    }
    return ok({ inserted });
  } catch (error) {
    return fail(error);
  }
}
