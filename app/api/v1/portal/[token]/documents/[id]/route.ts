import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { runAsSystem } from '@/lib/server/db';
import { fileBytes } from '@/lib/server/engine/file-finder';
import { openPortal, portalAccess, portalCookieName, portalDocuments } from '@/lib/server/client-portal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One of the client's documents, once the code has been entered in this browser. Only a file the portal lists can be fetched. ?view=1 opens it in the browser. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  const row = await openPortal(token);
  if (!row) return new NextResponse('This link no longer works.', { status: 410 });
  if (!portalAccess(row.id, (await cookies()).get(portalCookieName(row.id))?.value)) return new NextResponse('Enter the code first.', { status: 401 });
  const listed = (await portalDocuments(row)).find((d) => d.id === id);
  if (!listed) return new NextResponse('Not found.', { status: 404 });
  const f = await runAsSystem(() => fileBytes(row.tenant_id, id));
  if (!f) return new NextResponse('This file is not available. Please call us.', { status: 404 });
  const name = listed.from === 'us' ? listed.name : f.name;
  const inline = req.nextUrl.searchParams.get('view') === '1' && /pdf|image\//.test(f.contentType);
  return new NextResponse(new Uint8Array(f.bytes), { headers: { 'content-type': f.contentType, 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/["\r\n]/g, '')}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
}
