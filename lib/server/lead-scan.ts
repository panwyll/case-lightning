/**
 * The free inbox scan, CONVEYi's lead magnet (app/conveyi/scan). A prospect signs in with their work Microsoft
 * account, read-only: the only mailbox permission asked for is Mail.Read, and no refresh token is asked for, so the
 * access ends when the sign-in's token expires (about an hour). Their last four weeks of Sent Items and Inbox are
 * labelled by the same rules and model as a firm's measurement (lib/server/workload/scan.ts), and the same charts are
 * built (lib/server/epa/measure.ts). No firm or user account is made.
 *
 * Kept per email: its label, time and who it was with by kind (client, agent ...): never its text, subject or
 * addresses. The token is kept encrypted while the scan runs and wiped when it ends. The result is reached by a
 * secret link (only its hash is kept); the prospect is emailed it, and we are told of the scan.
 */
import crypto from 'node:crypto';
import { Resend } from 'resend';
import { config } from './config';
import { decryptSecret, encryptSecret } from './crypto';
import { query, queryOne, runAsSystem } from './db';
import { DEFAULT_LEVELS } from './engine/types';
import { buildMeasurement, MIN_SENT_PER_WEEK, type Measurement, type PersonScan } from './epa/measure';
import { DEFAULT_SETTINGS } from './workload/model';
import { labelStaged, stage, type Staged } from './workload/scan';
import { domainOf, firmDomainsOf } from './workload/taxonomy';
import { wholeDayWindow, windowWeeks } from './workload/window';
import { DEMO_HOST } from './demo/bookings';

export const LEAD_SCAN_WEEKS = 4;
const MAX_MESSAGES = 6000;
const SLICE_MS = 12_000;
/** Read-only, and no offline_access: no way back in once the token expires. */
const SCOPE = 'openid profile email https://graph.microsoft.com/Mail.Read';
/** Work and school accounts of any firm; never personal Outlook.com accounts. */
const AUTHORITY = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';

const env = (k: string) => process.env[k]?.trim() || undefined;
const hash = (x: string) => crypto.createHash('sha256').update(x).digest('hex');
export const leadScanConfigured = () => !!(config.azureClientId && config.azureClientSecret);
const redirectUri = () => `${config.appUrl.replace(/\/$/, '')}/api/v1/scan/callback`;

/** Why a scan could not start or go on: `code` is what the page says, so no text travels in a link. */
export type LeadScanCode = 'admin' | 'cancelled' | 'expired' | 'mailbox' | 'busy' | 'failed' | 'unknown';
export class LeadScanError extends Error {
  constructor(message: string, readonly status: number, readonly code: LeadScanCode = 'failed') { super(message); }
}

/** Microsoft's sign-in, asking only to read mail. */
export function signInUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: config.azureClientId!, response_type: 'code', redirect_uri: redirectUri(), response_mode: 'query',
    scope: SCOPE, state, prompt: 'select_account',
  });
  return `${AUTHORITY}/authorize?${q}`;
}

type Status = 'SCANNING_SENT' | 'SCANNING_INBOX' | 'COMPLETE' | 'FAILED';
interface ScanRow {
  id: string; email: string; name: string | null; status: Status; since: Date; until: Date; cursor: string | null;
  access_token_enc: string | null; token_expires_at: Date | null; messages_read: number; sent: number; received: number;
  set_aside: number; classified: number; result: Measurement | null; error: string | null; notified_at: Date | null; created_at: Date;
}

const sys = <T>(fn: () => Promise<T>) => runAsSystem(fn);

/**
 * Back from Microsoft: swap the code for a token, check the limits, and start the scan. Returns the secret that
 * reaches the result. Limits: three scans a mailbox a day, five from one address a day, and a daily total
 * (LEAD_SCAN_DAILY_MAX, default 60), because each scan costs a model run.
 */
export async function startLeadScan(input: { code: string; ip: string | null; source: Record<string, string> }): Promise<string> {
  const r = await fetch(`${AUTHORITY}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.azureClientId!, client_secret: config.azureClientSecret!, code: input.code, redirect_uri: redirectUri(), scope: SCOPE }),
    signal: AbortSignal.timeout(10_000),
  });
  const t = await r.json().catch(() => ({})) as { access_token?: string; expires_in?: number; id_token?: string; error?: string; error_description?: string };
  const accessToken = t.access_token;
  if (!r.ok || !accessToken) throw new LeadScanError(`Microsoft did not let us in: ${t.error_description?.split('\n')[0] ?? t.error ?? r.status}`, 400);
  // The ID token came straight from Microsoft's token endpoint over TLS, so its claims can be read without checking the signature.
  const claims = t.id_token ? JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString('utf8')) : {};
  const email = String(claims.email ?? claims.preferred_username ?? '').toLowerCase();
  if (!email.includes('@')) throw new LeadScanError('Microsoft did not say which mailbox this is.', 400);
  const limits = await sys(() => queryOne<{ mine: number; ip: number; today: number }>(
    `select count(*) filter (where lower(email) = $1)::int as mine, count(*) filter (where ip = $2)::int as ip, count(*)::int as today
       from lead_scan where created_at > now() - interval '1 day'`, [email, input.ip]));
  if ((limits?.mine ?? 0) >= 3) throw new LeadScanError('This mailbox has been scanned three times today. Check your email for the results link.', 429, 'mailbox');
  if (input.ip && (limits?.ip ?? 0) >= 5) throw new LeadScanError('Too many scans from here today. Try again tomorrow.', 429, 'busy');
  if ((limits?.today ?? 0) >= Number(env('LEAD_SCAN_DAILY_MAX') ?? 60)) throw new LeadScanError('The scan is very busy today. Try again tomorrow, or book a demo and we will run it with you.', 429, 'busy');
  const token = crypto.randomBytes(24).toString('base64url');
  // Whole UK days ending at midnight this morning (workload/window.ts).
  const { since, until } = wholeDayWindow(new Date(), LEAD_SCAN_WEEKS);
  await sys(() => query(
    `insert into lead_scan (token_hash, email, name, ms_tenant_id, since, until, access_token_enc, token_expires_at, source, ip)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
    [hash(token), email, claims.name ? String(claims.name).slice(0, 120) : null, claims.tid ?? null, since, until,
      encryptSecret(accessToken), new Date(Date.now() + (t.expires_in ?? 3600) * 1000), JSON.stringify(input.source), input.ip]));
  return token;
}

const byToken = (token: string) => (/^[\w-]{20,64}$/.test(token)
  ? sys(() => queryOne<ScanRow>(`select * from lead_scan where token_hash = $1`, [hash(token)]))
  : Promise.resolve(null));

/** One page of a folder, newest first, between the scan's two times: the same fields the firm's scan reads (lib/server/graph.ts). */
async function folderPage(accessToken: string, folder: 'sentitems' | 'inbox', since: Date, until: Date, next: string | null): Promise<{ messages: any[]; next: string | null }> {
  const filter = `receivedDateTime ge ${since.toISOString()} and receivedDateTime lt ${until.toISOString()}`;
  const url = next ?? `${GRAPH}/me/mailFolders('${folder}')/messages?$select=${encodeURIComponent('id,subject,from,toRecipients,ccRecipients,conversationId,createdDateTime,sentDateTime,receivedDateTime,hasAttachments,isDraft,uniqueBody')}&$filter=${encodeURIComponent(filter)}&$orderby=${encodeURIComponent('receivedDateTime desc')}&$top=50`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${accessToken}`, prefer: 'outlook.body-content-type="text"' }, signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw new LeadScanError('Your sign-in has expired. Start the scan again.', 401, 'expired');
  if (!r.ok) throw new Error(`Outlook: ${j?.error?.message ?? r.status}`);
  return { messages: j.value ?? [], next: j['@odata.nextLink'] ?? null };
}

const key = (graphId: string) => hash(graphId).slice(0, 32);

/** Label and keep one page. */
async function keepPage(scan: ScanRow, staged: Staged[]): Promise<number> {
  // No firm and no user: the scan's own id stands for the user (so no firm's own AI key is used) and no usage is recorded against a firm.
  const { results } = await labelStaged(staged, { userId: scan.id, tenantId: '' });
  let classified = 0;
  for (const m of staged) {
    const r = results.get(m.id);
    const category = m.filtered ? null : m.internal ? 'internal' : r?.category ?? null;
    if (category) classified += 1;
    await sys(() => query(
      `insert into lead_scan_email (scan_id, message_key, direction, sent_at, drafted_at, conversation_id, category, roles, filtered)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing`,
      [scan.id, key(m.id), m.direction, m.sentAt, m.draftedAt, m.conversationId, category, m.internal ? ['colleague'] : r?.roles ?? [], m.filtered]));
  }
  return classified;
}

/** The charts from what was kept: one person's typical week, on the standard 37.5-hour, 9 to 5:30 day. */
async function measure(scan: ScanRow): Promise<Measurement | null> {
  const rows = await sys(() => query<{ message_key: string; direction: 'out' | 'in'; sent_at: Date; drafted_at: Date | null; category: string; roles: string[]; conversation_id: string | null }>(
    `select message_key, direction, sent_at, drafted_at, category, roles, conversation_id from lead_scan_email
      where scan_id = $1 and filtered is null and category is not null`, [scan.id]));
  const as = (r: (typeof rows)[number]) => ({ id: r.message_key, at: new Date(r.sent_at).getTime(), draftedAt: r.drafted_at ? new Date(r.drafted_at).getTime() : null, category: r.category, roles: r.roles ?? [], conversationId: r.conversation_id });
  const person: PersonScan = {
    weeks: windowWeeks(new Date(scan.since), new Date(scan.until)),
    sent: rows.filter((r) => r.direction === 'out').map(as),
    received: rows.filter((r) => r.direction === 'in').map(as),
    intouch: null,
  };
  return buildMeasurement({ people: [person], levels: DEFAULT_LEVELS, contractedHours: DEFAULT_SETTINGS.contractedHours, workday: { workdayStart: DEFAULT_SETTINGS.workdayStart, workdayEnd: DEFAULT_SETTINGS.workdayEnd } });
}

/** Run a scan on by one slice of about twelve seconds; the page calls this until it is done. */
export async function advanceLeadScan(token: string): Promise<LeadScanView> {
  const found = await byToken(token);
  if (!found) throw new LeadScanError('This scan link is not one of ours.', 404, 'unknown');
  let s: ScanRow = found;
  const id = s.id;
  const started = Date.now();
  try {
    while (Date.now() - started < SLICE_MS && (s.status === 'SCANNING_SENT' || s.status === 'SCANNING_INBOX')) {
      if (!s.access_token_enc || !s.token_expires_at || new Date(s.token_expires_at).getTime() < Date.now() + 30_000) {
        throw new LeadScanError('Your sign-in expired before the scan finished. Start it again.', 401, 'expired');
      }
      const folder = s.status === 'SCANNING_SENT' ? 'sentitems' : 'inbox';
      const page = await folderPage(decryptSecret(s.access_token_enc), folder, new Date(s.since), new Date(s.until), s.cursor);
      const room = Math.max(0, MAX_MESSAGES - s.messages_read);
      const firm = firmDomainsOf([domainOf(s.email)]);
      const staged = page.messages.slice(0, room).map((m) => stage(m, folder === 'sentitems' ? 'out' : 'in', firm)).filter((x): x is Staged => !!x);
      const classified = await keepPage(s, staged);
      const read: number = s.messages_read + Math.min(room, page.messages.length);
      const done = !page.next || read >= MAX_MESSAGES;
      const next: Status = !done ? s.status : s.status === 'SCANNING_SENT' && read < MAX_MESSAGES ? 'SCANNING_INBOX' : 'COMPLETE';
      const out = staged.filter((m) => m.direction === 'out').length;
      const setAside = staged.filter((m) => m.direction === 'in' && m.filtered).length;
      const updated: ScanRow | null = await sys(() => queryOne<ScanRow>(
        `update lead_scan set messages_read = $2, classified = classified + $3, cursor = $4, status = $5, sent = sent + $6,
           received = received + $7, set_aside = set_aside + $8, updated_at = now() where id = $1 returning *`,
        [id, read, classified, done ? null : page.next, next, out, staged.length - out, setAside]));
      s = updated!;
      if (next === 'COMPLETE') s = await finish(s);
    }
  } catch (e) {
    const message = (e instanceof LeadScanError ? e.message : 'The scan stopped. Start it again.').slice(0, 300);
    if (!(e instanceof LeadScanError)) console.error('lead scan failed', s.id, e);
    const failed: ScanRow | null = await sys(() => queryOne<ScanRow>(`update lead_scan set status = 'FAILED', error = $2, access_token_enc = null, updated_at = now() where id = $1 returning *`, [id, message]));
    s = failed!;
  }
  return view(s, token);
}

/** The scan is read: build the charts, wipe the token, and send the two emails. */
async function finish(s: ScanRow): Promise<ScanRow> {
  const result = await measure(s);
  const done = (await sys(() => queryOne<ScanRow>(
    `update lead_scan set result = $2::jsonb, access_token_enc = null, completed_at = now(), updated_at = now() where id = $1 returning *`,
    [s.id, JSON.stringify(result)])))!;
  return done;
}

export interface LeadScanView {
  status: Status; name: string | null; email: string; since: string; until: string; error: string | null;
  read: { sent: number; received: number; setAside: number; classified: number };
  thin: boolean; measurement: Measurement | null;
}

function view(s: ScanRow, _token: string): LeadScanView {
  const m = s.result;
  return {
    status: s.status, name: s.name, email: s.email, since: new Date(s.since).toISOString(), until: new Date(s.until).toISOString(), error: s.error,
    read: { sent: s.sent, received: s.received, setAside: s.set_aside, classified: s.classified },
    thin: !!m && m.sentPerPersonWeek < MIN_SENT_PER_WEEK, measurement: m,
  };
}

/** The scan as its page shows it. */
export async function leadScanView(token: string): Promise<LeadScanView | null> {
  const s = await byToken(token);
  return s ? view(s, token) : null;
}

/**
 * Once a scan is complete: the prospect is emailed their link, and we are told. Called by the page when it sees the
 * scan finish, and claimed first, so it happens once.
 */
export async function notifyLeadScan(token: string): Promise<void> {
  const s = await byToken(token);
  if (!s || s.status !== 'COMPLETE') return;
  const claimed = await sys(() => queryOne<{ id: string }>(`update lead_scan set notified_at = now() where id = $1 and notified_at is null returning id`, [s.id]));
  if (!claimed) return;
  if (!config.resendApiKey || !config.resendFromEmail) { console.error(`lead scan ${s.id} (${s.email}) not emailed: RESEND_API_KEY / RESEND_FROM_EMAIL not set`); return; }
  const resend = new Resend(config.resendApiKey);
  const link = `${config.appUrl.replace(/\/$/, '')}/conveyi/scan/${token}`;
  const m = s.result;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const split = m ? `Red ${pct(m.share.red)}, amber ${pct(m.share.amber)}, green ${pct(m.share.green)}` : 'Not enough email to draw the week';
  const top = m?.lines.slice(0, 3).map((l) => `${l.label}: ${l.hours.toFixed(1)}h a week`).join('\n') ?? '';
  const first = s.name?.split(/\s+/)[0] ?? 'there';
  const send = async (what: string, msg: Parameters<Resend['emails']['send']>[0]) => {
    const r = await resend.emails.send(msg).catch((e) => ({ error: e }));
    if ((r as { error?: unknown }).error) console.error(`lead scan ${what} email failed`, s.id, (r as { error?: unknown }).error);
  };
  await Promise.all([
    send('result', {
      from: config.resendFromEmail, to: s.email, replyTo: DEMO_HOST.email, subject: 'Your CONVEYi inbox scan',
      text: `Hi ${first},\n\nYour inbox scan is ready: ${link}\n\n${split}.\n\nKeep this link to yourself: it opens your results.\n\nWant to see how to win that time back? Book a 15-minute demo: ${config.appUrl.replace(/\/$/, '')}/conveyi/demo\n\n${DEMO_HOST.name}\nCase Lightning`,
    }),
    send('host', {
      from: config.resendFromEmail, to: DEMO_HOST.email, replyTo: s.email, subject: `Inbox scan: ${s.name ?? s.email} (${domainOf(s.email)})`,
      text: [`${s.name ?? ''} <${s.email}>`, split, top && `\n${top}`, `\nRead ${s.sent} sent and ${s.received} received over ${LEAD_SCAN_WEEKS} weeks.`, `\n${link}`].filter(Boolean).join('\n'),
    }),
  ]);
}
