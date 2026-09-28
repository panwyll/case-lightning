import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole, requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { getFirmProfile, saveFirmProfile } from '@/lib/server/firm';
import { allPolicies, setPolicy } from '@/lib/server/policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The firm's details and its signing set-up, for the Team page. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const [firm, policies] = await Promise.all([getFirmProfile(user.tenantId), allPolicies(user.tenantId)]);
    return ok({ firm, signing: { provider: policies.signingProvider } });
  } catch (error) {
    return fail(error);
  }
}

const text = (max: number) => z.string().max(max).nullish();
export async function PATCH(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const b = z.object({
      name: z.string().min(2).max(160).optional(),
      addressLine1: text(160), addressLine2: text(160), town: text(80), postcode: z.string().max(10).regex(/^[A-Za-z0-9 ]*$/).nullish(),
      phone: z.string().max(30).regex(/^[0-9 +()-]*$/).nullish(), sraNumber: z.string().max(12).regex(/^[0-9]*$/).nullish(), website: text(200),
      signingProvider: z.enum(['none', 'infotrack', 'intouch', 'leap', 'mock']).optional(),
    }).parse(await req.json());
    const { signingProvider, ...firm } = b;
    const saved = await saveFirmProfile(user.tenantId, firm as never);
    if (signingProvider) await setPolicy(user.tenantId, 'signingProvider', signingProvider, user.userId);
    return ok({ firm: saved, signing: { provider: (await allPolicies(user.tenantId)).signingProvider } });
  } catch (error) {
    return fail(error);
  }
}
