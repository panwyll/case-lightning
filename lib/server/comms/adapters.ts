/**
 * Production CommsDeps: Postgres contacts + logging, WhatsApp Cloud API, Resend email,
 * the fee-earner's Graph mailbox, and routing to a person via a matter task +
 * notification. Everything is env-gated so the engine falls back to mocks cleanly.
 */
import { Resend } from 'resend';
import { config, missingFor } from '../config';
import { query, queryOne } from '../db';
import { createDraftMessage, sendMail } from '../graph';
import { createTask } from '../tasks';
import { emitMatterEvent } from '../events';
import { addDraftReady } from '../worklist';
import { claudeLlm } from '../engine/llm';
import { WhatsAppClient } from './whatsapp';
import { resolveCounterparty } from '../engine/counterparty';
import { ClientQaService, ProductionChaser, ProductionClientComms, type CommsDeps, type MatterContactInfo } from './client-comms';

export function whatsappConfigured(): boolean {
  return !!(config.whatsappPhoneNumberId && config.whatsappAccessToken);
}

let _wa: WhatsAppClient | null = null;
export function whatsappClient(): WhatsAppClient | null {
  if (!whatsappConfigured()) return null;
  if (!_wa) _wa = new WhatsAppClient({ phoneNumberId: config.whatsappPhoneNumberId!, accessToken: config.whatsappAccessToken!, appSecret: config.whatsappAppSecret, verifyToken: config.whatsappVerifyToken });
  return _wa;
}

async function contactInfo(tenantId: string, matterId: string): Promise<MatterContactInfo> {
  const m = await queryOne<{ matter_ref: string; property_address: string; buyer_names: string[]; assigned_to: string | null; created_by: string; completion_target_date: string | null; tenant_name: string; fee_name: string | null }>(
    `select m.matter_ref, m.property_address, m.buyer_names, m.assigned_to, m.created_by, m.completion_target_date::text, t.name as tenant_name,
            coalesce(u.display_name, u.email) as fee_name
       from matter m join tenant t on t.id = m.tenant_id
       left join app_user u on u.id = coalesce(m.assigned_to, m.created_by)
      where m.id = $1 and m.tenant_id = $2`,
    [matterId, tenantId]
  );
  if (!m) throw new Error('Matter not found.');
  const contacts = await query<{ email: string; name: string | null; role: string; phone: string | null; whatsapp_opt_in: boolean }>(
    `select email, name, role, phone, whatsapp_opt_in from matter_contact where matter_id = $1 and tenant_id = $2 order by last_seen_at desc`,
    [matterId, tenantId]
  ).catch(() => []);
  const client = contacts.find((c) => c.role === 'CLIENT') ?? null;
  // The other side is a RESOLVER (addendum): external firm or walled-off internal matter,
  // either way just a name and an email to write to.
  const cp = await resolveCounterparty(tenantId, matterId).catch(() => null);
  const other = cp?.email ? { email: cp.email, name: cp.name } : contacts.find((c) => c.role === 'OTHER_SIDE') ?? null;
  const agent = contacts.find((c) => c.role === 'AGENT') ?? null;
  const lender = contacts.find((c) => c.role === 'LENDER') ?? null;
  const firstName = (client?.name ?? m.buyer_names?.[0] ?? '').split(/\s+/)[0] || null;
  return {
    matterRef: m.matter_ref,
    propertyAddress: m.property_address,
    firmName: m.tenant_name,
    feeEarnerName: m.fee_name,
    feeEarnerUserId: m.assigned_to ?? m.created_by,
    clientFirstName: firstName,
    clientEmail: client?.email ?? null,
    clientPhone: client?.phone ?? null,
    clientWhatsAppOptIn: !!client?.whatsapp_opt_in,
    contacts: {
      ...(other ? { seller_solicitor: { email: other.email, name: other.name } } : {}),
      ...(agent ? { estate_agent: { email: agent.email, name: agent.name } } : {}),
      ...(lender ? { lender: { email: lender.email, name: lender.name } } : {}),
    },
    completionDate: m.completion_target_date,
  };
}

export function productionCommsDeps(): CommsDeps {
  const wa = whatsappClient();
  const resend = config.resendApiKey && config.resendFromEmail ? new Resend(config.resendApiKey) : null;
  const graphOk = missingFor('graph').length === 0;
  return {
    contactInfo,
    whatsapp: wa ? { sendText: (to, body) => wa.sendText(to, body) } : null,
    email: resend
      ? {
          send: async ({ to, subject, text }) => {
            const r = await resend.emails.send({ from: config.resendFromEmail!, to, subject, text });
            return { messageId: r.data?.id ?? null };
          },
        }
      : null,
    mailbox: graphOk
      ? {
          send: async (userId, to, subject, bodyHtml) => {
            await sendMail(userId, to, subject, bodyHtml);
            return { messageId: null };
          },
          draft: async (userId, to, subject, bodyHtml) => {
            const d = await createDraftMessage(userId, subject, bodyHtml, [to]);
            return { messageId: (d as { id?: string } | null)?.id ?? null };
          },
        }
      : null,
    log: async (i) => {
      await query(
        `insert into client_message (tenant_id, matter_id, direction, channel, address, template, body, provider_ref, status, guard) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [i.tenantId, i.matterId, i.direction, i.channel, i.address, i.template, i.body, i.providerRef, i.status, i.guard === undefined ? null : JSON.stringify(i.guard)]
      ).catch(() => {});
    },
    routeToHuman: async (i) => {
      if (!i.matterId) return;
      const m = await queryOne<{ assigned_to: string | null; created_by: string }>(`select assigned_to, created_by from matter where id = $1 and tenant_id = $2`, [i.matterId, i.tenantId]);
      const userId = m?.assigned_to ?? m?.created_by;
      if (!userId) return;
      await createTask({ userId, tenantId: i.tenantId, role: 'CONVEYANCER', email: '', displayName: null }, i.matterId, { type: 'TASK', detail: `${i.title} — ${i.detail}`, assigneeUserId: userId, source: 'ASSISTANT' }).catch(() => {});
      await emitMatterEvent({ tenantId: i.tenantId, matterId: i.matterId, eventType: 'CLIENT_QUESTION_ROUTED', title: i.title, details: i.detail, notify: { kind: 'EMAIL_TRIAGED', headline: i.title, did: 'Sent the client a holding reply', action: 'Reply to the client personally', dedupKey: `client-q:${i.fromAddress}` } });
    },
    matterForAddress: async (tenantId, address) => {
      const digits = address.replace(/[^\d]/g, '');
      const r = await queryOne<{ matter_id: string }>(
        `select c.matter_id from matter_contact c join matter m on m.id = c.matter_id
          where c.tenant_id = $1 and m.status = 'OPEN' and c.role = 'CLIENT' and regexp_replace(coalesce(c.phone,''), '[^0-9]', '', 'g') like '%' || right($2, 10)
          order by c.last_seen_at desc limit 1`,
        [tenantId, digits]
      ).catch(() => null);
      return r ? { matterId: r.matter_id } : null;
    },
    tenantForAddress: async (address) => {
      const digits = address.replace(/[^\d]/g, '');
      const r = await queryOne<{ tenant_id: string }>(
        `select tenant_id from matter_contact where role = 'CLIENT' and regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g') like '%' || right($1, 10) order by last_seen_at desc limit 1`,
        [digits]
      ).catch(() => null);
      return r?.tenant_id ?? null;
    },
    chaseMode: config.chaseMode,
    briefFor,
    onChaseDrafted: async (i) => {
      await addDraftReady({ tenantId: i.tenantId, matterId: i.matterId, dedupKey: `chase:${i.messageId ?? i.title}`, title: i.title, detail: i.detail, graphMessageId: i.messageId ?? undefined }).catch(() => {});
    },
  };
}

/**
 * The engine's account of a matter, for answering a client's "any update?" from the case
 * itself rather than from a leaflet. Imported at call time because engine/adapters.ts
 * already imports this module for its comms ports.
 */
async function briefFor(tenantId: string, matterId: string) {
  try {
    const [{ engine }, { caseBrief }] = await Promise.all([import('../engine/adapters'), import('../engine/brief')]);
    const state = await engine().getState(tenantId, matterId);
    return state.enrolled ? caseBrief(state) : null;
  } catch {
    return null; // not enrolled, or the engine is unavailable — fall back to the FAQ path
  }
}

export function commsConfigured(): boolean {
  return whatsappConfigured() || !!(config.resendApiKey && config.resendFromEmail) || missingFor('graph').length === 0;
}

let _deps: CommsDeps | null = null;
export function commsDeps(): CommsDeps {
  if (!_deps) _deps = productionCommsDeps();
  return _deps;
}
export const clientComms = () => new ProductionClientComms(commsDeps());
export const chaser = () => new ProductionChaser(commsDeps());
export const clientQa = () => new ClientQaService(commsDeps(), config.anthropicApiKey ? claudeLlm() : null, { model: config.engineQaModel });
