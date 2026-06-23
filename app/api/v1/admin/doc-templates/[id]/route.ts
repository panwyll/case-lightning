import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { queryOne, query } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

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
