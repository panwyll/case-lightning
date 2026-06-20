import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { createMatter } from '@/lib/server/matter';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const body = z
      .object({
        matterRef: z.string().min(1),
        propertyAddress: z.string().min(1),
        buyerNames: z.array(z.string()).default([]),
        sellerNames: z.array(z.string()).default([]),
        counterpartySolicitor: z.string().optional(),
        counterpartyAgent: z.string().optional(),
        exchangeTargetDate: z.string().optional(),
        completionTargetDate: z.string().optional(),
        lender: z.string().optional(),
        chainPosition: z.string().optional(),
      })
      .parse(await req.json());

    const created = await createMatter(user, body);
    return ok({
      id: created.id,
      folderPath: created.folderPath,
      folderWebUrl: created.folderWebUrl,
      trackerWebUrl: created.trackerWebUrl,
    });
  } catch (error) {
    return fail(error);
  }
}
