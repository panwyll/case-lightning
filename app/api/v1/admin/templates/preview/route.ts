import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A template's words (as they stand in the editor) filled from a chosen case. Nothing is sent. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const body = z.object({ matterId: z.string().uuid(), name: z.string().max(120), engine: z.boolean(), subject: z.string().max(2000), body: z.string().max(40_000) }).parse(await req.json());
    await assertMatterAccess(user, body.matterId);
    if (body.engine) {
      const { isSandboxMatter, sandboxCommsDeps } = await import('@/lib/server/engine/sandbox');
      const { commsDeps } = await import('@/lib/server/comms/adapters');
      const { ProductionChaser } = await import('@/lib/server/comms/client-comms');
      const deps = (await isSandboxMatter(user.tenantId, body.matterId)) ? sandboxCommsDeps() : commsDeps();
      const r = await new ProductionChaser(deps).previewTemplateText({ tenantId: user.tenantId, matterId: body.matterId, key: body.name, subject: body.subject, body: body.body });
      return ok(r);
    }
    const { matterEmailVars } = await import('@/lib/server/workflow');
    const vars = (await matterEmailVars(user.tenantId, body.matterId)) ?? {};
    const fill = (s: string) => s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => vars[k] ?? `{{${k}}}`);
    return ok({ subject: fill(body.subject), body: fill(body.body), missing: [] });
  } catch (error) {
    return fail(error);
  }
}
