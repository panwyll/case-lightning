import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { runAsSystem } from '@/lib/server/db';
import { fileBytes } from '@/lib/server/engine/file-finder';
import { accessCookieName, countDownload, hasAccess, openShare } from '@/lib/server/file-shares';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One file behind a secure link, once its code has been entered in this browser. ?view=1 opens it in the browser. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string; n: string }> }) {
  const { token, n } = await params;
  const share = await openShare(token);
  if (!share) return new NextResponse('This link has expired.', { status: 410 });
  if (!hasAccess(share.id, (await cookies()).get(accessCookieName(share.id))?.value)) return new NextResponse('Enter the code first.', { status: 401 });
  const i = Number(n);
  const id = Number.isInteger(i) ? share.document_ids[i] : undefined;
  if (!id) return new NextResponse('Not found.', { status: 404 });
  const f = await runAsSystem(() => fileBytes(share.tenant_id, id));
  if (!f) return new NextResponse('This file is not available. Please call us.', { status: 404 });
  await countDownload(share.id);
  const name = share.file_names[i] ?? f.name;
  const inline = req.nextUrl.searchParams.get('view') === '1' && /pdf|image\//.test(f.contentType);
  return new NextResponse(new Uint8Array(f.bytes), { headers: { 'content-type': f.contentType, 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/["\r\n]/g, '')}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
}
