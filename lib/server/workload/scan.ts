/**
 * The workload baseline's scan (docs/workload-baseline.md §1–3), driven in bounded slices like
 * onboarding: the page calls advance() until it says done. No message text is stored, so each page
 * of mail is classified in the same slice that reads it; only the row survives.
 *
 *   SCANNING_SENT → SCANNING_INBOX → CHECKING (sample drawn; report available, marked unchecked)
 *     → COMPLETE (the conveyancer has checked the sample, or chose to finish without it)
 */
import { query, queryOne } from '../db';
import { listFolderWindow, getMessageForCheck } from '../graph';
import { classifyWorkload, WORKLOAD_PROMPT_VERSION } from '../ai';
import { tenantSelfAddresses } from '../matching';
import type { SessionUser } from '../types';
import { IN_CATEGORIES, IN_SPEC, OUT_CATEGORIES, OUT_SPEC, ROLES, allInternal, domainOf, filterByRule, firmDomainsOf, isForwardSubject, isReplySubject, wordCount, writtenText, type Filtered, type OutCategory } from './taxonomy';
import { SAMPLE_SIZE, buildReport, drawSample, type Report, type Row, type Settings } from './model';

export type ScanStatus = 'SCANNING_SENT' | 'SCANNING_INBOX' | 'CHECKING' | 'COMPLETE' | 'FAILED' | 'CANCELLED';
export interface ScanRow {
  id: string; tenant_id: string; user_id: string; status: ScanStatus; since: string; until: string; cursor: string | null;
  max_messages: number; messages_read: number; classified: number; model: string | null; prompt_version: string | null; error: string | null;
  created_at: string; completed_at: string | null;
}

const SLICE_MS = 12_000;
const BATCH = 10;
const CONCURRENCY = 5;
const TEXT_CHARS = 1200;
export const DEFAULT_WEEKS = 13;
const ACTIVE: ScanStatus[] = ['SCANNING_SENT', 'SCANNING_INBOX'];

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d));
const norm = (s: ScanRow): ScanRow => ({ ...s, since: iso(s.since), until: iso(s.until), created_at: iso(s.created_at), completed_at: s.completed_at ? iso(s.completed_at) : null });

export async function latestScan(userId: string): Promise<ScanRow | null> {
  const s = await queryOne<ScanRow>(`select * from workload_scan where user_id = $1 and status <> 'CANCELLED' order by created_at desc limit 1`, [userId]);
  return s ? norm(s) : null;
}

/** The first finished scan: the baseline everything after is measured against. */
export async function baselineScan(userId: string): Promise<ScanRow | null> {
  const s = await queryOne<ScanRow>(`select * from workload_scan where user_id = $1 and status in ('CHECKING', 'COMPLETE') order by created_at asc limit 1`, [userId]);
  return s ? norm(s) : null;
}

/** Start a scan of the last `weeks` weeks (or a given window, for a re-scan after go-live). One running at a time. */
export async function startScan(user: SessionUser, opts: { weeks?: number; since?: string; until?: string } = {}): Promise<ScanRow> {
  const running = await queryOne<{ id: string }>(`select id from workload_scan where user_id = $1 and status = any($2)`, [user.userId, ACTIVE]);
  if (running) throw Object.assign(new Error('A scan is already running.'), { status: 409 });
  const until = opts.until ? new Date(opts.until) : new Date();
  const weeks = Math.min(52, Math.max(2, opts.weeks ?? DEFAULT_WEEKS));
  const since = opts.since ? new Date(opts.since) : new Date(until.getTime() - weeks * 7 * 86_400_000);
  if (!(since < until)) throw Object.assign(new Error('The window must start before it ends.'), { status: 400 });
  const s = await queryOne<ScanRow>(
    `insert into workload_scan (tenant_id, user_id, since, until, prompt_version) values ($1, $2, $3, $4, $5) returning *`,
    [user.tenantId, user.userId, since.toISOString(), until.toISOString(), WORKLOAD_PROMPT_VERSION]
  );
  return norm(s!);
}

export async function cancelScan(userId: string): Promise<void> {
  await query(`update workload_scan set status = 'CANCELLED', updated_at = now() where user_id = $1 and status = any($2)`, [userId, ACTIVE]);
}

const people = (xs: any[] | undefined) => (xs ?? []).map((r) => r?.emailAddress).filter(Boolean) as Array<{ name?: string; address?: string }>;

interface Staged { id: string; direction: 'out' | 'in'; subject: string; draftedAt: string | null; sentAt: string; conversationId: string | null; words: number; text: string; people: string; isReply: boolean; isForward: boolean; hasAttachments: boolean; filtered: Filtered | null; internal: boolean }

/** A Graph message as the scan reads it: what was written, by rule what it is, and nothing else kept. */
export function stage(m: any, direction: 'out' | 'in', firm: string[]): Staged | null {
  if (m.isDraft) return null;
  const subject = String(m.subject ?? '');
  const text = writtenText(String(m.uniqueBody?.content ?? ''));
  const to = [...people(m.toRecipients), ...people(m.ccRecipients)];
  const from = people([m.from])[0];
  const who = direction === 'out' ? to : from ? [from] : [];
  const addresses = who.map((p) => (p.address ?? '').toLowerCase()).filter(Boolean);
  return {
    id: m.id,
    direction,
    subject,
    draftedAt: direction === 'out' && m.createdDateTime ? m.createdDateTime : null,
    sentAt: (direction === 'out' ? m.sentDateTime : m.receivedDateTime) ?? m.receivedDateTime,
    conversationId: m.conversationId ?? null,
    words: wordCount(text),
    text,
    // Names and domains only: enough to tell a client from a lender, without the addresses.
    people: who.map((p) => `${p.name ?? ''} <${domainOf(p.address ?? '')}>`.trim()).join(', ') || '(none)',
    isReply: isReplySubject(subject),
    isForward: isForwardSubject(subject),
    hasAttachments: !!m.hasAttachments,
    filtered: filterByRule({ direction, from: from?.address ?? '', subject, text, hasAttachments: !!m.hasAttachments }),
    internal: direction === 'out' && allInternal(addresses, firm),
  };
}

async function inParallel<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

/** Classify and store one page. A batch the model fails on is stored unclassified, and the report counts it as such. */
async function classifyAndStore(user: SessionUser, scan: ScanRow, staged: Staged[]): Promise<{ classified: number; model: string | null }> {
  const toModel = staged.filter((m) => !m.filtered && !m.internal);
  const batches: Staged[][] = [];
  for (let i = 0; i < toModel.length; i += BATCH) batches.push(toModel.slice(i, i + BATCH));
  const results = new Map<string, { category: string; confidence: number; roles: string[] }>();
  let model: string | null = null;
  const outDefs = OUT_CATEGORIES.filter((c) => c !== 'internal').map((key) => ({ key, what: OUT_SPEC[key].what }));
  const inDefs = IN_CATEGORIES.map((key) => ({ key, what: IN_SPEC[key].what }));
  await inParallel(batches, CONCURRENCY, async (b) => {
    // Short ids in the prompt; mapped back to Graph ids here.
    const emails = b.map((m, i) => ({ id: `m${i + 1}`, direction: m.direction, subject: m.subject.slice(0, 200), people: m.people.slice(0, 300), isReply: m.isReply, isForward: m.isForward, hasAttachments: m.hasAttachments, text: m.text.slice(0, TEXT_CHARS) }));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await classifyWorkload({ userId: user.userId, tenantId: user.tenantId, emails, outCategories: outDefs, inCategories: inDefs, roles: ROLES });
        model = r.model;
        for (const x of r.results) {
          const m = b[Number(x.id.replace(/^m/, '')) - 1];
          if (!m) continue;
          const allowed: readonly string[] = m.direction === 'out' ? OUT_CATEGORIES : IN_CATEGORIES;
          if (allowed.includes(x.category)) results.set(m.id, { category: x.category, confidence: Math.max(0, Math.min(1, Number(x.confidence) || 0)), roles: (x.roles ?? []).filter((r) => (ROLES as readonly string[]).includes(r)) });
        }
        return;
      } catch { /* one more try, then the batch stays unclassified */ }
    }
  });
  let classified = 0;
  for (const m of staged) {
    const r = results.get(m.id);
    const category = m.filtered ? null : m.internal ? 'internal' : r?.category ?? null;
    if (category) classified += 1;
    await query(
      `insert into workload_email (scan_id, tenant_id, user_id, graph_message_id, conversation_id, direction, drafted_at, sent_at, words_written, recipient_roles, is_reply, is_forward, has_attachments, filtered, category, confidence, classified_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) on conflict (scan_id, graph_message_id) do nothing`,
      [scan.id, scan.tenant_id, scan.user_id, m.id, m.conversationId, m.direction, m.draftedAt, m.sentAt, m.words, m.internal ? ['colleague'] : r?.roles ?? [], m.isReply, m.isForward, m.hasAttachments, m.filtered, category, m.internal ? 1 : r?.confidence ?? null, m.filtered ? null : m.internal ? 'rule' : r ? 'model' : null]
    );
  }
  return { classified, model };
}

/** Advance a running scan by one bounded slice. */
export async function advanceScan(user: SessionUser, scan: ScanRow): Promise<ScanRow> {
  if (!ACTIVE.includes(scan.status)) return scan;
  const started = Date.now();
  const self = await tenantSelfAddresses(user.tenantId);
  const firm = firmDomainsOf([...self.domains, domainOf(user.email)]);
  let s = scan;
  try {
    while (Date.now() - started < SLICE_MS && ACTIVE.includes(s.status)) {
      const folder = s.status === 'SCANNING_SENT' ? 'sentitems' : 'inbox';
      const page = await listFolderWindow(user.userId, folder, s.since, s.until, s.cursor);
      const room = Math.max(0, s.max_messages - s.messages_read);
      const staged = page.messages.slice(0, room).map((m) => stage(m, folder === 'sentitems' ? 'out' : 'in', firm)).filter((x): x is Staged => !!x);
      const { classified, model } = await classifyAndStore(user, s, staged);
      const read = s.messages_read + Math.min(room, page.messages.length);
      // The folder is done when Graph has no more pages, or the scan has read all it may.
      const folderDone = !page.nextLink || read >= s.max_messages;
      const next: ScanStatus = !folderDone ? s.status : s.status === 'SCANNING_SENT' && read < s.max_messages ? 'SCANNING_INBOX' : 'CHECKING';
      const updated = await queryOne<ScanRow>(
        `update workload_scan set messages_read = $2, classified = classified + $3, cursor = $4, status = $5, model = coalesce($6, model), updated_at = now() where id = $1 and status = any($7) returning *`,
        [s.id, read, classified, folderDone ? null : page.nextLink, next, model, ACTIVE]
      );
      // Cancelled while this page was being read: stop, and say so.
      if (!updated) return { ...s, status: 'CANCELLED' };
      s = norm(updated);
      if (s.status === 'CHECKING') await drawCheckSample(s);
    }
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 500);
    await query(`update workload_scan set status = 'FAILED', error = $2, updated_at = now() where id = $1`, [scan.id, message]);
    return { ...s, status: 'FAILED', error: message };
  }
  return s;
}

/** Mark a random sample of the sent, classified emails for the conveyancer to check (§3). */
async function drawCheckSample(scan: ScanRow): Promise<void> {
  const rows = await query<{ id: string }>(`select id from workload_email where scan_id = $1 and direction = 'out' and filtered is null and category is not null order by id`, [scan.id]);
  const pick = drawSample(rows, SAMPLE_SIZE, scan.id).map((r) => r.id);
  if (pick.length) await query(`update workload_email set in_sample = true where id = any($1)`, [pick]);
}

/** The emails to check, read live from Outlook (nothing is stored). */
export async function checkQueue(user: SessionUser, scan: ScanRow): Promise<Array<{ id: string; category: string; checked: string | null; subject: string; people: string; sentAt: string | null; text: string; webLink: string | null; gone: boolean }>> {
  const rows = await query<{ id: string; graph_message_id: string; category: string; checked_category: string | null }>(
    `select id, graph_message_id, category, checked_category from workload_email where scan_id = $1 and in_sample order by id`, [scan.id]
  );
  return inParallel(rows, 5, async (r) => {
    const m = await getMessageForCheck(user.userId, r.graph_message_id).catch(() => null);
    return { id: r.id, category: r.category, checked: r.checked_category, subject: m?.subject ?? '', people: m?.people ?? '', sentAt: m?.sentAt ?? null, text: (m?.text ?? '').slice(0, 3000), webLink: m?.webLink ?? null, gone: !m };
  });
}

/** The conveyancer's answer for one checked email: the right category (the same one when they agree). */
export async function recordCheck(user: SessionUser, scanId: string, emailId: string, category: OutCategory): Promise<void> {
  if (!OUT_CATEGORIES.includes(category)) throw Object.assign(new Error('Not a category.'), { status: 400 });
  const r = await queryOne<{ id: string }>(
    `update workload_email set checked_category = $4, checked_at = now() where id = $3 and scan_id = $2 and user_id = $1 and in_sample returning id`,
    [user.userId, scanId, emailId, category]
  );
  if (!r) throw Object.assign(new Error('That email is not in the sample.'), { status: 404 });
}

export async function finishScan(userId: string, scanId: string): Promise<void> {
  await query(`update workload_scan set status = 'COMPLETE', completed_at = now(), updated_at = now() where id = $1 and user_id = $2 and status = 'CHECKING'`, [scanId, userId]);
}

/** The firm's settings for the report, from the latest firm_baseline row. */
export async function firmSettings(tenantId: string): Promise<Partial<Settings>> {
  const b = await queryOne<{ hours_per_case: string | null; fee_per_completion_pennies: string | null; pay_per_completion_pennies: string | null; contracted_hours: string | null; typing_wpm: number | null; workday_start: string | null; workday_end: string | null }>(
    `select hours_per_case, fee_per_completion_pennies, pay_per_completion_pennies, contracted_hours, typing_wpm, workday_start, workday_end from firm_baseline where tenant_id = $1 order by recorded_at desc limit 1`, [tenantId]
  ).catch(() => null);
  const num = (x: string | number | null | undefined) => (x == null ? undefined : Number(x));
  return {
    hoursPerCompletion: num(b?.hours_per_case) ?? null,
    feePerCompletionPennies: num(b?.fee_per_completion_pennies) ?? null,
    payPerCompletionPennies: num(b?.pay_per_completion_pennies) ?? null,
    contractedHours: num(b?.contracted_hours),
    wpm: num(b?.typing_wpm),
    workdayStart: b?.workday_start ?? undefined,
    workdayEnd: b?.workday_end ?? undefined,
  };
}

export async function estimatesOf(userId: string): Promise<Partial<Record<OutCategory, number>>> {
  const rows = await query<{ category: OutCategory; minutes: string }>(`select category, minutes from workload_estimate where user_id = $1`, [userId]);
  return Object.fromEntries(rows.map((r) => [r.category, Number(r.minutes)]));
}

export async function saveEstimates(user: SessionUser, estimates: Record<string, number | null>): Promise<void> {
  for (const [category, minutes] of Object.entries(estimates)) {
    if (!OUT_CATEGORIES.includes(category as OutCategory)) continue;
    if (minutes == null || Number.isNaN(Number(minutes))) { await query(`delete from workload_estimate where user_id = $1 and category = $2`, [user.userId, category]); continue; }
    await query(
      `insert into workload_estimate (tenant_id, user_id, category, minutes) values ($1, $2, $3, $4) on conflict (user_id, category) do update set minutes = excluded.minutes, updated_at = now()`,
      [user.tenantId, user.userId, category, Math.max(0, Math.min(240, Number(minutes)))]
    );
  }
}

/** A scan's report, from its rows, the firm's settings and the conveyancer's estimates. */
export async function reportFor(scan: ScanRow, settings: Partial<Settings>, estimates: Partial<Record<OutCategory, number>>): Promise<Report> {
  const rows = await query<{ direction: 'out' | 'in'; category: string | null; filtered: Filtered | null; sent_at: Date; drafted_at: Date | null; words_written: number; in_sample: boolean; checked_category: string | null }>(
    `select direction, category, filtered, sent_at, drafted_at, words_written, in_sample, checked_category from workload_email where scan_id = $1`, [scan.id]
  );
  const asRows: Row[] = rows.map((r) => ({ direction: r.direction, category: r.category, filtered: r.filtered, sentAt: iso(r.sent_at), draftedAt: r.drafted_at ? iso(r.drafted_at) : null, wordsWritten: r.words_written, inSample: r.in_sample, checkedCategory: r.checked_category }));
  return buildReport({ rows: asRows, since: scan.since, until: scan.until, settings, estimates });
}
