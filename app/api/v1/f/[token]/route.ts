import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { ok, fail } from '@/lib/server/http';
import { contactInfo } from '@/lib/server/comms/adapters';
import { runAsSystem } from '@/lib/server/db';
import { DEV_SHARE_CODE, devShareContext, isDevShare } from '@/lib/server/dev-file-share';
import { ACCESS_HOURS, accessCookie, accessCookieName, codeRecipients, hasAccess, maskEmail, openShare, sendCode, verifyCode } from '@/lib/server/file-shares';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A secure link to files (lib/server/file-shares.ts). No login: the link opens with a code emailed
 * to the client's address on the case. GET says what is behind it; POST sends a code or checks one.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    if (isDevShare(token)) return ok(devShareContext((await cookies()).get('fs_dev')?.value === '1'));
    const share = await openShare(token);
    if (!share) return ok({ status: 'gone' });
    const info = await runAsSystem(() => contactInfo(share.tenant_id, share.matter_id));
    const open = hasAccess(share.id, (await cookies()).get(accessCookieName(share.id))?.value);
    return ok({ status: 'ok', firmName: info.firmName, propertyAddress: info.propertyAddress, files: share.file_names, open, codeTo: (await runAsSystem(() => codeRecipients(share))).map(maskEmail) });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    if (isDevShare(token)) {
      const b = (await req.json()) as { action: string; code?: string };
      if (b.action === 'code') return ok({ sentTo: ['p••••••@hotmail.com'], devCode: DEV_SHARE_CODE });
      if (b.code?.trim() !== DEV_SHARE_CODE) return fail(Object.assign(new Error('That code is not right. Check the latest email from us, or ask for a new code.'), { status: 400 }));
      const res = NextResponse.json({ ok: true });
      res.cookies.set('fs_dev', '1', { path: '/', maxAge: 3600 });
      return res;
    }
    const share = await openShare(token);
    if (!share) return fail(Object.assign(new Error('This link has expired. Reply to our email or call us and we will send a new one.'), { status: 410 }));
    const body = z.discriminatedUnion('action', [z.object({ action: z.literal('code') }), z.object({ action: z.literal('verify'), code: z.string().regex(/^\s*\d{6}\s*$/, 'The code is six digits.') })]).parse(await req.json());
    if (body.action === 'code') return ok(await runAsSystem(() => sendCode(share)));
    if (!(await verifyCode(share, body.code))) return fail(Object.assign(new Error('That code is not right. Check the latest email from us, or ask for a new code.'), { status: 400 }));
    const res = NextResponse.json({ ok: true });
    res.cookies.set(accessCookieName(share.id), accessCookie(share.id), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: ACCESS_HOURS * 3600 });
    return res;
  } catch (error) {
    return fail(error);
  }
}
