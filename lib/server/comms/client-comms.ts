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
import { linkify, signedHtml, signedText, type Signature } from '../signature';
import { z } from 'zod/v4';
import type { ClientComms, DocumentRef, ThirdPartyChaser } from '../engine/ports';
import type { StructuredLlm } from '../engine/llm';
import { ACKS, CHASES, CLIENT_UPDATES, PARTY_NOTICES, SEARCH_NAMES, forTransaction, render, type Template } from './templates';
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
  /** Every client on the case with an email address (joint buyers, co-owners): client emails go to all of them. */
  clientEmails?: string[];
  /** What kind of case, for the words: purchase, sale, remortgage or transfer (of equity). */
  transaction?: 'purchase' | 'sale' | 'remortgage' | 'transfer';
  clientPhone: string | null;
  clientWhatsAppOptIn: boolean;
  /** Third parties by role, for chases. */
  contacts: Partial<Record<'seller_solicitor' | 'estate_agent' | 'lender', { email: string; name: string | null }>>;
  completionDate: string | null;
  /** Lines under the signature: address, phone, SRA status (empty until the firm sets them). */
  footer?: string;
  /** The fee earner's email signature over the firm's details (lib/server/signature.ts). */
  signature?: Signature | null;
}

/** A person's edit replaces the template's words; the guard still reads what actually goes. */
function applyOverride<R extends { subject: string; body: string; missing: string[] }>(r: R, o?: { subject?: string | null; body?: string | null } | null): R {
  if (!o || (!o.subject?.trim() && !o.body?.trim())) return r;
  return { ...r, subject: o.subject?.trim() || r.subject, body: o.body?.trim() || r.body, missing: [] };
}

/** The firm's footer under the signature, once: a template the firm edited may already carry it. */
function withFooter(body: string, info: MatterContactInfo): string {
  const f = info.footer?.trim();
  if (!f || body.includes(f.split('\n')[0])) return body;
  return `${body.trimEnd()}\n\n${f}`;
}

/** A file sent with an email (the report on title as a Word document). */
export interface MailAttachment { name: string; bytes: Buffer; contentType: string }

export interface CommsDeps {
  /** The approved report on title as the firm's Word document (their Doc Packs template), and kept on the case. */
  renderReport?(tenantId: string, matterId: string, body: string): Promise<{ bytes: Buffer; fileName: string }>;
  contactInfo(tenantId: string, matterId: string): Promise<MatterContactInfo>;
  whatsapp: { sendText(to: string, body: string): Promise<{ messageId: string | null }> } | null;
  email: { send(input: { to: string | string[]; subject: string; text: string; fromUserId?: string | null; attachments?: MailAttachment[] }): Promise<{ messageId: string | null }> } | null;
  /** Fee-earner mailbox: send now, or create a draft (returns the draft/message id). */
  mailbox: { send(userId: string, to: string | string[], subject: string, bodyHtml: string, attachments?: MailAttachment[]): Promise<{ messageId: string | null }>; draft(userId: string, to: string, subject: string, bodyHtml: string): Promise<{ messageId: string | null }> } | null;
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
  /** The case's client portal link (made the first time it is needed); it goes at the foot of every message to the client. */
  portalLink?(tenantId: string, matterId: string): Promise<string | null>;
  /** Whether the firm asks clients how we did (the exchange and completion messages then ask, linking to the portal's rating). */
  surveysOn?(tenantId: string): Promise<boolean>;
  /** The engine's account of a matter, for answering "any update?" from the case itself. */
  briefFor?(tenantId: string, matterId: string): Promise<CaseBrief | null>;
  onChaseDrafted?(input: { tenantId: string; matterId: string; messageId: string | null; title: string; detail: string }): Promise<void>;
}

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
const toHtml = (text: string) => `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5">${linkify(escapeHtml(text)).replace(/\n/g, '<br>')}</div>`;
/** An email as it goes: signed with the fee earner's signature (Graph sends carry no Outlook signature), or with the plain firm footer when none was built. */
/** A secure link to files, as it reads in the email: the files by name, the link, and how it opens. */
export interface FileLink { url: string; files: string[] }
export const fileLinkBlock = (l: FileLink): string => `${l.files.length === 1 ? l.files[0] : l.files.map((f) => `• ${f}`).join('\n')}\n${l.url}\n(The link asks for a code, which we email to you when you open it.)`;
const emailHtml = (text: string, info: MatterContactInfo): string => (info.signature ? signedHtml(text, info.signature) : toHtml(withFooter(text, info)));
const emailText = (text: string, info: MatterContactInfo): string => (info.signature ? signedText(text, info.signature) : withFooter(text, info));

// ───────────────────────────── status updates ─────────────────────────────

/** The built-in template, unless the firm has rewritten it under Email Templates. */
async function resolveTemplate(deps: CommsDeps, tenantId: string, t: Template): Promise<Template> {
  const o = deps.templateOverride ? await deps.templateOverride(tenantId, t.key).catch(() => null) : null;
  if (!o) return t;
  // A field the firm's version uses that the built-in does not (an older version's {{status}}) is not filled by anything:
  // it is required, so the message is held with the reason instead of going out with a blank.
  const fields = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  const builtIn = new Set([...fields(t.subject), ...fields(t.body)]);
  const own = [...new Set([...fields(o.subject || ''), ...fields(o.body || '')])].filter((f) => !builtIn.has(f));
  return { ...t, subject: o.subject || t.subject, body: o.body || t.body, requires: [...new Set([...t.requires, ...own])] };
}

/** A message exactly as it would go: who it is addressed to, on which channel, with the subject and body. Nothing sent, nothing logged. */
export interface MessagePreview { to: string; address: string | null; channel: 'whatsapp' | 'email' | 'draft' | 'none'; subject: string; body: string }

/** Who a client email goes to: every client with an address, the first client when only that is known. */
export const clientRecipients = (info: MatterContactInfo): string[] => (info.clientEmails?.length ? info.clientEmails : info.clientEmail ? [info.clientEmail] : []);
const clientAddress = (info: MatterContactInfo): { address: string | null; channel: MessagePreview['channel'] } =>
  info.clientPhone && info.clientWhatsAppOptIn ? { address: info.clientPhone, channel: 'whatsapp' } : clientRecipients(info).length ? { address: clientRecipients(info).join(', '), channel: 'email' } : { address: null, channel: 'none' };
const clientLine = (info: MatterContactInfo): string => `${info.clientFirstName ? `${info.clientFirstName} (the client)` : 'the client'}${clientAddress(info).address ? ` · ${clientAddress(info).address}` : ' · no address on the case'}`;

/** The "where things stand" tail goes in before the sign-off, when there is one. */
const withOverview = (body: string, context: Record<string, unknown>): string => {
  const ov = typeof context.overview === 'string' ? context.overview.trim() : '';
  if (!ov) return body;
  const cut = body.lastIndexOf('\n\n');
  return cut > 0 ? `${body.slice(0, cut)}\n\n${ov}${body.slice(cut)}` : `${body}\n\n${ov}`;
};

/** The portal line goes in before the sign-off (a short last paragraph), or at the end. */
export const PORTAL_LINE = 'See where things stand, what we need from you and your documents at any time:';
/** The messages that ask for a rating: the client's exchange and completion updates, whatever the kind of case. */
const SURVEY_ASK = /^(exchanged|completed)(__\w+)?$/;
export const SURVEY_LINE = { exchanged: 'How are we doing so far? Tell us in one tap:', completed: 'How did we do? One question, and it helps us a lot:' };
export function withPortal(body: string, url: string, lead: string = PORTAL_LINE): string {
  const line = `${lead}\n${url}`;
  const cut = body.trimEnd().lastIndexOf('\n\n');
  const last = cut > 0 ? body.trimEnd().slice(cut + 2) : '';
  return cut > 0 && last.length <= 60 && !/https?:\/\//.test(last) ? `${body.trimEnd().slice(0, cut)}\n\n${line}\n\n${last}` : `${body.trimEnd()}\n\n${line}`;
}

export class ProductionClientComms implements ClientComms {
  readonly name = 'client-comms';
  constructor(private deps: CommsDeps) {}

  /** The variables a client message fills from (public for the template preview). */
  vars(info: MatterContactInfo, context: Record<string, unknown>): Record<string, string> {
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
      transaction: typeof context.transaction === 'string' ? context.transaction : (info.transaction === 'transfer' ? 'transfer of equity' : info.transaction ?? 'purchase'),
      waitingOn: typeof context.waitingOn === 'string' ? context.waitingOn : '',
      waitingFor: typeof context.waitingFor === 'string' ? context.waitingFor : '',
      nextChaseNote: typeof context.nextChase === 'string' && context.nextChase ? ` and will chase again on ${context.nextChase} if we have not heard` : ' and will keep following it up',
      formUrl: typeof context.formUrl === 'string' ? context.formUrl : '',
      noteToClient: typeof context.noteToClient === 'string' ? context.noteToClient : '',
    };
  }

  /** Channel choice: WhatsApp only with explicit opt-in; else email; else nothing to send to. */
  private async deliver(tenantId: string, matterId: string, info: MatterContactInfo, template: string, subject: string, text: string, attachments: MailAttachment[] = []): Promise<{ channel: 'whatsapp' | 'email' | 'mock'; messageId: string | null; address: string | null }> {
    // Every message to the client carries their portal: where things stand, what we need, their documents.
    const portal = this.deps.portalLink ? await this.deps.portalLink(tenantId, matterId).catch(() => null) : null;
    // The exchange and completion messages (every kind of case) ask how we did, with the link to the one-tap rating.
    const ask = portal && SURVEY_ASK.test(template) && this.deps.surveysOn ? await this.deps.surveysOn(tenantId).catch(() => false) : false;
    const body = portal && !text.includes(portal) ? withPortal(text, portal, ask ? (template.startsWith('completed') ? SURVEY_LINE.completed : SURVEY_LINE.exchanged) : undefined) : text;
    if (info.clientPhone && info.clientWhatsAppOptIn && this.deps.whatsapp) {
      try {
        const r = await this.deps.whatsapp.sendText(info.clientPhone, body);
        await this.deps.log({ tenantId, matterId, direction: 'OUT', channel: 'whatsapp', address: info.clientPhone, template, subject, body, providerRef: r.messageId, status: 'SENT' });
        return { channel: 'whatsapp', messageId: r.messageId, address: info.clientPhone };
      } catch (err) {
        await this.deps.log({ tenantId, matterId, direction: 'OUT', channel: 'whatsapp', address: info.clientPhone, template, subject, body, providerRef: null, status: `FAILED: ${(err as Error).message}` });
      }
    }
    const to = clientRecipients(info);
    const address = to.join(', ');
    if (to.length) {
      // The client hears from their conveyancer: the fee earner's own mailbox first. A transactional sender is only the
      // fallback when no mailbox is connected, and it says so on the record.
      if (this.deps.mailbox && info.feeEarnerUserId) {
        try {
          const r = await this.deps.mailbox.send(info.feeEarnerUserId, to, subject, emailHtml(body, info), attachments);
          await this.deps.log({ tenantId, matterId, direction: 'OUT', channel: 'email', address, template, subject, body, providerRef: r.messageId, status: 'SENT' });
          return { channel: 'email', messageId: r.messageId, address };
        } catch (err) {
          if (!this.deps.email) throw err;
          await this.deps.log({ tenantId, matterId, direction: 'OUT', channel: 'email', address, template, subject, body, providerRef: null, status: `FAILED: mailbox — ${(err as Error).message}; falling back to the transactional sender` });
        }
      }
      if (this.deps.email) {
        const r = await this.deps.email.send({ to, subject, text: emailText(body, info), fromUserId: info.feeEarnerUserId });
        await this.deps.log({ tenantId, matterId, direction: 'OUT', channel: 'email', address, template, subject, body, providerRef: r.messageId, status: 'SENT' });
        return { channel: 'email', messageId: r.messageId, address };
      }
    }
    throw new Error('No client channel available (no opted-in WhatsApp number, no email address, or no sender configured).');
  }

  /** The status update exactly as sendStatusUpdate would send it. */
  async previewStatusUpdate(input: { tenantId: string; matterId: string; template: string; context: Record<string, unknown> }): Promise<MessagePreview> {
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const base = forTransaction(CLIENT_UPDATES, input.template, info.transaction);
    if (!base) throw new Error(`Unknown client update template ${input.template}`);
    const t = await resolveTemplate(this.deps, input.tenantId, base);
    const r = render(t, this.vars(info, input.context));
    const body = withOverview(r.body, input.context);
    const portal = this.deps.portalLink ? await this.deps.portalLink(input.tenantId, input.matterId).catch(() => null) : null;
    const ask = portal && SURVEY_ASK.test(t.key) && this.deps.surveysOn ? await this.deps.surveysOn(input.tenantId).catch(() => false) : false;
    return { to: clientLine(info), ...clientAddress(info), subject: r.subject, body: portal ? withPortal(body, portal, ask ? (t.key.startsWith('completed') ? SURVEY_LINE.completed : SURVEY_LINE.exchanged) : undefined) : body };
  }

  async sendStatusUpdate(input: { tenantId: string; matterId: string; template: string; context: Record<string, unknown>; override?: { subject?: string | null; body?: string | null } | null; attachments?: MailAttachment[]; link?: FileLink | null }) {
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const base = forTransaction(CLIENT_UPDATES, input.template, info.transaction);
    if (!base) throw new Error(`Unknown client update template ${input.template}`);
    const t = await resolveTemplate(this.deps, input.tenantId, base);
    const r = applyOverride(render(t, this.vars(info, input.context)), input.override);
    if (r.missing.length) throw new Error(`Template ${t.key} missing ${r.missing.join(', ')}`);
    { const why = messageProblem(r); if (why) throw new MessageHeldError(why); }
    // An edited message is sent as the person wrote it; the "where things stand" tail is only added to the template's own words.
    const body = input.override?.body?.trim() ? r.body : withOverview(r.body, input.context);
    return this.deliver(input.tenantId, input.matterId, info, t.key, r.subject, input.link ? `${body}\n\n${fileLinkBlock(input.link)}` : body, input.attachments ?? []);
  }

  /** Only ever reached after the engine's approval invariant (assertCanSendReport). Email only — a report is a document, not a chat message. */
  async sendReportOnTitle(input: { tenantId: string; matterId: string; draftDocument: DocumentRef; link?: FileLink | null }) {
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const content = (input.draftDocument.extractedFacts as { content?: string } | null)?.content ?? '';
    if (!content) throw new Error('Report draft has no content to send.');
    const to = clientRecipients(info);
    const address = to.join(', ');
    if (!to.length) throw new Error('No client email address on the matter.');
    const subject = `Report on title — ${info.propertyAddress} (${info.matterRef})`;
    // The report goes as the firm's Word document (their letterhead, from Doc Packs); the email is the covering note.
    // As a secure link (the default), or the Word document attached for a client who asked for attachments.
    const doc = !input.link && this.deps.renderReport ? await this.deps.renderReport(input.tenantId, input.matterId, content) : null;
    const attachments: MailAttachment[] = doc ? [{ name: doc.fileName, bytes: doc.bytes, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }] : [];
    const body = input.link
      ? `Hello ${info.clientFirstName ?? 'there'},\n\nYour report on title is ready. Read it carefully and let ${info.feeEarnerName ?? 'us'} know if you have any questions before we exchange contracts.\n\n${fileLinkBlock(input.link)}\n\n${info.firmName}`
      : doc
      ? `Hello ${info.clientFirstName ?? 'there'},\n\nPlease find your report on title attached. Read it carefully and let ${info.feeEarnerName ?? 'us'} know if you have any questions before we exchange contracts.\n\n${info.firmName}`
      : `Hello ${info.clientFirstName ?? 'there'},\n\nPlease find your report on title below. Read it carefully and let ${info.feeEarnerName ?? 'us'} know if you have any questions before we exchange contracts.\n\n${content}\n\n${info.firmName}`;
    let r: { messageId: string | null };
    if (this.deps.mailbox && info.feeEarnerUserId) r = await this.deps.mailbox.send(info.feeEarnerUserId, to, subject, emailHtml(body, info), attachments);
    else if (this.deps.email) r = await this.deps.email.send({ to, subject, text: emailText(body, info), fromUserId: info.feeEarnerUserId, attachments });
    else throw new Error('No email sender configured.');
    await this.deps.log({ tenantId: input.tenantId, matterId: input.matterId, direction: 'OUT', channel: 'email', address, template: 'report_on_title', subject, body: subject, providerRef: r.messageId, status: 'SENT' });
    return { channel: 'email', messageId: r.messageId, address };
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
      priorChaseNote: prior > 0 ? `, despite ${prior} previous reminder${prior === 1 ? '' : 's'}` : '',
      completionDate: info.completionDate ?? '',
      transaction: typeof ctx.transaction === 'string' ? ctx.transaction : (info.transaction === 'transfer' ? 'transfer of equity' : info.transaction ?? 'purchase'),
      // The thing we asked for, again (engine/chase-content.ts): the link, the form, or what is still outstanding.
      resend: typeof ctx.resend === 'string' ? ctx.resend : '',
      // Said only when there is a lender: a cash buyer never reads about a mortgage.
      lenderLine: typeof ctx.lenderLine === 'string' ? ctx.lenderLine : '',
      valuationLine: typeof ctx.valuationLine === 'string' ? ctx.valuationLine : '',
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
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const baseChase = forTransaction(CHASES, input.template, info.transaction);
    if (!baseChase) throw new Error(`Unknown chase template ${input.template}`);
    const t = await resolveTemplate(this.deps, input.tenantId, baseChase);
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

  async sendChase(input: { tenantId: string; matterId: string; recipientRole: 'seller_solicitor' | 'search_provider' | 'lender' | 'client' | 'id_provider' | 'hmlr'; template: string; context: Record<string, unknown>; override?: { subject?: string | null; body?: string | null } | null }) {
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const baseChase = forTransaction(CHASES, input.template, info.transaction);
    if (!baseChase) throw new Error(`Unknown chase template ${input.template}`);
    const t = await resolveTemplate(this.deps, input.tenantId, baseChase);
    const r = applyOverride(render(t, this.chaseVars(info, input.context)), input.override);
    if (r.missing.length) throw new Error(`Chase template ${t.key} missing ${r.missing.join(', ')}`);
    { const why = messageProblem(r); if (why) throw new MessageHeldError(why); }

    // The client's own chase (ID documents) goes down the client channel.
    if (input.recipientRole === 'client' || input.recipientRole === 'id_provider') {
      const comms = new ProductionClientComms(this.deps);
      const sent = await comms['deliver'](input.tenantId, input.matterId, info, t.key, r.subject, r.body);
      return { channel: sent.channel, messageId: sent.messageId };
    }

    // The search provider and HM Land Registry are not emailed: they are chased through their portal or by phone. A person is asked to, with what to say.
    if (input.recipientRole === 'search_provider' || input.recipientRole === 'hmlr') {
      const who = input.recipientRole === 'hmlr' ? 'HM Land Registry' : 'the search provider';
      await this.deps.routeToHuman({ tenantId: input.tenantId, matterId: input.matterId, title: `Chase ${who}: ${r.subject}`, detail: `${who} is chased through its portal or by phone, not by email. What to ask:\n\n${r.body}`, fromAddress: '' });
      await this.deps.log({ tenantId: input.tenantId, matterId: input.matterId, direction: 'OUT', channel: 'portal', address: null, template: t.key, subject: r.subject, body: r.body, providerRef: null, status: 'TASK' });
      return { channel: 'portal' as const, messageId: null };
    }
    const roleKey = input.recipientRole === 'seller_solicitor' ? 'seller_solicitor' : input.recipientRole === 'lender' ? 'lender' : null;
    const to = roleKey ? info.contacts[roleKey]?.email ?? null : null;
    if (!to) throw new Error(`No ${input.recipientRole.replace('_', ' ')} email address on the matter — add the contact to chase automatically.`);
    if (!this.deps.mailbox || !info.feeEarnerUserId) throw new Error('No fee-earner mailbox to send the chase from.');

    if (this.deps.chaseMode === 'send') {
      const sent = await this.deps.mailbox.send(info.feeEarnerUserId, to, r.subject, emailHtml(r.body, info));
      await this.deps.log({ tenantId: input.tenantId, matterId: input.matterId, direction: 'OUT', channel: 'email', address: to, template: t.key, subject: r.subject, body: r.body, providerRef: sent.messageId, status: 'SENT' });
      return { channel: 'email' as const, messageId: sent.messageId };
    }
    const draft = await this.deps.mailbox.draft(info.feeEarnerUserId, to, r.subject, emailHtml(r.body, info));
    await this.deps.log({ tenantId: input.tenantId, matterId: input.matterId, direction: 'OUT', channel: 'email', address: to, template: t.key, subject: r.subject, body: r.body, providerRef: draft.messageId, status: 'DRAFTED' });
    await this.deps.onChaseDrafted?.({ tenantId: input.tenantId, matterId: input.matterId, messageId: draft.messageId, title: `Chase drafted: ${r.subject}`, detail: `To ${to} — open Drafts to send.` });
    return { channel: 'email' as const, messageId: draft.messageId };
  }

  /** Any engine template's words (as edited, not yet saved) filled from a real case: what that case's email would say. */
  async previewTemplateText(input: { tenantId: string; matterId: string; key: string; subject: string; body: string }): Promise<{ subject: string; body: string; missing: string[] }> {
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const base = input.key.split('__')[0];
    const client = !!(CLIENT_UPDATES[input.key] ?? CLIENT_UPDATES[base]) || (CHASES[input.key] ?? CHASES[base])?.channel === 'client' || input.key === 'ack_client';
    const party = !!(PARTY_NOTICES[input.key] ?? PARTY_NOTICES[base]);
    const t: Template = { key: input.key, channel: client ? 'client' : 'chase', subject: input.subject, body: input.body, requires: [] };
    const word = info.transaction === 'transfer' ? 'transfer of equity' : info.transaction ?? 'purchase';
    const other = info.contacts.seller_solicitor?.name ?? 'Sirs';
    const vars: Record<string, string> = client ? new ProductionClientComms(this.deps).vars(info, {}) : party
      ? { matterRef: info.matterRef, address: info.propertyAddress, firmName: info.firmName, feeEarner: info.feeEarnerName ?? info.firmName, recipientName: other, solicitorName: other, completionDate: info.completionDate ?? 'the agreed date', leaseholdForms: '', transaction: word }
      : this.chaseVars(info, {});
    return render(t, { ...vars, what: vars.what ?? 'the documents' });
  }

  /** A first request exactly as sendRequest would send it. */
  async previewRequest(input: { tenantId: string; matterId: string; recipientRole: 'seller_solicitor' | 'lender' | 'estate_agent'; template: string; context: Record<string, unknown> }): Promise<MessagePreview> {
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const base = forTransaction(PARTY_NOTICES, input.template, info.transaction);
    if (!base) throw new Error(`Unknown request template ${input.template}`);
    const t = await resolveTemplate(this.deps, input.tenantId, base);
    const to = info.contacts[input.recipientRole];
    const label = input.recipientRole === 'seller_solicitor' ? "The other side's solicitor" : input.recipientRole === 'estate_agent' ? 'The estate agent' : 'The lender';
    const ctx = input.context;
    const r = render(t, { matterRef: info.matterRef, address: info.propertyAddress, firmName: info.firmName, feeEarner: info.feeEarnerName ?? info.firmName, recipientName: to?.name || 'Sirs', completionDate: typeof ctx.completionDate === 'string' && ctx.completionDate ? ctx.completionDate : info.completionDate ?? 'the agreed date', leaseholdForms: typeof ctx.leaseholdForms === 'string' ? ctx.leaseholdForms : '', transaction: info.transaction === 'transfer' ? 'transfer of equity' : info.transaction ?? 'purchase' });
    return { to: `${label}${to?.name ? ` (${to.name})` : ''}`, address: to?.email ?? null, channel: to?.email ? 'email' : 'none', subject: r.subject, body: r.body };
  }

  async sendRequest(input: { tenantId: string; matterId: string; recipientRole: 'seller_solicitor' | 'lender' | 'estate_agent'; template: string; context: Record<string, unknown> }) {
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const base = forTransaction(PARTY_NOTICES, input.template, info.transaction);
    if (!base) throw new Error(`Unknown request template ${input.template}`);
    const t = await resolveTemplate(this.deps, input.tenantId, base);
    const to = info.contacts[input.recipientRole];
    const label = input.recipientRole === 'seller_solicitor' ? "the seller's solicitor" : input.recipientRole === 'estate_agent' ? 'the estate agent' : 'the lender';
    if (!to?.email) throw new Error(`There is no email address for ${label} on the case, so this could not be sent. Add them as a contact, then Try Again.`);
    const ctx = input.context;
    const r = render(t, { matterRef: info.matterRef, address: info.propertyAddress, firmName: info.firmName, feeEarner: info.feeEarnerName ?? info.firmName, recipientName: to.name || 'Sirs', completionDate: typeof ctx.completionDate === 'string' && ctx.completionDate ? ctx.completionDate : info.completionDate ?? 'the agreed date', leaseholdForms: typeof ctx.leaseholdForms === 'string' ? ctx.leaseholdForms : '', transaction: info.transaction === 'transfer' ? 'transfer of equity' : info.transaction ?? 'purchase' });
    if (r.missing.length) throw new Error(`Request template ${t.key} missing ${r.missing.join(', ')}`);
    { const why = messageProblem(r); if (why) throw new MessageHeldError(why); }
    let sent: { messageId: string | null };
    if (this.deps.mailbox && info.feeEarnerUserId) sent = await this.deps.mailbox.send(info.feeEarnerUserId, to.email, r.subject, emailHtml(r.body, info));
    else if (this.deps.email) sent = await this.deps.email.send({ to: to.email, subject: r.subject, text: emailText(r.body, info), fromUserId: info.feeEarnerUserId });
    else throw new Error('No email sender configured.');
    await this.deps.log({ tenantId: input.tenantId, matterId: input.matterId, direction: 'OUT', channel: 'email', address: to.email, template: t.key, subject: r.subject, body: r.body, providerRef: sent.messageId, status: 'SENT' });
    return { channel: 'email' as const, messageId: sent.messageId };
  }

  /** A message a person approved on an email's task, sent as they wrote it to a party on the case (checked by the message guard first). */
  async sendMessage(input: { tenantId: string; matterId: string; recipientRole: 'seller_solicitor' | 'estate_agent' | 'lender'; subject: string; body: string }) {
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const to = info.contacts[input.recipientRole];
    const label = input.recipientRole === 'seller_solicitor' ? "the other side's solicitor" : input.recipientRole === 'estate_agent' ? 'the estate agent' : 'the lender';
    if (!to?.email) throw new Error(`There is no email address for ${label} on the case, so this could not be sent. Add them as a contact, then Try Again.`);
    const r = { subject: input.subject.trim(), body: input.body.trim(), missing: [] as string[] };
    { const why = messageProblem(r); if (why) throw new MessageHeldError(why); }
    let sent: { messageId: string | null };
    if (this.deps.mailbox && info.feeEarnerUserId) sent = await this.deps.mailbox.send(info.feeEarnerUserId, to.email, r.subject, emailHtml(r.body, info));
    else if (this.deps.email) sent = await this.deps.email.send({ to: to.email, subject: r.subject, text: emailText(r.body, info), fromUserId: info.feeEarnerUserId });
    else throw new Error('No email sender configured.');
    await this.deps.log({ tenantId: input.tenantId, matterId: input.matterId, direction: 'OUT', channel: 'email', address: to.email, template: 'email_task_message', subject: r.subject, body: r.body, providerRef: sent.messageId, status: 'SENT' });
    return { channel: 'email' as const, messageId: sent.messageId };
  }

  async sendEnquiries(input: { tenantId: string; matterId: string; enquiryId: string; text: string }) {
    const t = await resolveTemplate(this.deps, input.tenantId, PARTY_NOTICES.enquiries_to_seller_solicitor);
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const to = info.contacts.seller_solicitor;
    if (!to?.email) throw new Error("There is no seller's solicitor email on the case to send the enquiries to.");
    const r = render(t, { matterRef: info.matterRef, address: info.propertyAddress, firmName: info.firmName, feeEarner: info.feeEarnerName ?? info.firmName, solicitorName: to.name || 'Colleagues', enquiries: input.text.trim() });
    if (r.missing.length) throw new Error(`Enquiries template ${t.key} missing ${r.missing.join(', ')}`);
    { const why = messageProblem(r); if (why) throw new MessageHeldError(why); }
    let sent: { messageId: string | null };
    if (this.deps.mailbox && info.feeEarnerUserId) sent = await this.deps.mailbox.send(info.feeEarnerUserId, to.email, r.subject, emailHtml(r.body, info));
    else if (this.deps.email) sent = await this.deps.email.send({ to: to.email, subject: r.subject, text: emailText(r.body, info), fromUserId: info.feeEarnerUserId });
    else throw new Error('No email sender configured.');
    await this.deps.log({ tenantId: input.tenantId, matterId: input.matterId, direction: 'OUT', channel: 'email', address: to.email, template: t.key, subject: r.subject, body: r.body, providerRef: sent.messageId, status: 'SENT' });
    return { channel: 'email' as const, messageId: sent.messageId };
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
    const sent = await this.deps.mailbox.send(info.feeEarnerUserId, agent.email, r.subject, emailHtml(r.body, info));
    await this.deps.log({ tenantId: input.tenantId, matterId: input.matterId, direction: 'OUT', channel: 'email', address: agent.email, template: t.key, subject: r.subject, body: r.body, providerRef: sent.messageId, status: 'SENT' });
    return { channel: 'email' as const, messageId: sent.messageId };
  }

  async sendAcknowledgement(input: { tenantId: string; matterId: string; recipientRole: 'seller_solicitor' | 'client'; what: string; forEventType: string; override?: { subject?: string | null; body?: string | null } | null }) {
    if (this.deps.ackMode === 'off') return null;
    const info = await this.deps.contactInfo(input.tenantId, input.matterId);
    const vars = { matterRef: info.matterRef, address: info.propertyAddress, property: info.propertyAddress, firstName: info.clientFirstName ?? 'there', firmName: info.firmName, feeEarner: info.feeEarnerName ?? info.firmName, what: input.what };
    if (input.recipientRole === 'client') {
      const r = applyOverride(render(await resolveTemplate(this.deps, input.tenantId, ACKS.ack_client), vars), input.override);
      if (r.missing.length) throw new Error(`Acknowledgement template missing ${r.missing.join(', ')}`);
      { const why = messageProblem(r); if (why) throw new MessageHeldError(why); }
      if (!info.clientEmail && !(info.clientPhone && info.clientWhatsAppOptIn)) return null;
      const sent = await new ProductionClientComms(this.deps)['deliver'](input.tenantId, input.matterId, info, ACKS.ack_client.key, r.subject, r.body);
      return { channel: sent.channel, messageId: sent.messageId };
    }
    const to = info.contacts.seller_solicitor?.email ?? null;
    if (!to || !this.deps.mailbox || !info.feeEarnerUserId) return null;
    const r = applyOverride(render(await resolveTemplate(this.deps, input.tenantId, ACKS.ack_counterparty), vars), input.override);
    if (r.missing.length) throw new Error(`Acknowledgement template missing ${r.missing.join(', ')}`);
    { const why = messageProblem(r); if (why) throw new MessageHeldError(why); }
    const sent = await this.deps.mailbox.send(info.feeEarnerUserId, to, r.subject, emailHtml(r.body, info));
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
