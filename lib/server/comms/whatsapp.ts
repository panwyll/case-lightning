/**
 * WhatsApp via the Meta Cloud API (component #5). Sending is a single POST; inbound
 * messages arrive on a webhook that Meta verifies with a GET challenge and signs with
 * X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret).
 * Transport is injectable for tests.
 */
import crypto from 'node:crypto';

export type WhatsAppTransport = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  appSecret?: string;
  verifyToken?: string;
  apiVersion?: string;
}

export class WhatsAppClient {
  constructor(
    private cfg: WhatsAppConfig,
    private transport: WhatsAppTransport = async (url, init) => {
      const r = await fetch(url, init);
      return { status: r.status, text: () => r.text() };
    }
  ) {}

  private get base(): string {
    return `https://graph.facebook.com/${this.cfg.apiVersion ?? 'v21.0'}/${this.cfg.phoneNumberId}`;
  }

  /** Free-form text (allowed inside the 24h customer-service window; otherwise Meta requires an approved template). */
  async sendText(to: string, body: string): Promise<{ messageId: string | null }> {
    const res = await this.transport(`${this.base}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: normaliseE164(to), type: 'text', text: { preview_url: false, body } }),
    });
    const text = await res.text();
    if (res.status >= 400) throw new Error(`WhatsApp send failed (${res.status}): ${text.slice(0, 300)}`);
    const parsed = JSON.parse(text || '{}') as { messages?: Array<{ id: string }> };
    return { messageId: parsed.messages?.[0]?.id ?? null };
  }

  /** Approved message template with positional body parameters (outside the 24h window). */
  async sendTemplate(to: string, templateName: string, params: string[], language = 'en_GB'): Promise<{ messageId: string | null }> {
    const res = await this.transport(`${this.base}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: normaliseE164(to),
        type: 'template',
        template: { name: templateName, language: { code: language }, components: params.length ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p })) }] : [] },
      }),
    });
    const text = await res.text();
    if (res.status >= 400) throw new Error(`WhatsApp template send failed (${res.status}): ${text.slice(0, 300)}`);
    const parsed = JSON.parse(text || '{}') as { messages?: Array<{ id: string }> };
    return { messageId: parsed.messages?.[0]?.id ?? null };
  }

  verifyChallenge(params: { mode: string | null; token: string | null; challenge: string | null }): string | null {
    if (params.mode === 'subscribe' && this.cfg.verifyToken && params.token === this.cfg.verifyToken) return params.challenge;
    return null;
  }

  verifySignature(rawBody: string, header: string | null): boolean {
    if (!this.cfg.appSecret) return false;
    if (!header) return false;
    const expected = crypto.createHmac('sha256', this.cfg.appSecret).update(rawBody).digest('hex');
    const given = header.replace(/^sha256=/, '').trim();
    if (given.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
  }
}

export interface InboundMessage {
  from: string; // E.164 without '+'
  messageId: string;
  text: string;
  timestamp: string;
  profileName: string | null;
}

/** Pull text messages out of a Meta webhook payload (statuses and non-text are ignored). */
export function parseInbound(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = ((payload as { entry?: unknown[] })?.entry ?? []) as Array<{ changes?: Array<{ value?: { messages?: Array<Record<string, unknown>>; contacts?: Array<{ wa_id?: string; profile?: { name?: string } }> } }> }>;
  for (const e of entries) {
    for (const ch of e.changes ?? []) {
      const v = ch.value;
      const names = new Map((v?.contacts ?? []).map((c) => [c.wa_id ?? '', c.profile?.name ?? null]));
      for (const m of v?.messages ?? []) {
        if (m.type !== 'text') continue;
        const body = (m.text as { body?: string } | undefined)?.body ?? '';
        if (!body.trim()) continue;
        out.push({ from: String(m.from ?? ''), messageId: String(m.id ?? ''), text: body, timestamp: String(m.timestamp ?? ''), profileName: names.get(String(m.from ?? '')) ?? null });
      }
    }
  }
  return out;
}

export function normaliseE164(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits.slice(1);
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) return `44${digits.slice(1)}`; // UK national → E.164
  return digits;
}
