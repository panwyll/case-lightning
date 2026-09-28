/**
 * Send a message the case already sent, again: the same words to the same address on the
 * same channel. For "they never got it", a bounce that has been fixed, or a client who
 * asks for it again. The resend is its own row on the case's message record.
 */
import { queryOne } from '../db';
import { writeAudit } from '../audit';
import { commsDeps } from './adapters';
import { signedHtml, signedText } from '../signature';
import { isSandboxMatter, sandboxCommsDeps } from '../engine/sandbox';

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
const toHtml = (text: string) => `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;

export async function resendClientMessage(tenantId: string, matterId: string, messageId: string, userId: string): Promise<{ channel: string; messageId: string | null; address: string }> {
  const row = await queryOne<{ id: string; direction: string; channel: string; address: string | null; template: string | null; subject: string | null; body: string }>(
    `select id, direction, channel, address, template, subject, body from client_message where id = $1 and tenant_id = $2 and matter_id = $3`,
    [messageId, tenantId, matterId]
  );
  if (!row) throw Object.assign(new Error('Message not found.'), { status: 404 });
  if (row.direction !== 'OUT') throw Object.assign(new Error('Only a message we sent can be sent again.'), { status: 409 });
  if (!row.address) throw Object.assign(new Error('That message has no address to send to.'), { status: 409 });
  if (!row.body?.trim()) throw Object.assign(new Error('That message has no text on record to send.'), { status: 409 });
  const deps = (await isSandboxMatter(tenantId, matterId)) ? sandboxCommsDeps() : commsDeps();
  const info = await deps.contactInfo(tenantId, matterId);
  const subject = row.subject ?? `Your case at ${info.propertyAddress} (our ref ${info.matterRef})`;
  const template = row.template ? `${row.template}` : null;
  let out: { channel: string; messageId: string | null };
  try {
    if (row.channel === 'whatsapp') {
      if (!deps.whatsapp) throw new Error('WhatsApp is not configured.');
      out = { channel: 'whatsapp', ...(await deps.whatsapp.sendText(row.address, row.body)) };
    } else if (deps.mailbox && info.feeEarnerUserId) {
      try { out = { channel: 'email', ...(await deps.mailbox.send(info.feeEarnerUserId, row.address, subject, (info.signature ? signedHtml(row.body, info.signature) : toHtml(row.body)))) }; }
      catch (err) { if (!deps.email) throw err; out = { channel: 'email', ...(await deps.email.send({ to: row.address, subject, text: info.signature ? signedText(row.body, info.signature) : row.body, fromUserId: info.feeEarnerUserId })) }; }
    } else if (deps.email) {
      out = { channel: 'email', ...(await deps.email.send({ to: row.address, subject, text: info.signature ? signedText(row.body, info.signature) : row.body, fromUserId: info.feeEarnerUserId })) };
    } else {
      throw new Error('No email sender configured.');
    }
  } catch (err) {
    await deps.log({ tenantId, matterId, direction: 'OUT', channel: row.channel, address: row.address, template, subject, body: row.body, providerRef: null, status: `FAILED: ${(err as Error).message}` });
    throw err;
  }
  await deps.log({ tenantId, matterId, direction: 'OUT', channel: out.channel, address: row.address, template, subject, body: row.body, providerRef: out.messageId, status: 'SENT', guard: { resendOf: row.id, by: userId } });
  await writeAudit({ tenantId, matterId, actorUserId: userId, actionType: 'MESSAGE_RESENT', actionStatus: 'SUCCESS', payload: { of: row.id, to: row.address, channel: out.channel, template } }).catch(() => {});
  return { ...out, address: row.address };
}
