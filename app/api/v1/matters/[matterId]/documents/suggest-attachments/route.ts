import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { retrieveMatterContext } from '@/lib/server/ai';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const { intent } = z.object({ intent: z.string().min(1) }).parse(await req.json());
    await assertMatterAccess(user, matterId);

    const context = await retrieveMatterContext({
      tenantId: user.tenantId,
      matterId,
      queryText: `Select attachments for: ${intent}`,
      includePlaybook: false,
      limit: 8,
    });
    const fileHints = new Set<string>();
    for (const c of context) {
      const fileName = (c.metadata.fileName as string | undefined) ?? (c.metadata.file_name as string | undefined);
      if (fileName) fileHints.add(fileName);
    }

    const docs = await query<any>(
      `select id, file_name, web_url, storage_path, created_at from document
       where matter_id = $1 and tenant_id = $2 order by created_at desc limit 30`,
      [matterId, user.tenantId]
    );

    const suggestions = docs
      .map((doc: any) => ({ ...doc, score: fileHints.has(doc.file_name) ? 2 : 1 }))
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 8);

    return ok({ suggestions });
  } catch (error) {
    return fail(error);
  }
}
