import { NextRequest, after } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { ok, fail } from '@/lib/server/http';
import { queryOne, runAsSystem } from '@/lib/server/db';
import { contactInfo } from '@/lib/server/comms/adapters';
import { emitMatterEvent } from '@/lib/server/events';
import { openPortal, portalAccess, portalCookieName } from '@/lib/server/client-portal';
import { isDevPortal } from '@/lib/server/dev-portal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * A message from the client's portal. It is read exactly like an email from the client (the note
 * reader: their questions, what they say is done, what they decide) and becomes a reply task on the
 * Tasks list, with the reply drafted from the case. Ten a day per case.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const { text } = z.object({ text: z.string().trim().min(10, 'Write a little more so we can help.').max(4000) }).parse(await req.json());
    if (isDevPortal(token)) return ok({ sent: true });
    const row = await openPortal(token);
    if (!row) throw Object.assign(new Error('This link no longer works.'), { status: 410 });
    if (!portalAccess(row.id, (await cookies()).get(portalCookieName(row.id))?.value)) throw Object.assign(new Error('Enter the code first.'), { status: 401 });
    const recent = await runAsSystem(() => queryOne<{ n: string }>(`select count(*)::text as n from matter_timeline_event where matter_id = $1 and event_type = 'CLIENT_PORTAL_MESSAGE' and event_at > now() - interval '1 day'`, [row.matter_id]));
    if (Number(recent?.n ?? 0) >= 10) throw Object.assign(new Error('You have sent us a lot of messages today. Please call us.'), { status: 429 });
    const info = await runAsSystem(() => contactInfo(row.tenant_id, row.matter_id));
    await runAsSystem(() => emitMatterEvent({ tenantId: row.tenant_id, matterId: row.matter_id, eventType: 'CLIENT_PORTAL_MESSAGE', title: 'The client sent a message from their portal', details: text }));
    after(async () => {
      try {
        const { engine } = await import('@/lib/server/engine/adapters');
        const handler = info.feeEarnerUserId;
        if (!handler) return;
        // Filed under the case handler (whose case it is), from the client, as an email would be: it always comes to a person.
        await runAsSystem(() => engine().recordNote(row.tenant_id, row.matter_id, { text, kind: 'email', actor: handler, from: { address: info.clientEmail ?? 'portal', name: info.clientFirstName, relation: 'client' }, surface: true, subject: 'Message from the client portal' }));
      } catch (err) {
        console.error('[portal] message could not be read', err);
      }
    });
    return ok({ sent: true });
  } catch (error) {
    return fail(error);
  }
}
