import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { createMatter } from '@/lib/server/matter';
import { query } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Search the firm's matters by reference, address, or party name so a user can
// link an email to an existing matter the auto-matcher didn't surface. An empty
// query returns the most recent matters, so the picker is useful before typing.
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
    const like = `%${q}%`;
    const rows = await query<{ id: string; matter_ref: string; property_address: string }>(
      `select id, matter_ref, property_address
         from matter
        where tenant_id = $1
          and ($2 = ''
               or matter_ref ilike $3
               or property_address ilike $3
               or array_to_string(buyer_names, ' ') ilike $3
               or array_to_string(seller_names, ' ') ilike $3)
        order by created_at desc
        limit 20`,
      [user.tenantId, q, like]
    );
    return ok({ matters: rows.map((m) => ({ id: m.id, matterRef: m.matter_ref, propertyAddress: m.property_address })) });
  } catch (error) {
    return fail(error);
  }
}

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
