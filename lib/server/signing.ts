/**
 * The signing pack, for real: a letter from the fee earner's own mailbox with the wet-ink deeds
 * attached and the firm's postal address to return them to, and an envelope per electronic deed
 * with the firm's signing provider. Called by the engine through its signing port.
 */
import { query, queryOne } from './db';
import { getBlob } from './blob-store';
import { addAttachmentToMessage, createDraftMessage, downloadDriveItem, sendDraftMessage } from './graph';
import { getFirmProfile, postalAddress } from './firm';
import { getPolicy } from './policy';
import { driveUserFor } from './matter-drive';
import { config } from './config';
import { SIGNING_PROVIDERS, SigningNotConnectedError } from './integrations/signing/providers';
import { SIGNED_DOCUMENT_LABEL, type SignedDocument } from './engine/types';
import type { SigningPort } from './engine/ports';
import { messageProblem, render, templateFor } from './comms/templates';

/** Which file on the case is which deed: its type, or failing that its name. */
const FIND: Record<SignedDocument, { types: string[]; name: RegExp }> = {
  transfer: { types: ['TR1', 'TRANSFER_DEED', 'TP1', 'TR2'], name: /\b(tr1|tp1|transfer)\b/i },
  mortgage_deed: { types: ['MORTGAGE_DEED', 'CHARGE'], name: /mortgage\s*deed|legal charge|\bcharge\b/i },
  deed_of_trust: { types: ['DEED_OF_TRUST', 'DECLARATION_OF_TRUST'], name: /(deed|declaration) of trust/i },
};

async function deedFile(tenantId: string, matterId: string, d: SignedDocument): Promise<{ id: string; fileName: string; bytes: Buffer; mime: string } | null> {
  const f = FIND[d];
  const rows = await query<{ id: string; file_name: string | null; doc_type: string | null; mime_type: string | null; graph_item_id: string | null; blob: Buffer | null; created_by: string | null }>(
    `select d.id, d.file_name, d.doc_type, d.mime_type, d.graph_item_id, (select b.bytes from document_blob b where b.document_id = d.id) as blob, d.created_by
       from document d where d.tenant_id = $1 and d.matter_id = $2 and d.superseded_at is null and coalesce(d.doc_type, '') <> 'SIGNED_DEED'
      order by d.created_at desc limit 200`,
    [tenantId, matterId]
  );
  const hit = rows.find((r) => f.types.includes((r.doc_type ?? '').toUpperCase())) ?? rows.find((r) => r.file_name && f.name.test(r.file_name) && !/signed/i.test(r.file_name));
  if (!hit) return null;
  let bytes = hit.blob ?? (await getBlob(tenantId, hit.id).catch(() => null));
  if (!bytes && hit.graph_item_id) bytes = await downloadDriveItem(await driveUserFor(tenantId, matterId, hit.created_by ?? ''), hit.graph_item_id).catch(() => null);
  if (!bytes) return null;
  return { id: hit.id, fileName: hit.file_name ?? `${SIGNED_DOCUMENT_LABEL[d]}.pdf`, bytes, mime: hit.mime_type ?? 'application/pdf' };
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export const productionSigning: SigningPort = {
  name: 'signing:mailbox+provider',
  async defaults(tenantId, lender) {
    const provider = await getPolicy(tenantId, 'signingProvider').catch(() => 'none' as const);
    let lenderAcceptsDigital: boolean | null = null;
    if (lender) {
      const row = await queryOne<{ accepts_digital_deed: boolean | null }>(`select accepts_digital_deed from lender_profile where tenant_id = $1 and lower(lender_name) = lower($2)`, [tenantId, lender]).catch(() => null);
      lenderAcceptsDigital = row?.accepts_digital_deed ?? null;
    }
    return { provider, lenderAcceptsDigital };
  },
  async sendPack({ tenantId, matterId, wet, electronic, signers, reminder, override }) {
    const m = await queryOne<{ matter_ref: string; property_address: string; assigned_to: string | null; created_by: string; fee_name: string | null; client_email: string | null; client_emails: string[] | null; client_name: string | null; buyer_names: string[] | null }>(
      `select m.matter_ref, m.property_address, m.assigned_to, m.created_by, coalesce(u.display_name, u.email) as fee_name,
              (select c.email from matter_contact c where c.matter_id = m.id and c.tenant_id = m.tenant_id and c.role = 'CLIENT' order by c.last_seen_at desc limit 1) as client_email,
              (select array_agg(distinct lower(c.email)) from matter_contact c where c.matter_id = m.id and c.tenant_id = m.tenant_id and c.role = 'CLIENT' and c.email is not null) as client_emails,
              (select c.name from matter_contact c where c.matter_id = m.id and c.tenant_id = m.tenant_id and c.role = 'CLIENT' order by c.last_seen_at desc limit 1) as client_name,
              m.buyer_names
         from matter m left join app_user u on u.id = coalesce(m.assigned_to, m.created_by) where m.id = $1 and m.tenant_id = $2`,
      [matterId, tenantId]
    );
    if (!m) throw new Error('Case not found.');
    if (!m.client_email) throw new Error('No email address for the client on this case; add it to the case contacts, then try again.');
    const sender = m.assigned_to ?? m.created_by;
    const firm = await getFirmProfile(tenantId);

    // Electronic first: a deed the provider cannot take (not connected) is signed in ink instead.
    const provider = await getPolicy(tenantId, 'signingProvider').catch(() => 'none' as const);
    const adapter = SIGNING_PROVIDERS[provider] ?? null;
    const envelopes: Array<{ document: SignedDocument; provider: string; envelopeId: string }> = [];
    const fellBackToWet: SignedDocument[] = [];
    const withProvider = new Set(reminder?.alreadyWithProvider ?? []);
    for (const d of electronic) {
      // A reminder does not open a second envelope for a deed the provider already has.
      if (withProvider.has(d)) continue;
      const file = await deedFile(tenantId, matterId, d);
      if (!adapter || !file) { fellBackToWet.push(d); continue; }
      try {
        const r = await adapter.createEnvelope({ tenantId, matterId, document: d, fileName: file.fileName, bytes: file.bytes, signers, witnessRequired: true, callbackUrl: `${config.appUrl}/api/v1/integrations/${adapter.id}/signing` });
        envelopes.push({ document: d, provider: adapter.id, envelopeId: r.envelopeId });
      } catch (e) {
        if (e instanceof SigningNotConnectedError) fellBackToWet.push(d); else throw e;
      }
    }
    const inInk = [...wet, ...fellBackToWet];

    // Wet ink: the documents themselves, and where to post them. Neither missing is allowed out.
    const address = postalAddress(firm);
    if (inInk.length && !address) throw new Error("The firm's postal address is not set (Team page, Firm Details), so the client would not know where to send the signed originals.");
    const files: Array<{ d: SignedDocument; f: NonNullable<Awaited<ReturnType<typeof deedFile>>> }> = [];
    const missing: SignedDocument[] = [];
    for (const d of inInk) { const f = await deedFile(tenantId, matterId, d); if (f) files.push({ d, f }); else missing.push(d); }
    if (missing.length) throw new Error(`The ${list(missing.map((d) => SIGNED_DOCUMENT_LABEL[d].toLowerCase()))} ${missing.length === 1 ? 'is' : 'are'} not on the case yet. Add ${missing.length === 1 ? 'it' : 'them'} to the case (Documents), then send the pack again.`);

    const labels = (ds: SignedDocument[]) => list(ds.map((d) => SIGNED_DOCUMENT_LABEL[d].replace('Transfer (TR1)', 'the transfer (TR1)').replace(/^Mortgage deed$/, 'the mortgage deed').replace(/^Declaration of trust$/, 'the declaration of trust')));
    const firstName = (m.client_name ?? m.buyer_names?.[0] ?? '').split(/\s+/)[0] || 'there';
    const t = templateFor('signing_pack');
    if (!t) throw new Error('Signing letter template missing.');
    const r = render(t, {
      firstName,
      property: m.property_address,
      transaction: 'purchase',
      signingIntro: reminder
        ? `A reminder that we still need ${labels([...inInk, ...envelopes.map((e) => e.document), ...withProvider])} signed. We cannot complete without ${inInk.length + envelopes.length + withProvider.size === 1 ? 'it' : 'them'}${[...inInk, ...envelopes.map((e) => e.document), ...withProvider].includes('mortgage_deed') ? ', and your lender will not release the mortgage money until we hold the signed mortgage deed' : ''}. Everything is below again, so you do not have to look for our earlier email.`
        : `Here ${inInk.length + envelopes.length === 1 ? 'is the document' : 'are the documents'} you need to sign: ${labels([...inInk, ...envelopes.map((e) => e.document)])}.`,
      wetBlock: inInk.length ? `To sign in ink (${labels(inInk)}, attached):\n• Print ${inInk.length === 1 ? 'it' : 'them'} single-sided and sign where marked.\n• Sign in front of an independent adult witness: not a relative, not your partner, and not anyone with an interest in the property. The witness signs and adds their name and address.\n• Post the signed originals to:\n${address!.join('\n')}\n\n` : '',
      electronicBlock: (withProvider.size ? `To sign electronically (${labels([...withProvider])}): use the link in the email ${adapter?.label ?? 'our signing provider'} sent you. If you cannot find it (it is worth looking in junk), reply to this email and we will have it sent again.\n\n` : '') + (envelopes.length ? `To sign electronically (${labels(envelopes.map((e) => e.document))}): you will receive an email from ${adapter?.label ?? 'our signing provider'} with a link. Your witness must be with you in person when you sign, and will get their own link to sign as witness.\n\n` : ''),
      feeEarner: m.fee_name ?? firm.name,
      firmName: firm.name,
    });
    if (reminder) r.subject = `Reminder: ${r.subject}`;
    if (override?.subject?.trim()) r.subject = override.subject.trim();
    if (override?.body?.trim()) r.body = override.body.trim();
    const held = messageProblem(r);
    if (held) throw new Error(`Not sent: the message looks wrong (${held}).`);
    const { signatureFor, signedHtml, signedText } = await import('./signature');
    const sig = await signatureFor(tenantId, sender).catch(() => null);
    const body = signedText(r.body, sig);
    const html = signedHtml(r.body, sig);
    // Every client signs, so every client gets the pack.
    const draft = await createDraftMessage(sender, r.subject, html, m.client_emails?.length ? m.client_emails : [m.client_email]);
    for (const { f } of files) await addAttachmentToMessage(sender, draft.id, f.fileName, f.bytes, f.mime);
    await sendDraftMessage(sender, draft.id);
    await query(
      `insert into client_message (tenant_id, matter_id, direction, channel, address, template, subject, body, provider_ref, status) values ($1,$2,'OUT','email',$3,$7,$4,$5,$6,'SENT')`,
      [tenantId, matterId, (m.client_emails?.length ? m.client_emails : [m.client_email]).join(', '), r.subject, body, draft.id ?? null, reminder ? 'chase_signed_documents' : 'signing_pack']
    ).catch(() => {});
    return { channel: 'email', messageId: draft.id ?? null, attached: files.map(({ f }) => f.fileName), envelopes, fellBackToWet };
  },
};
