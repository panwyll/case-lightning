import { NextRequest } from 'next/server';
import PizZip from 'pizzip';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

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
    return ok({ templates: rows });
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
       returning id`,
      [user.tenantId, name, description, file.name, content, file.size, hasLlmPrompts, user.userId]
    );

    return ok({ id: row!.id, name, fileName: file.name, hasLlmPrompts });
  } catch (error) {
    return fail(error);
  }
}
