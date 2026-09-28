import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query } from '@/lib/server/db';
import { getFirmProfile } from '@/lib/server/firm';
import { buildSignature, getSignaturePerson, standardSignature } from '@/lib/server/signature';
import { sanitizeSignatureHtml } from '@/lib/server/html-sanitize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Your email signature: your own (pasted, cleaned) or the firm's standard, and exactly how it goes out. */
async function view(tenantId: string, userId: string) {
  const [firm, person] = await Promise.all([getFirmProfile(tenantId), getSignaturePerson(tenantId, userId)]);
  const own = person.signatureHtml ? sanitizeSignatureHtml(person.signatureHtml) : null;
  return { own, standard: standardSignature(firm, { ...person, signatureHtml: null }).html, preview: buildSignature(firm, person).html };
}

export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    return ok(await view(user.tenantId, user.userId));
  } catch (error) {
    return fail(error);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const b = z.object({ html: z.string().max(200_000).nullable() }).parse(await req.json());
    const cleaned = b.html ? sanitizeSignatureHtml(b.html) : '';
    // An empty box (no text and no image) means the firm's standard.
    const empty = !cleaned.replace(/<(?!img\b)[^>]+>/gi, '').replace(/&nbsp;|\s/g, '');
    await query(`update app_user set signature_html = $3 where id = $1 and tenant_id = $2`, [user.userId, user.tenantId, empty ? null : cleaned])
      .catch((e) => { throw Object.assign(new Error(`Could not save (has migration 107 been run?): ${(e as Error).message}`), { status: 500 }); });
    return ok(await view(user.tenantId, user.userId));
  } catch (error) {
    return fail(error);
  }
}
