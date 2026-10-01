import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, fail } from '@/lib/server/http';
import { devPofConnect, isDevPof } from '@/lib/server/dev-pof';
import { runAsSystem } from '@/lib/server/db';
import { openRequestByToken } from '@/lib/server/engine/pof-store';
import { openBanking, HISTORY_DAYS } from '@/lib/server/open-banking';
import { createConnection, setProviderRef } from '@/lib/server/open-banking/store';
import { callbackUrl, connectionState } from '@/lib/server/open-banking/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Start connecting a bank for one source on the form (the client's own account, or the donor's for a
 * gift). Returns the link to the bank's consent screen; the bank sends the client back to
 * /api/v1/open-banking/callback, and the browser takes them on to this form.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    if (isDevPof(token)) return ok(devPofConnect(z.object({ sourceIndex: z.number(), party: z.enum(['client', 'donor']), institutionId: z.string() }).parse(await req.json()), req.nextUrl.origin));
    const body = z.object({ sourceIndex: z.number().int().min(1).max(20), party: z.enum(['client', 'donor']), institutionId: z.string().min(1).max(120), holderName: z.string().max(140).nullish() }).parse(await req.json());
    const provider = openBanking();
    if (!provider) throw Object.assign(new Error('Connecting a bank is not available; please upload statements instead.'), { status: 503 });
    const out = await runAsSystem(async () => {
      const pof = await openRequestByToken(token);
      if (!pof || pof.status !== 'requested') throw Object.assign(new Error('This link is not valid or has already been used.'), { status: 404 });
      const inst = (await provider.institutions('gb')).find((b) => b.id === body.institutionId);
      if (!inst) throw Object.assign(new Error('That bank is not available.'), { status: 400 });
      const id = await createConnection({ tenantId: pof.tenant_id, matterId: pof.matter_id, requestId: pof.id, sourceIndex: body.sourceIndex, party: body.party, provider: provider.name, institutionId: inst.id, institutionName: inst.name });
      const started = await provider.start({ reference: id, institutionId: inst.id, callbackUrl: callbackUrl(), state: connectionState(id), historyDays: HISTORY_DAYS, holderHint: body.holderName ?? null });
      await setProviderRef(id, started.providerRef);
      return { connectionId: id, link: started.link };
    });
    return ok(out);
  } catch (error) {
    return fail(error);
  }
}
