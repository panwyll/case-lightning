import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { ok, fail } from '@/lib/server/http';
import { runAsSystem } from '@/lib/server/db';
import { engine } from '@/lib/server/engine/adapters';
import { EXTERNAL } from '@/lib/server/engine/types';
import { openPortal, portalAccess, portalCookieName } from '@/lib/server/client-portal';
import { devHarness, DEV_MATTER, DEV_TENANT } from '@/lib/server/dev-harness';
import { isDevPortal } from '@/lib/server/dev-portal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ kind: z.enum(['sdlt', 'cgt']), answers: z.record(z.string(), z.boolean()) });
const SDLT_KEYS = ['mainResidence', 'anyEverOwned', 'anyOwnsOther', 'replacing', 'replacingFirst', 'anyNonResident'];
const CGT_KEYS = ['mainResidenceThroughout', 'ukResident'];

/** The client's own answers to the tax questions (sdlt-facts.ts): recorded on the case as theirs, so the firm's task clears. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const body = Body.parse(await req.json());
    const keys = body.kind === 'sdlt' ? SDLT_KEYS : CGT_KEYS;
    const answers = Object.fromEntries(keys.map((k) => [k, !!body.answers[k]]));
    const command = { type: body.kind === 'sdlt' ? 'record_sdlt_facts' : 'record_cgt_facts', actor: EXTERNAL, ...answers } as never;
    if (isDevPortal(token)) {
      const h = await devHarness();
      await h.svc.run(DEV_TENANT, DEV_MATTER, command);
      return ok({ saved: true });
    }
    const row = await openPortal(token);
    if (!row) throw Object.assign(new Error('This link no longer works.'), { status: 410 });
    if (!portalAccess(row.id, (await cookies()).get(portalCookieName(row.id))?.value)) throw Object.assign(new Error('Enter the code first.'), { status: 401 });
    await runAsSystem(() => engine().run(row.tenant_id, row.matter_id, command));
    return ok({ saved: true });
  } catch (error) {
    return fail(error);
  }
}
