import { NextRequest } from 'next/server';
import PizZip from 'pizzip';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

import { DOC_USAGE, EXAMPLE_TEMPLATES, createMinimalDocx } from '@/lib/server/doc-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const rows = await query<{
      id: string;
      name: string;
      description: string | null;
      file_name: string;
      file_size_bytes: number;
      has_llm_prompts: boolean;
      sort_order: number;
      created_at: string;
    }>(
      `select id, name, description, file_name, file_size_bytes, has_llm_prompts, sort_order, created_at
       from doc_template where tenant_id = $1 order by sort_order, created_at`,
      [user.tenantId]
    );
    // Two first loads at once used to seed twice: fold any later copy of a standard template whose file is byte-identical to an earlier one.
    const dupes = await query<{ id: string }>(
      `select d.id from doc_template d where d.tenant_id = $1 and exists (select 1 from doc_template e where e.tenant_id = d.tenant_id and e.name = d.name and e.file_content = d.file_content and (e.created_at < d.created_at or (e.created_at = d.created_at and e.id < d.id)))`,
      [user.tenantId]
    );
    if (dupes.length) {
      await query(`delete from doc_template where tenant_id = $1 and id = any($2::uuid[])`, [user.tenantId, dupes.map((d) => d.id)]);
      return GET();
    }
    if (rows.length === 0) {
      // A new firm starts with the standard set; they replace any with their own. The insert is guarded so two first loads cannot seed twice.
      for (const tpl of EXAMPLE_TEMPLATES) {
        const content = createMinimalDocx(tpl.paragraphs);
        await query(`insert into doc_template (tenant_id, name, description, file_name, file_content, file_size_bytes, has_llm_prompts, sort_order, created_by) select $1,$2,$3,$4,$5,$6,$7,$8,$9 where not exists (select 1 from doc_template where tenant_id = $1 and name = $2)`, [user.tenantId, tpl.name, tpl.description, tpl.fileName, content, content.length, tpl.hasLlmPrompts, EXAMPLE_TEMPLATES.indexOf(tpl), user.userId]).catch(() => {});
      }
      return GET();
    }
    // A standard document added since the firm started (a sale's, a remortgage's…) joins their set.
    const have = new Set(rows.map((r: { name: string }) => r.name));
    const missing = EXAMPLE_TEMPLATES.filter((t) => !have.has(t.name));
    // Once per request: a failed insert must not loop.
    if (missing.length && !(globalThis as { __docSeedTried?: Set<string> }).__docSeedTried?.has(user.tenantId)) {
      ((globalThis as { __docSeedTried?: Set<string> }).__docSeedTried ??= new Set()).add(user.tenantId);
      for (const tpl of missing) {
        const content = createMinimalDocx(tpl.paragraphs);
        await query(`insert into doc_template (tenant_id, name, description, file_name, file_content, file_size_bytes, has_llm_prompts, sort_order, created_by) select $1,$2,$3,$4,$5,$6,$7,$8,$9 where not exists (select 1 from doc_template where tenant_id = $1 and name = $2)`, [user.tenantId, tpl.name, tpl.description, tpl.fileName, content, content.length, tpl.hasLlmPrompts, EXAMPLE_TEMPLATES.indexOf(tpl), user.userId]).catch(() => {});
      }
      return GET();
    }
    return ok({ templates: rows.map((r) => ({ ...r, usage: DOC_USAGE[r.name] ?? null })) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);

    const form = await req.formData();
    const file = form.get('file') as File | null;
    const name = (form.get('name') as string | null)?.trim();
    const description = (form.get('description') as string | null)?.trim() || null;

    if (!file) return fail(Object.assign(new Error('No file uploaded.'), { status: 400 }));
    if (!name) return fail(Object.assign(new Error('Template name is required.'), { status: 400 }));
    if (!/\.docx$/i.test(file.name)) {
      return fail(Object.assign(new Error('Only Word (.docx) files are supported.'), { status: 400 }));
    }
    if (file.size > 10 * 1024 * 1024) {
      return fail(Object.assign(new Error('File too large (max 10 MB).'), { status: 400 }));
    }

    const bytes = await file.arrayBuffer();
    const content = Buffer.from(bytes);

    // Verify it's a genuine .docx (a zip containing word/document.xml), not a
    // renamed PDF/other file — those would parse cleanly here but blow up at
    // fill time. PizZip throws on a non-zip; a missing main part means it isn't
    // a Word document.
    try {
      const zip = new PizZip(content);
      if (!zip.file('word/document.xml')) {
        return fail(Object.assign(new Error('That file isn’t a valid Word document.'), { status: 400 }));
      }
    } catch {
      return fail(Object.assign(new Error('That file isn’t a valid .docx file.'), { status: 400 }));
    }

    // Detect [[LLM prompt]] blocks in the raw docx XML (a heuristic — accurate
    // enough for the flag, docxtemplater does the proper parse at fill time).
    const xml = content.toString('binary');
    const hasLlmPrompts = /\[\[.+?\]\]/.test(xml);

    const row = await queryOne<{ id: string }>(
      `insert into doc_template
         (tenant_id, name, description, file_name, file_content, file_size_bytes, has_llm_prompts, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (tenant_id, name) do update set description = excluded.description, file_name = excluded.file_name, file_content = excluded.file_content, file_size_bytes = excluded.file_size_bytes, has_llm_prompts = excluded.has_llm_prompts, updated_at = now()
       returning id`,
      [user.tenantId, name, description, file.name, content, file.size, hasLlmPrompts, user.userId]
    );

    return ok({ id: row!.id, name, fileName: file.name, hasLlmPrompts });
  } catch (error) {
    return fail(error);
  }
}
