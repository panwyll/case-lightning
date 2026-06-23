/**
 * POST /api/v1/matters/:matterId/doc-pack
 *
 * Generates a zip of all firm document templates filled with this matter's data.
 * Premium tenants additionally get [[LLM prompt]] blocks resolved by Claude.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { isPremiumTenant } from '@/lib/server/plan';
import { generateDocPack } from '@/lib/server/doc-templates';
import { fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ matterId: string }> };

export async function POST(_req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);

    const isPremium = await isPremiumTenant(user.tenantId);
    const { zip, matterRef } = await generateDocPack(user, matterId, isPremium);

    const fileName = `${matterRef} — doc pack.zip`;
    return new NextResponse(new Uint8Array(zip), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(zip.length),
      },
    });
  } catch (error) {
    return fail(error);
  }
}
