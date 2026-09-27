import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { config } from '@/lib/server/config';
import { query, queryOne, runAsSystem } from '@/lib/server/db';
import { engine } from '@/lib/server/engine/adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resend tells us what became of a message after it accepted it: delivered, bounced,
 * complained, delayed. Acceptance was never delivery. The case's message record gets the
 * outcome, and a bounce or complaint becomes the same task as a failed send, with Try Again.
 *
 * Signed with Svix headers (svix-id, svix-timestamp, svix-signature); the secret is
 * RESEND_WEBHOOK_SECRET. Set the endpoint in Resend to <app>/api/v1/webhooks/resend.
 */
function verify(raw: string, headers: Headers): boolean {
  const secret = config.resendWebhookSecret;
  if (!secret) return false;
  const id = headers.get('svix-id');
  const ts = headers.get('svix-timestamp');
  const sigs = headers.get('svix-signature');
  if (!id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 5 * 60) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  return sigs.split(' ').some((s) => {
    const [, v] = s.split(',');
    if (!v || v.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected));
  });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verify(raw, req.headers)) return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  let event: { type?: string; data?: { email_id?: string; to?: string[]; bounce?: { message?: string; type?: string; subType?: string }; subject?: string } };
  try { event = JSON.parse(raw); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const emailId = event.data?.email_id;
  const type = event.type ?? '';
  if (!emailId || !type.startsWith('email.')) return NextResponse.json({ ok: true, ignored: true });
  return runAsSystem(async () => {
    const msg = await queryOne<{ id: string; tenant_id: string; matter_id: string; template: string | null; address: string | null }>(
      `select id, tenant_id, matter_id, template, address from client_message where provider_ref = $1 order by created_at desc limit 1`,
      [emailId]
    );
    if (!msg) return NextResponse.json({ ok: true, unknown: true });
    const outcome = type === 'email.delivered' ? 'DELIVERED'
      : type === 'email.bounced' ? `FAILED: bounced${event.data?.bounce?.message ? ` — ${event.data.bounce.message}` : ''}`
      : type === 'email.complained' ? 'FAILED: reported as spam'
      : type === 'email.delivery_delayed' ? 'DELAYED'
      : type === 'email.opened' ? 'OPENED'
      : null;
    if (outcome) await query(`update client_message set status = $2 where id = $1`, [msg.id, outcome]);
    if (type === 'email.bounced' || type === 'email.complained') {
      const reason = type === 'email.bounced' ? `Bounced: ${event.data?.bounce?.message ?? 'the address did not accept it'}` : 'Reported as spam by the recipient';
      await engine().recordDeliveryFailure(msg.tenant_id, msg.matter_id, { template: msg.template, address: msg.address, reason, providerRef: emailId }).catch(() => {});
    }
    return NextResponse.json({ ok: true });
  });
}
