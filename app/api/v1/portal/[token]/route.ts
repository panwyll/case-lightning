import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { ok, fail } from '@/lib/server/http';
import { runAsSystem, queryOne } from '@/lib/server/db';
import { contactInfo } from '@/lib/server/comms/adapters';
import { codeRecipients, maskEmail } from '@/lib/server/access-code';
import { getFirmProfile } from '@/lib/server/firm';
import { getSignaturePerson } from '@/lib/server/signature';
import { engine } from '@/lib/server/engine/adapters';
import { clientPortalView } from '@/lib/server/engine/client-portal';
import { clientFaqs } from '@/lib/server/engine/client-faq';
import { infotrackClientFor } from '@/lib/server/integrations/infotrack-adapters';
import { PORTAL_HOURS, feedbackDue, countPortalOpen, openPortal, portalAccess, portalCookie, portalCookieName, portalDocuments, sendPortalCode, verifyPortalCode } from '@/lib/server/client-portal';
import { DEV_PORTAL_CODE, devPortalContext, isDevPortal } from '@/lib/server/dev-portal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WRONG = 'That code is not right. Check the latest email from us, or ask for a new code.';

/**
 * The client portal (lib/server/client-portal.ts). No account: the link opens with a code emailed to
 * the client's address on the case. Before the code, only the firm, the property and where the code
 * goes; after it, the case as the client sees it (engine/client-portal.ts) and their documents.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    if (isDevPortal(token)) {
      if ((await cookies()).get('cp_dev')?.value !== '1') return ok({ status: 'locked', firmName: 'Your Firm LLP', propertyAddress: '14 Oak Street, Leeds LS1 2AB', codeTo: ['p••••••@hotmail.com'] });
      return ok(await devPortalContext());
    }
    const row = await openPortal(token);
    if (!row) return ok({ status: 'gone' });
    const info = await runAsSystem(() => contactInfo(row.tenant_id, row.matter_id));
    if (!portalAccess(row.id, (await cookies()).get(portalCookieName(row.id))?.value)) {
      return ok({ status: 'locked', firmName: info.firmName, propertyAddress: info.propertyAddress, codeTo: (await runAsSystem(() => codeRecipients(row))).map(maskEmail) });
    }
    const svc = engine();
    const [state, firm, person, documents, enrolled] = await Promise.all([
      runAsSystem(() => svc.getState(row.tenant_id, row.matter_id)),
      runAsSystem(() => getFirmProfile(row.tenant_id)),
      runAsSystem(() => getSignaturePerson(row.tenant_id, info.feeEarnerUserId)),
      portalDocuments(row),
      runAsSystem(() => queryOne<{ id: string }>(`select matter_id as id from matter_engine_state where matter_id = $1`, [row.matter_id])),
    ]);
    await countPortalOpen(row.id);
    // Whether the client's ID link comes from InfoTrack (the firm's own account) or from us.
    const infotrack = await infotrackClientFor(row.tenant_id).catch(() => null);
    const view = enrolled ? clientPortalView(state, new Date(), infotrack ? { idProviderSendsLink: true, idProviderLabel: 'InfoTrack' } : {}) : null;
    return ok({
      status: 'open',
      faqs: view ? clientFaqs(view) : [],
      feedback: view ? await feedbackDue(row, view.lifecycle) : null,
      firmName: info.firmName,
      propertyAddress: info.propertyAddress,
      clientNames: info.clientFirstName,
      handler: { name: person.name, email: person.email, phone: person.phone },
      firmPhone: firm.phone ?? null,
      // A case the engine does not run has no status to show yet: documents and contact only.
      view,
      documents,
    });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const body = z.discriminatedUnion('action', [z.object({ action: z.literal('code') }), z.object({ action: z.literal('verify'), code: z.string().regex(/^\s*\d{6}\s*$/, 'The code is six digits.') })]).parse(await req.json());
    if (isDevPortal(token)) {
      if (body.action === 'code') return ok({ sentTo: ['p••••••@hotmail.com'], devCode: DEV_PORTAL_CODE });
      if (body.code.trim() !== DEV_PORTAL_CODE) return fail(Object.assign(new Error(WRONG), { status: 400 }));
      const res = NextResponse.json({ ok: true });
      res.cookies.set('cp_dev', '1', { path: '/', maxAge: 3600 });
      return res;
    }
    const row = await openPortal(token);
    if (!row) return fail(Object.assign(new Error('This link no longer works. Reply to our latest email or call us and we will send you a new one.'), { status: 410 }));
    if (body.action === 'code') return ok(await runAsSystem(() => sendPortalCode(row)));
    if (!(await verifyPortalCode(row, body.code))) return fail(Object.assign(new Error(WRONG), { status: 400 }));
    const res = NextResponse.json({ ok: true });
    res.cookies.set(portalCookieName(row.id), portalCookie(row.id), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: PORTAL_HOURS * 3600 });
    return res;
  } catch (error) {
    return fail(error);
  }
}
