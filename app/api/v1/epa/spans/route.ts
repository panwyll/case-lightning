import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { recordSpans } from '@/lib/server/epa/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  spans: z.array(z.object({
    start: z.string(), end: z.string(), source: z.enum(['focus', 'reading']), item: z.string().min(1).max(200),
    matterId: z.string().nullish(), kind: z.string(), of: z.string().nullish(), action: z.string().nullish(),
  })).max(200),
});

/** EPA attention evidence from the page (docs/epa.md §2), sent in batches when the page is hidden or every few minutes. */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    // sendBeacon posts text/plain: read the body as text either way.
    const body = Body.parse(JSON.parse((await req.text()) || '{}'));
    return ok({ recorded: await recordSpans(user, body.spans) });
  } catch (e) {
    return fail(e);
  }
}
