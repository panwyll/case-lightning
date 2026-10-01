import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { writeAudit } from '@/lib/server/audit';
import { FEATURES, FEATURE_KEYS, SYSTEM_MODE_LABEL, firmFeatures } from '@/lib/server/features';
import { getPolicy, setPolicy } from '@/lib/server/policy';
import { COMMON_EXTRAS, FEE_CONDITIONS } from '@/lib/server/analytics/fees';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The firm's targets, review page and fees (admins change them), and, read-only, how CONVEYi is set up for it (set by the platform: /platform/firms). */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const [f, targets, fees, reviewUrl] = await Promise.all([firmFeatures(user.tenantId), getPolicy(user.tenantId, 'analyticsTargets'), getPolicy(user.tenantId, 'feeScale'), getPolicy(user.tenantId, 'reviewUrl')]);
    return ok({
      mode: f.mode,
      modes: Object.entries(SYSTEM_MODE_LABEL).map(([value, label]) => ({ value, label })),
      features: FEATURE_KEYS.map((k) => ({ key: k, label: FEATURES[k].label, ...f.flags[k] })),
      targets,
      fees: fees ?? { purchase: [], sale: [], remortgage: [], transfer: [], extras: [] },
      feeConditions: Object.entries(FEE_CONDITIONS).map(([value, c]) => ({ value, label: c.label })),
      commonExtras: COMMON_EXTRAS,
      reviewUrl,
      canEdit: user.role === 'ADMIN',
    });
  } catch (error) {
    return fail(error);
  }
}

const Band = z.object({ upTo: z.number().min(0).max(100_000_000).nullable(), fee: z.number().min(0).max(100000) });
const Body = z.object({
  fees: z.object({
    purchase: z.array(Band).max(20), sale: z.array(Band).max(20), remortgage: z.array(Band).max(20), transfer: z.array(Band).max(20),
    extras: z.array(z.object({ id: z.string().max(40), label: z.string().trim().min(1).max(80), fee: z.number().min(0).max(100000), when: z.string().refine((w) => w in FEE_CONDITIONS), sides: z.array(z.enum(['purchase', 'sale', 'remortgage', 'transfer'])) })).max(40),
  }).optional(),
  reviewUrl: z.string().url().startsWith('https://').max(500).nullable().optional(),
  targets: z.object({ monthlyCompletions: z.number().int().min(0).max(100000).nullable(), perPerson: z.record(z.string().uuid(), z.number().int().min(0).max(10000)) }).optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    if (user.role !== 'ADMIN') throw Object.assign(new Error('Only an admin changes the targets and fees.'), { status: 403 });
    const b = Body.parse(await req.json());
    if (b.targets) await setPolicy(user.tenantId, 'analyticsTargets', b.targets, user.userId);
    if (b.fees) await setPolicy(user.tenantId, 'feeScale', b.fees, user.userId);
    if (b.reviewUrl !== undefined) await setPolicy(user.tenantId, 'reviewUrl', b.reviewUrl, user.userId);
    await writeAudit({ tenantId: user.tenantId, actorUserId: user.userId, actionType: 'FIRM_FEATURES_CHANGED', actionStatus: 'SUCCESS', payload: b }).catch(() => {});
    return GET();
  } catch (error) {
    return fail(error);
  }
}
