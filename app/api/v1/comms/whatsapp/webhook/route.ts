import { NextRequest, NextResponse } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { ok, fail } from '@/lib/server/http';
import { parseInbound } from '@/lib/server/comms/whatsapp';
import { whatsappClient, clientQa } from '@/lib/server/comms/adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Meta's subscription handshake. */
export async function GET(req: NextRequest) {
  const wa = whatsappClient();
  if (!wa) return fail(Object.assign(new Error('WhatsApp is not configured.'), { status: 503 }));
  const p = req.nextUrl.searchParams;
  const challenge = wa.verifyChallenge({ mode: p.get('hub.mode'), token: p.get('hub.verify_token'), challenge: p.get('hub.challenge') });
  if (!challenge) return fail(Object.assign(new Error('Verification failed.'), { status: 403 }));
  return new NextResponse(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
}

/**
 * Inbound client messages (component #5, Q&A half). The raw body is signature-checked
 * with the app secret; each text message goes through the hard guard → FAQ →
 * validated rephrase path, or is routed to a person with a holding reply. Unknown
 * numbers are ignored — the service never engages someone it cannot tie to a matter.
 */
export async function POST(req: NextRequest) {
  try {
    assertFeature('db');
    const wa = whatsappClient();
    if (!wa) return fail(Object.assign(new Error('WhatsApp is not configured.'), { status: 503 }));
    const raw = await req.text();
    if (!wa.verifySignature(raw, req.headers.get('x-hub-signature-256'))) return fail(Object.assign(new Error('Invalid signature.'), { status: 401 }));
    const messages = parseInbound(JSON.parse(raw));
    const qa = clientQa();
    const outcomes = [];
    for (const m of messages) {
      const o = await qa.handleInbound({ fromAddress: m.from, channel: 'whatsapp', text: m.text }).catch(() => null);
      outcomes.push({ messageId: m.messageId, verdict: o?.verdict ?? 'IGNORED' });
    }
    return ok({ received: messages.length, outcomes });
  } catch (error) {
    return fail(error);
  }
}
