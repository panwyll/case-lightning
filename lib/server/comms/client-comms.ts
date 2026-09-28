/**
 * Component #5 — client comms, wired to the engine ports.
 *
 *   ProductionClientComms  status updates (safe to automate) + sending the approved
 *                          report on title. WhatsApp when the client has opted in and
 *                          it is configured; email otherwise (Resend, or the fee-earner's
 *                          mailbox via Graph). Every message is logged in client_message.
 *   ProductionChaser       template chases to third parties from the fee-earner's
 *                          mailbox. ENGINE_CHASE_MODE=draft (default) leaves an Outlook
 *                          draft + worklist item; =send sends it.
 *   ClientQaService        inbound client questions: hard guard → FAQ → constrained
 *                          rephrase → validated → reply; anything else goes to a person
 *                          with a holding reply. Never answers about THIS transaction.
 *
 * The persistence and mail/whatsapp sending are behind small interfaces so the whole
 * layer is unit-tested with fakes.
 */
import { messageProblem } from './templates';
import { z } from 'zod/v4';
import type { ClientComms, DocumentRef, ThirdPartyChaser } from '../engine/ports';
import type { StructuredLlm } from '../engine/llm';
import { ACKS, CHASES, CLIENT_UPDATES, PARTY_NOTICES, SEARCH_NAMES, render, type Template } from './templates';
import { classifyClientQuestion, FAQ, validateFaqReply, type FaqEntry, isStatusQuestion } from './guard';
import { clientStatusAnswer, type CaseBrief } from '../engine/brief';

// ───────────────────────────── dependencies ─────────────────────────────

export interface MatterContactInfo {
  matterRef: string;
  propertyAddress: string;
  firmName: string;
  feeEarnerName: string | null;
  feeEarnerUserId: string | null;
  clientFirstName: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  clientWhatsAppOptIn: boolean;
  /** Third parties by role, for chases. */
  contacts: Partial<Record<'seller_solicitor' | 'estate_agent' | 'lender', { email: string; name: string | null }>>;
  completionDate: string | null;
}

export interface CommsDeps {
  contactInfo(tenantId: string, matterId: string): Promise<MatterContactInfo>;
  whatsapp: { sendText(to: string, body: string): Promise<{ messageId: string | null }> } | null;
  email: { send(input: { to: string; subject: string; text: string; fromUserId?: string | null }): Promise<{ messageId: string | null }> } | null;
  /** Fee-earner mailbox: send now, or create a draft (returns the draft/message id). */
  mailbox: { send(userId: string, to: string, subject: string, bodyHtml: string): Promise<{ messageId: string | null }>; draft(userId: string, to: string, subject: string, bodyHtml: string): Promise<{ messageId: string | null }> } | null;
  log(input: { tenantId: string; matterId: string | null; direction: 'OUT' | 'IN'; channel: string; address: string | null; template: string | null; subject?: string | null; body: string; providerRef: string | null; status: string; guard?: unknown }): Promise<void>;
  /** Put something in front of a person (a task + notification on the matter). */
  routeToHuman(input: { tenantId: string; matterId: string | null; title: string; detail: string; fromAddress: string }): Promise<void>;
  /** Find the matter a client address belongs to (inbound). */
  matterForAddress(tenantId: string, address: string): Promise<{ matterId: string } | null>;
  /** Tenant for an inbound address when the webhook is shared across firms. */
  tenantForAddress(address: string): Promise<string | null>;
  chaseMode: 'draft' | 'send';
  /** The firm's own wording for a built-in template (Email Templates, by key); null = use the built-in. */
  templateOverride?(tenantId: string, key: string): Promise<{ subject: string; body: string } | null>;
  /** Acknowledgements go out at once or not at all; a drafted one defeats its purpose. */
  ackMode?: 'send' | 'off';
  /** The engine's account of a matter, for answering "any update?" from the case itself. */
  briefFor?(tenantId: string, matterId: string): Promise<CaseBrief | null>;
  onChaseDrafted?(input: { tenantId: string; matterId: string; messageId: string | null; title: string; detail: string }): Promise<void>;
}

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
const toHtml = (text: string) => `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;

// ───────────────────────────── status updates ─────────────────────────────

/** The built-in template, unless the firm has rewritten it under Email Templates. */
async function resolveTemplate(deps: CommsDeps, tenantId: string, t: Template): Promise<Template> {
  const o = deps.templateOverride ? await deps.templateOverride(tenantId, t.key).catch(() => null) : null;
  return o ? { ...t, subject: o.subject || t.subject, body: o.body || t.body } : t;
}

/** A message exactly as it would go: who it is addressed to, on which channel, with the subject and body. Nothing sent, nothing logged. */
export interface MessagePreview { to: string; address: string | null; channel: 'whatsapp' | 'email' | 'draft' | 'none'; subject: string; body: string }

const clientAddress = (info: MatterContactInfo): { address: string | null; channel: MessagePreview['channel'] } =>
  info.clientPhone && info.clientWhatsAppOptIn ? { address: info.clientPhone, channel: 'whatsapp' } : info.clientEmail ? { address: info.clientEmail, channel: 'email' } : { address: null, channel: 'none' };
const clientLine = (info: MatterContactInfo): string => `${info.clientFirstName ? `${info.clientFirstName} (the client)` : 'the client'}${clientAddress(info).address ? ` · ${clientAddress(info).address}` : ' · no address on the case'}`;

/** The "where things stand" tail goes in before the sign-off, when there is one. */
const withOverview = (body: string, context: Record<string, unknown>): string => {
  const ov = typeof context.overview === 'string' ? context.overview.trim() : '';
  if (!ov) return body;
  const cut = body.lastIndexOf('\n\n');
  return cut > 0 ? `${body.slice(0, cut)}\n\n${ov}${body.slice(cut)}` : `${body}\n\n${ov}`;
};

export class ProductionClientComms implements ClientComms {
  readonly name = 'client-comms';
  constructor(private deps: CommsDeps) {}

  private vars(info: MatterContactInfo, context: Record<string, unknown>): Record<string, string> {
    const payload = (context.payload ?? {}) as Record<string, unknown>;
    const searchType = typeof payload.searchType === 'string' ? payload.searchType : '';
    // Every string the engine put in the context is a variable (a progress update's done / doneLine / status / next / targetNote); the named ones below take precedence.
    const fromContext = Object.fromEntries(Object.entries(context).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    return {
      ...fromContext,
      firstName: info.clientFirstName ?? 'there',
      property: info.propertyAddress,
      firmName: info.feeEarnerName && info.feeEarnerName.trim().toLowerCase() === (info.firmName ?? '').trim().toLowerCase() ? '' : info.firmName,
      feeEarner: info.feeEarnerName ?? info.firmName,
      searchName: SEARCH_NAMES[searchType] ?? 'search',
      searchList: (Array.isArray(context.searches) ? (context.searches as string[]) : Array.isArray(payload.requiredSearches) ? (payload.requiredSearches as string[]) : null)?.map((s) => SEARCH_NAMES[s] ?? s).join(', ') ?? 'local authority, drainage & water and environmental',
      completionDate: typeof payload.completionDate === 'string' ? payload.completionDate : info.completionDate ?? 'the agreed date',
      transaction: typeof context.transaction === 'string' ? context.transaction : 'purchase',
      waitingOn: typeof context.waitingOn === 'string' ? context.waitingOn : '',
      waitingFor: typeof context.waitingFor === 'string' ? context.waitingFor : '',
      nextChaseNote: typeof context.nextChase === 'string' && context.nextChase ? ` and will chase again on ${context.nextChase} if we have not heard` : ' and will keep following it up',
      formUrl: typeof context.formUrl === 'string' ? context.formUrl : '',
      noteToClient: typeof context.noteToClient === 'string' ? context.noteToClient : '',
    };
  }

  /** Channel choice: WhatsApp only with explicit opt-in; else email; else nothing to send to. */
  private async deliver(tenantId: string, matterId: string, info: MatterContactInfo, template: string, subject: string, body: string): Promise<{ channel: 'whatsapp' | 'email' | 'mock'; messageId: string | null; address: string | null }> {
    if (info.clientPhone && info.clientWhatsAppOptIn && this.deps.whatsapp) {
      try {
        const r = await this.deps.whatsapp.sendText(info.clientPhone, body);
        await this.deps.log({ tenantId, matterId, direction: 'OUT', channel: 'whatsapp', address: info.clientPhone, template, subject, body, providerRef: r.messageId, status: 'SENT' });
        return { channel: 'whatsapp', messageId: r.messageId, address: info.clientPhone };
      } catch (err) {
        await this.deps.log({ tenantId, matterId, direction: 'OUT', channel: 'whatsapp', address: info.clientPhone, template, subject, body, providerRef: null, status: `FAILED: ${(err as Error).message}` });
      }
    }
    if (info.clientEmail) {
      // The client hears from their conveyancer: the fee earner's own mailbox first. A transactional sender is only the
      // fallback when no mailbox is connected, and it says so on the record.
      if (this.deps.mailbox && info.feeEarnerUserId) {
        try {
          const r = await this.deps.mailbox.send(info.feeEarnerUserId, info.clientEmail, subject, toHtml(body));
          await this.deps.log({ tenantId, matterId, direction: 'OUT', channel: 'email', address: info.clientEmail, template, subject, body, providerRef: r.messageId, status: 'SENT' });
          return { channel: 'email', messageId: r.messageId, address: info.clientEmail };
        } catch (err) {
          if (!this.deps.email) throw err;
          await this.deps.log({ tenantId, matterId, direction: 'OUT', channel: 'email', address: info.clientEmail, template, subject, body, providerRef: null, status: `FAILED: mailbox — ${(err as Error).message}; falling back to the transactional sender` });
        }
      }
      if (this.deps.email) {
        const r = await this.deps.email.send({ to: info.clientEmail, subject, text: body, fromUserId: info.feeEarnerUserId });
        await this.deps.log({ tenantId, matterId, direction: 'OUT', channel: 'email', address: info.clientEmail, template, subject, body, providerRef: r.messageId, status: 'SENT' });
        return { channel: 'email', messageId: r.messageId, address: info.clientEmail };
      }
    }
    throw new Error('No client channel available (no opted-in WhatsApp number, no email address, or no sender configured).');
  }

  /** The status update exactly as sendStatusUpdate would send it. */
  async previewStatusUpdate(input: { tenantId: string; matterId: string; template: string; context: Record<string, unknown> }): Promise<MessagePreview> {
    const base = CLIENT_UPDATES[input.template];
    if (!base) throw new Error(`Unknown client update template ${input.template}`);
    const t = await resolveTemplate(this.deps, input.tenantId, base);
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const r = render(t, this.vars(info, input.context));
    return { to: clientLine(info), ...clientAddress(info), subject: r.subject, body: withOverview(r.body, input.context) };
  }

  async sendStatusUpdate(input: { tenantId: string; matterId: string; template: string; context: Record<string, unknown> }) {
    const base = CLIENT_UPDATES[input.template];
    if (!base) throw new Error(`Unknown client update template ${input.template}`);
    const t = await resolveTemplate(this.deps, input.tenantId, base);
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const r = render(t, this.vars(info, input.context));
    if (r.missing.length) throw new Error(`Template ${t.key} missing ${r.missing.join(', ')}`);
    { const why = messageProblem(r); if (why) throw new MessageHeldError(why); }
    return this.deliver(input.tenantId, input.matterId, info, t.key, r.subject, withOverview(r.body, input.context));
  }

  /** Only ever reached after the engine's approval invariant (assertCanSendReport). Email only — a report is a document, not a chat message. */
  async sendReportOnTitle(input: { tenantId: string; matterId: string; draftDocument: DocumentRef }) {
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const content = (input.draftDocument.extractedFacts as { content?: string } | null)?.content ?? '';
    if (!content) throw new Error('Report draft has no content to send.');
    if (!info.clientEmail) throw new Error('No client email address on the matter.');
    const subject = `Report on title — ${info.propertyAddress} (${info.matterRef})`;
    const body = `Hello ${info.clientFirstName ?? 'there'},\n\nPlease find your report on title below. Read it carefully and let ${info.feeEarnerName ?? 'us'} know if you have any questions before we exchange contracts.\n\n${content}\n\n${info.firmName}`;
    let r: { messageId: string | null };
    if (this.deps.mailbox && info.feeEarnerUserId) r = await this.deps.mailbox.send(info.feeEarnerUserId, info.clientEmail, subject, toHtml(body));
    else if (this.deps.email) r = await this.deps.email.send({ to: info.clientEmail, subject, text: body, fromUserId: info.feeEarnerUserId });
    else throw new Error('No email sender configured.');
    await this.deps.log({ tenantId: input.tenantId, matterId: input.matterId, direction: 'OUT', channel: 'email', address: info.clientEmail, template: 'report_on_title', subject, body: subject, providerRef: r.messageId, status: 'SENT' });
    return { channel: 'email', messageId: r.messageId, address: info.clientEmail };
  }
}

// ───────────────────────────── third-party chases ─────────────────────────────

export class ProductionChaser implements ThirdPartyChaser {
  readonly name = 'chaser';
  constructor(private deps: CommsDeps) {}

  private chaseVars(info: MatterContactInfo, ctx: Record<string, unknown>): Record<string, string> {
    const subject = typeof ctx.subject === 'string' ? ctx.subject : '';
    const prior = Number(ctx.priorChases ?? 0);
    return {
      matterRef: info.matterRef,
      address: info.propertyAddress,
      property: info.propertyAddress,
      firstName: info.clientFirstName ?? 'there',
      firmName: info.feeEarnerName && info.feeEarnerName.trim().toLowerCase() === (info.firmName ?? '').trim().toLowerCase() ? '' : info.firmName,
      feeEarner: info.feeEarnerName ?? info.firmName,
      searchName: SEARCH_NAMES[subject] ?? subject,
      orderedDate: typeof ctx.openedAt === 'string' ? ctx.openedAt.slice(0, 10) : '',
      ageWorkingDays: String(ctx.ageWorkingDays ?? ''),
      priorChaseNote: prior > 0 ? ` and despite ${prior} previous reminder${prior === 1 ? '' : 's'}` : '',
      completionDate: info.completionDate ?? '',
    };
  }

  /** Who a chase to this role goes to, as a line for a person, with the address the send would use. */
  private recipient(info: MatterContactInfo, role: string): { to: string; address: string | null; channel: MessagePreview['channel'] } {
    if (role === 'client' || role === 'id_provider') return { to: clientLine(info), ...clientAddress(info) };
    const key = role === 'seller_solicitor' ? 'seller_solicitor' : role === 'lender' ? 'lender' : null;
    const c = key ? info.contacts[key] : null;
    const label = role.replace(/_/g, ' ');
    if (!c?.email) return { to: `the ${label} · no address on the case`, address: null, channel: 'none' };
    return { to: `${c.name ? `${c.name} (${label})` : `the ${label}`} · ${c.email}`, address: c.email, channel: this.deps.chaseMode === 'send' ? 'email' : 'draft' };
  }

  /** The chase exactly as sendChase would send it. */
  async previewChase(input: { tenantId: string; matterId: string; recipientRole: string; template: string; context: Record<string, unknown> }): Promise<MessagePreview> {
    const baseChase = CHASES[input.template];
    if (!baseChase) throw new Error(`Unknown chase template ${input.template}`);
    const t = await resolveTemplate(this.deps, input.tenantId, baseChase);
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const r = render(t, this.chaseVars(info, input.context));
    return { ...this.recipient(info, input.recipientRole), subject: r.subject, body: r.body };
  }

  /** The acknowledgement exactly as sendAcknowledgement would send it. */
  async previewAcknowledgement(input: { tenantId: string; matterId: string; recipientRole: string; what: string }): Promise<MessagePreview> {
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const vars = { matterRef: info.matterRef, address: info.propertyAddress, property: info.propertyAddress, firstName: info.clientFirstName ?? 'there', firmName: info.firmName, feeEarner: info.feeEarnerName ?? info.firmName, what: input.what };
    const r = render(await resolveTemplate(this.deps, input.tenantId, input.recipientRole === 'client' ? ACKS.ack_client : ACKS.ack_counterparty), vars);
    const who = this.recipient(info, input.recipientRole === 'client' ? 'client' : 'seller_solicitor');
    return { ...who, channel: who.channel === 'draft' ? 'email' : who.channel, subject: r.subject, body: r.body };
  }

  async sendChase(input: { tenantId: string; matterId: string; recipientRole: 'seller_solicitor' | 'search_provider' | 'lender' | 'client' | 'id_provider' | 'hmlr'; template: string; context: Record<string, unknown> }) {
    const baseChase = CHASES[input.template];
    if (!baseChase) throw new Error(`Unknown chase template ${input.template}`);
    const t = await resolveTemplate(this.deps, input.tenantId, baseChase);
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const r = render(t, this.chaseVars(info, input.context));
    if (r.missing.length) throw new Error(`Chase template ${t.key} missing ${r.missing.join(', ')}`);
    { const why = messageProblem(r); if (why) throw new MessageHeldError(why); }

    // The client's own chase (ID documents) goes down the client channel.
    if (input.recipientRole === 'client' || input.recipientRole === 'id_provider') {
      const comms = new ProductionClientComms(this.deps);
      const sent = await comms['deliver'](input.tenantId, input.matterId, info, t.key, r.subject, r.body);
      return { channel: sent.channel, messageId: sent.messageId };
    }

    const roleKey = input.recipientRole === 'seller_solicitor' ? 'seller_solicitor' : input.recipientRole === 'lender' ? 'lender' : null;
    const to = roleKey ? info.contacts[roleKey]?.email ?? null : null;
    if (!to) throw new Error(`No ${input.recipientRole.replace('_', ' ')} email address on the matter — add the contact to chase automatically.`);
    if (!this.deps.mailbox || !info.feeEarnerUserId) throw new Error('No fee-earner mailbox to send the chase from.');

    if (this.deps.chaseMode === 'send') {
      const sent = await this.deps.mailbox.send(info.feeEarnerUserId, to, r.subject, toHtml(r.body));
      await this.deps.log({ tenantId: input.tenantId, matterId: input.matterId, direction: 'OUT', channel: 'email', address: to, template: t.key, subject: r.subject, body: r.body, providerRef: sent.messageId, status: 'SENT' });
      return { channel: 'email' as const, messageId: sent.messageId };
    }
    const draft = await this.deps.mailbox.draft(info.feeEarnerUserId, to, r.subject, toHtml(r.body));
    await this.deps.log({ tenantId: input.tenantId, matterId: input.matterId, direction: 'OUT', channel: 'email', address: to, template: t.key, subject: r.subject, body: r.body, providerRef: draft.messageId, status: 'DRAFTED' });
    await this.deps.onChaseDrafted?.({ tenantId: input.tenantId, matterId: input.matterId, messageId: draft.messageId, title: `Chase drafted: ${r.subject}`, detail: `To ${to} — open Drafts to send.` });
    return { channel: 'email' as const, messageId: draft.messageId };
  }

  async sendPartyNotice(input: { tenantId: string; matterId: string; recipientRole: 'estate_agent' | 'lender'; template: string; context: Record<string, unknown> }) {
    const baseNotice = PARTY_NOTICES[input.template];
    if (!baseNotice) throw new Error(`Unknown notice template ${input.template}`);
    const t = await resolveTemplate(this.deps, input.tenantId, baseNotice);
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const agent = input.recipientRole === 'lender' ? info.contacts.lender : info.contacts.estate_agent;
    if (!agent?.email || !this.deps.mailbox || !info.feeEarnerUserId) return null;
    const ctx = input.context;
    const vars = {
      matterRef: info.matterRef, address: info.propertyAddress, firmName: info.firmName, feeEarner: info.feeEarnerName ?? info.firmName,
      agentName: agent.name || 'Sirs',
      quote: typeof ctx.quote === 'string' ? ctx.quote : '',
      waitingOn: typeof ctx.waitingOn === 'string' ? ctx.waitingOn : '', waitingFor: typeof ctx.waitingFor === 'string' ? ctx.waitingFor : '',
      nextChaseNote: typeof ctx.nextChase === 'string' && ctx.nextChase ? ` and will chase again on ${ctx.nextChase} if we have not heard` : ' and will keep following it up',
    };
    const r = render(t, vars);
    if (r.missing.length) throw new Error(`Notice template ${t.key} missing ${r.missing.join(', ')}`);
    { const why = messageProblem(r); if (why) throw new MessageHeldError(why); }
    const sent = await this.deps.mailbox.send(info.feeEarnerUserId, agent.email, r.subject, toHtml(r.body));
    await this.deps.log({ tenantId: input.tenantId, matterId: input.matterId, direction: 'OUT', channel: 'email', address: agent.email, template: t.key, subject: r.subject, body: r.body, providerRef: sent.messageId, status: 'SENT' });
    return { channel: 'email' as const, messageId: sent.messageId };
  }

  async sendAcknowledgement(input: { tenantId: string; matterId: string; recipientRole: 'seller_solicitor' | 'client'; what: string; forEventType: string }) {
    if (this.deps.ackMode === 'off') return null;
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const vars = { matterRef: info.matterRef, address: info.propertyAddress, property: info.propertyAddress, firstName: info.clientFirstName ?? 'there', firmName: info.firmName, feeEarner: info.feeEarnerName ?? info.firmName, what: input.what };
    if (input.recipientRole === 'client') {
      const r = render(await resolveTemplate(this.deps, input.tenantId, ACKS.ack_client), vars);
      if (r.missing.length) throw new Error(`Acknowledgement template missing ${r.missing.join(', ')}`);
      if (!info.clientEmail && !(info.clientPhone && info.clientWhatsAppOptIn)) return null;
      const sent = await new ProductionClientComms(this.deps)['deliver'](input.tenantId, input.matterId, info, ACKS.ack_client.key, r.subject, r.body);
      return { channel: sent.channel, messageId: sent.messageId };
    }
    const to = info.contacts.seller_solicitor?.email ?? null;
    if (!to || !this.deps.mailbox || !info.feeEarnerUserId) return null;
    const r = render(await resolveTemplate(this.deps, input.tenantId, ACKS.ack_counterparty), vars);
    if (r.missing.length) throw new Error(`Acknowledgement template missing ${r.missing.join(', ')}`);
    const sent = await this.deps.mailbox.send(info.feeEarnerUserId, to, r.subject, toHtml(r.body));
    await this.deps.log({ tenantId: input.tenantId, matterId: input.matterId, direction: 'OUT', channel: 'email', address: to, template: ACKS.ack_counterparty.key, subject: r.subject, body: r.body, providerRef: sent.messageId, status: 'SENT' });
    return { channel: 'email' as const, messageId: sent.messageId };
  }
}

// ───────────────────────────── guarded client Q&A ─────────────────────────────

const RephraseSchema = z.object({ reply: z.string().describe('The FAQ answer, rephrased warmly in 2–5 sentences for a WhatsApp/email reply. No new facts.') });

export interface QaOutcome {
  verdict: 'ANSWERED' | 'ROUTED_TO_HUMAN';
  reply: string;
  faqId: string | null;
  reasons: string[];
  /** Where the answer came from: the static FAQ, or this matter's own state. */
  source?: 'faq' | 'case_status';
}

export class ClientQaService {
  constructor(
    private deps: CommsDeps,
    private llm: StructuredLlm | null,
    private opts: { model: string } = { model: 'claude-opus-5' }
  ) {}

  /** Answer or route. Always returns the reply text that was (or should be) sent back. */
  async handle(input: { tenantId: string; matterId: string | null; fromAddress: string; channel: 'whatsapp' | 'email'; text: string }): Promise<QaOutcome> {
    const verdict = classifyClientQuestion(input.text);
    const guardLog = { verdict: verdict.verdict, reasons: 'reasons' in verdict ? verdict.reasons : [], faqId: 'faqId' in verdict ? verdict.faqId : null };
    await this.deps.log({ tenantId: input.tenantId, matterId: input.matterId, direction: 'IN', channel: input.channel, address: input.fromAddress, template: null, body: input.text, providerRef: null, status: verdict.verdict === 'ALLOW' ? 'ANSWERED' : 'ROUTED_TO_HUMAN', guard: guardLog });

    // "Any update?" deserves this matter's actual state, not a leaflet — but only when the
    // engine says a machine may answer at all. Anything with a live legal problem on it
    // goes to a person, because a cheerful automated summary would be the wrong reply.
    if (verdict.verdict !== 'BLOCK' && isStatusQuestion(input.text) && input.matterId && this.deps.briefFor) {
      const brief = await this.deps.briefFor(input.tenantId, input.matterId).catch(() => null);
      const status = brief ? clientStatusAnswer(brief) : null;
      if (status?.canAnswer) {
        return { verdict: 'ANSWERED', reply: status.text, faqId: 'case_status', reasons: [], source: 'case_status' };
      }
      if (brief) {
        const info = await this.deps.contactInfo(input.tenantId, input.matterId).catch(() => null);
        const holding = render(CLIENT_UPDATES.qa_routed_to_human, { feeEarner: info?.feeEarnerName ?? 'your conveyancer' }).body;
        await this.deps.routeToHuman({
          tenantId: input.tenantId,
          matterId: input.matterId,
          title: 'Client asked for an update — needs a person',
          detail: `The client asked: "${input.text.slice(0, 300)}". The engine would not answer automatically because ${status?.canAnswer === false ? status.reason : 'the case brief was unavailable'}.`,
          fromAddress: input.fromAddress,
        });
        return { verdict: 'ROUTED_TO_HUMAN', reply: holding, faqId: null, reasons: [status?.canAnswer === false ? status.reason : 'no brief'] };
      }
    }

    if (verdict.verdict !== 'ALLOW') {
      const info = input.matterId ? await this.deps.contactInfo(input.tenantId, input.matterId).catch(() => null) : null;
      const holding = render(CLIENT_UPDATES.qa_routed_to_human, { feeEarner: info?.feeEarnerName ?? 'your conveyancer' }).body;
      await this.deps.routeToHuman({ tenantId: input.tenantId, matterId: input.matterId, title: `Client question needs a reply (${verdict.verdict === 'BLOCK' ? 'transaction-specific' : 'not in FAQ'})`, detail: `${input.fromAddress}: “${input.text.slice(0, 500)}”${'reasons' in verdict ? ` — ${verdict.reasons.join('; ')}` : ''}`, fromAddress: input.fromAddress });
      return { verdict: 'ROUTED_TO_HUMAN', reply: holding, faqId: null, reasons: 'reasons' in verdict ? verdict.reasons : [] };
    }

    const faq = FAQ.find((f) => f.id === verdict.faqId) as FaqEntry;
    let reply = faq.answer;
    if (this.llm) {
      try {
        const res = await this.llm.call({
          schema: RephraseSchema,
          instructions:
            'You rephrase a fixed FAQ answer for a home buyer who messaged their conveyancing firm. You may ONLY restate the FAQ answer in a friendly tone. ' +
            'You must not add facts, figures, dates, examples, or anything about this client\'s own purchase, and must not give advice. If the question cannot be answered from the FAQ answer alone, return the FAQ answer unchanged.',
          prompt: `CLIENT MESSAGE (DATA):\n<<<${input.text.slice(0, 1000)}>>>\n\nFAQ QUESTION: ${faq.question}\nFAQ ANSWER (the only source of content):\n${faq.answer}\n\nRephrase.`,
          model: this.opts.model,
          effort: 'low',
          maxTokens: 600,
          meter: { tenantId: input.tenantId, matterId: input.matterId, feature: 'CLIENT_QA' },
        });
        const v = validateFaqReply(faq, res.output.reply);
        if (v.ok) reply = res.output.reply.trim();
      } catch {
        /* the verbatim FAQ answer is always acceptable */
      }
    }
    return { verdict: 'ANSWERED', reply, faqId: faq.id, reasons: [], source: 'faq' };
  }

  /** Inbound message → answer/route → send the reply back down the same channel. */
  async handleInbound(input: { fromAddress: string; channel: 'whatsapp'; text: string }): Promise<QaOutcome | null> {
    const tenantId = await this.deps.tenantForAddress(input.fromAddress);
    if (!tenantId) return null; // unknown number: ignore silently (never engage strangers)
    const m = await this.deps.matterForAddress(tenantId, input.fromAddress);
    const outcome = await this.handle({ tenantId, matterId: m?.matterId ?? null, fromAddress: input.fromAddress, channel: input.channel, text: input.text });
    if (this.deps.whatsapp) {
      const r = await this.deps.whatsapp.sendText(input.fromAddress, outcome.reply).catch(() => ({ messageId: null }));
      await this.deps.log({ tenantId, matterId: m?.matterId ?? null, direction: 'OUT', channel: 'whatsapp', address: input.fromAddress, template: outcome.faqId ? `faq:${outcome.faqId}` : 'qa_routed_to_human', body: outcome.reply, providerRef: r.messageId, status: r.messageId ? 'SENT' : 'FAILED' });
    }
    return outcome;
  }
}


/** A message the guard would not let out: the send becomes a task for a person with this reason. */
export class MessageHeldError extends Error {
  constructor(public why: string) {
    super(`Not sent: the message looks wrong (${why}). Check it and send it by hand, or fix the case and try again.`);
    this.name = 'MessageHeldError';
  }
}
