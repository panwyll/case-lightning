import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { runAsSystem } from '@/lib/server/db';
import { assertPlatformAdmin } from '@/lib/server/platform-admin';
import { writeAudit } from '@/lib/server/audit';
import { FEATURES, FEATURE_KEYS, firmFeatures, setFeature, setSystemMode, type FeatureKey } from '@/lib/server/features';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A firm's system mode and features: set by the people who run CONVEYi, not the firm (they may follow the plan later). */
async function view(tenantId: string) {
  const f = await runAsSystem(() => firmFeatures(tenantId));
  return { mode: f.mode, features: FEATURE_KEYS.map((k) => ({ key: k, label: FEATURES[k].label, ...f.flags[k] })) };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  try {
    assertFeature('auth');
    assertPlatformAdmin(await requireUser());
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(await params);
    return ok(await view(tenantId));
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    assertPlatformAdmin(user);
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(await params);
    const b = z.object({ mode: z.enum(['standalone', 'alongside']).optional(), feature: z.object({ key: z.enum(FEATURE_KEYS as [FeatureKey, ...FeatureKey[]]), on: z.boolean() }).optional() }).parse(await req.json());
    // The firm's own policy rows are written as the system: the platform admin belongs to another firm.
    await runAsSystem(async () => {
      if (b.mode) await setSystemMode(tenantId, b.mode, null);
      if (b.feature) await setFeature(tenantId, b.feature.key, b.feature.on, null);
    });
    await writeAudit({ tenantId, actorUserId: null, actionType: 'FIRM_FEATURES_CHANGED', actionStatus: 'SUCCESS', payload: { ...b, by: user.email } }).catch(() => {});
    return ok(await view(tenantId));
  } catch (error) {
    return fail(error);
  }
}
