import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import PizZip from 'pizzip';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { queryOne, query } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

import { DOC_USAGE, templateRendersCleanly } from '@/lib/server/doc-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Download the raw .docx template file. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);

    const row = await queryOne<{ file_name: string; file_content: Buffer }>(
      `select file_name, file_content from doc_template where id = $1 and tenant_id = $2`,
      [id, user.tenantId]
    );
    if (!row) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

    return new NextResponse(new Uint8Array(row.file_content), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${row.file_name}"`,
      },
    });
  } catch (error) {
    return fail(error);
  }
}

/** Delete a template. */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);

    const row = await queryOne<{ name: string }>(`select name from doc_template where id = $1 and tenant_id = $2`, [id, user.tenantId]);
    if (row && DOC_USAGE[row.name]) return fail(Object.assign(new Error('The engine produces this document at a step in the flow. Replace its file with your own instead of deleting it.'), { status: 400 }));
    await query(`delete from doc_template where id = $1 and tenant_id = $2`, [id, user.tenantId]);
    return ok({ deleted: true });
  } catch (error) {
    return fail(error);
  }
}

/** Update sort order or metadata. */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);
    const body = z.object({ sortOrder: z.number().int().optional() }).parse(await req.json());

    if (body.sortOrder !== undefined) {
      await query(
        `update doc_template set sort_order = $1, updated_at = now() where id = $2 and tenant_id = $3`,
        [body.sortOrder, id, user.tenantId]
      );
    }
    return ok({ updated: true });
  } catch (error) {
    return fail(error);
  }
}

/** Replace the file behind a document, keeping its name and its place in the flow. */
export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { id } = z.object({ id: z.string().uuid() }).parse(await params);
    const form = await req.formData();
    const file = form.get('file') as File | null;
    if (!file) return fail(Object.assign(new Error('No file uploaded.'), { status: 400 }));
    if (!/\.docx$/i.test(file.name)) return fail(Object.assign(new Error('Only Word (.docx) files are supported.'), { status: 400 }));
    if (file.size > 10 * 1024 * 1024) return fail(Object.assign(new Error('File too large (max 10 MB).'), { status: 400 }));
    const content = Buffer.from(await file.arrayBuffer());
    try {
      const zip = new PizZip(content);
      if (!zip.file('word/document.xml')) return fail(Object.assign(new Error('That file isn’t a valid Word document.'), { status: 400 }));
    } catch {
      return fail(Object.assign(new Error('That file isn’t a valid Word document.'), { status: 400 }));
    }
    if (!templateRendersCleanly(content)) return fail(Object.assign(new Error('The placeholders in that file are unbalanced; check every {{ }} and [[ ]].'), { status: 400 }));
    const hasLlm = /\[\[[\s\S]+?\]\]/.test(content.toString('latin1'));
    const r = await queryOne<{ id: string }>(`update doc_template set file_name = $1, file_content = $2, file_size_bytes = $3, has_llm_prompts = $4, updated_at = now() where id = $5 and tenant_id = $6 returning id`, [file.name, content, content.length, hasLlm, id, user.tenantId]);
    if (!r) return fail(Object.assign(new Error('Document not found.'), { status: 404 }));
    return ok({ replaced: true });
  } catch (error) {
    return fail(error);
  }
}
