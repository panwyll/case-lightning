import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';
import { getSignaturePerson, signatureFor } from '@/lib/server/signature';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Your email signature: your own lines (job title, direct line) and how the whole signature looks under the firm's details. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const [person, sig] = await Promise.all([getSignaturePerson(user.tenantId, user.userId), signatureFor(user.tenantId, user.userId)]);
    return ok({ person, preview: { html: sig.html, text: sig.text } });
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const b = z.object({ jobTitle: z.string().max(80).nullish(), phone: z.string().max(30).regex(/^[0-9 +()-]*$/, 'A phone number, digits and spaces').nullish() }).parse(await req.json());
    const blank = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);
    await query(`update app_user set job_title = $3, phone = $4 where id = $1 and tenant_id = $2`, [user.userId, user.tenantId, blank(b.jobTitle), blank(b.phone)])
      .catch((e) => { throw Object.assign(new Error(`Could not save (has migration 105 been run?): ${(e as Error).message}`), { status: 500 }); });
    const [person, sig] = await Promise.all([getSignaturePerson(user.tenantId, user.userId), signatureFor(user.tenantId, user.userId)]);
    return ok({ person, preview: { html: sig.html, text: sig.text } });
  } catch (error) {
    return fail(error);
  }
}
