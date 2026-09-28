import { NextRequest, NextResponse } from 'next/server';
import { handleSigningWebhook } from '@/lib/server/integrations/signing/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** infotrack e-signing callback (stub until the provider's API is connected): signed, declined or expired. */
export async function POST(req: NextRequest) {
  try {
    const r = await handleSigningWebhook('infotrack', req.headers.get('x-signing-secret'), await req.json());
    return NextResponse.json(r.body, { status: r.status });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
