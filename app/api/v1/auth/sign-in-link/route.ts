import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { ok, fail } from '@/lib/server/http';
import { requestSignInLink } from '@/lib/server/sign-in-links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ email: z.string().min(3).max(320), next: z.string().max(500).nullish() });

/**
 * Ask for a one-time sign-in link (docs/sign-in.md).
 *
 * The response is deliberately the same whether or not we know the address: telling a
 * stranger "no such user" on a conveyancer's email would leak which firms are clients.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const input = schema.parse(await req.json());
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
    const result = await requestSignInLink(input.email, { next: input.next ?? null, ip });
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}
