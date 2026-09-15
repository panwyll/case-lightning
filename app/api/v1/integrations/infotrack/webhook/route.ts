import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { SEARCH_TYPES } from '@/lib/server/engine/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * STUB for component #4 (InfoTrack). The real integration will authenticate the
 * provider's webhook, fetch the result PDF, file it as a `document` row and hand it to
 * the extraction pipeline. This stub accepts an already-filed document id so the
 * search-review flow can be exercised end to end before the integration exists.
 *
 * Protected by INFOTRACK_WEBHOOK_SECRET (Bearer). 503 until it is configured, so an
 * unconfigured deployment never accepts unauthenticated search results.
 */
const bodySchema = z.object({
  tenantId: z.string().uuid(),
  matterId: z.string().uuid(),
  searchType: z.enum(SEARCH_TYPES),
  documentId: z.string().uuid(),
  reference: z.string().max(100).optional(),
});

export async function POST(req: NextRequest) {
  try {
    assertFeature('db');
    const secret = process.env.INFOTRACK_WEBHOOK_SECRET;
    if (!secret) return fail(Object.assign(new Error('InfoTrack webhook is not configured (INFOTRACK_WEBHOOK_SECRET).'), { status: 503 }));
    if (req.headers.get('authorization') !== `Bearer ${secret}`) return fail(Object.assign(new Error('Unauthorized'), { status: 401 }));
    const body = bodySchema.parse(await req.json());
    const result = await engine().searchReturned(body.tenantId, body.matterId, body.searchType, body.documentId, 'infotrack');
    return ok({ received: true, events: result.events.map((e) => ({ seq: e.seq, type: e.type })) });
  } catch (error) {
    return fail(error);
  }
}
