/**
 * Onboarding importer: discover the cases already in flight in a user's mailbox
 * and (after the user confirms) provision them as real matters.
 *
 * This is the inverse of matching.ts. The matching engine scores an incoming
 * email against EXISTING matters; here there are no matters yet, so we discover
 * them bottom-up: stage the backlog → cluster it into candidate cases by hard
 * structural signals (shared postcode, shared participants) → ask the AI to
 * confirm each cluster is a conveyancing matter and extract its details → on
 * confirmation, reuse createMatter()/extractFacts() to provision exactly as the
 * interactive flow does.
 *
 * The job advances one bounded slice per `advanceJob` call so no request
 * approaches the serverless timeout. State machine:
 *   SCANNING → CLUSTERING → PROPOSING → AWAITING_REVIEW
 *     → (confirm) → PROVISIONING → COMPLETED
 */
import { query, queryOne } from './db';
import { listMailSince, listThreadMessages, appendTrackerRow, describeGraphError } from './graph';
import { extractPostcodes } from './matching';
import { proposeMatter, extractFacts, upsertChunks } from './ai';
import { createMatter } from './matter';
import { isMeaningfulRef } from '../ref-name';
import { threadToText } from './text';
import { writeAudit } from './audit';
import type { SessionUser } from './types';

export interface OnboardingJob {
  id: string;
  tenant_id: string;
  user_id: string;
  status: string;
  lookback_months: number | null;
  since: string | null;
  scan_cursor: string | null;
  messages_scanned: number;
  threads_found: number;
  cases_proposed: number;
  cases_onboarded: number;
  error: string | null;
}

interface CaseRow {
  id: string;
  cluster_key: string;
  proposed_matter_ref: string | null;
  property_address: string | null;
  buyer_names: string[];
  seller_names: string[];
  counterparty_solicitor: string | null;
  counterparty_agent: string | null;
  conversation_ids: string[];
  edits: Record<string, unknown> | null;
}

// Safety bounds so a noisy / huge mailbox stays cheap and timeout-safe.
const MESSAGE_CAP = 30000;       // staged messages per job (premium deep scans)
const SCAN_PAGE_SIZE = 100;      // Graph page size while staging the backlog
const SCAN_SLICE_MS = 12000;     // wall-clock budget per scan slice; we drain as
                                 // many Graph pages as fit, so a 20k-mail backlog
                                 // stages in a handful of slices, not hundreds.
const PROPOSE_BATCH = 8;         // clusters considered per slice
const PROPOSE_CONCURRENCY = 4;   // proposeMatter (LLM) calls run in parallel, ≤ db pool
const PROVISION_BATCH = 2;       // matters provisioned per slice
const MIN_CONFIDENCE = 0.4;      // below this the AI proposal is treated as noise
const THREADS_PER_CASE = 5;      // conversations pulled for fact extraction

// Addresses that are clearly automated / bulk senders (no-reply, ESPs, marketing).
// Used both to keep these out of clustering and to gate what reaches the AI.
const NOISE_RE =
  /(no-?reply|do-?not-?reply|donotreply|noreply|notification|notify|mailer-daemon|mailer|newsletter|news@|bounce|postmaster|automated|campaign|unsubscribe|alerts?@|marketing|promo|mailchimp|sendgrid|amazonses|mailgun|sendinblue|hubspot|mktomail|sparkpost|salesforce)/i;
function isNoiseAddress(a?: string | null): boolean {
  return !a || NOISE_RE.test(a);
}

/** Lookback cutoff. null months = unlimited (premium only — gated by the caller). */
export function sinceForLookback(months: number | null): string | null {
  if (months === null) return null;
  return new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000).toISOString();
}

// ── Job lookup ────────────────────────────────────────────────────────────────

const JOB_COLUMNS =
  'id, tenant_id, user_id, status, lookback_months, since, scan_cursor, messages_scanned, threads_found, cases_proposed, cases_onboarded, error';

export async function getActiveJob(userId: string): Promise<OnboardingJob | null> {
  return queryOne<OnboardingJob>(
    `select ${JOB_COLUMNS} from onboarding_job
     where user_id = $1 and status not in ('COMPLETED','FAILED','CANCELLED')
     order by created_at desc limit 1`,
    [userId]
  );
}

export async function getLatestJob(userId: string): Promise<OnboardingJob | null> {
  return queryOne<OnboardingJob>(
    `select ${JOB_COLUMNS} from onboarding_job where user_id = $1 order by created_at desc limit 1`,
    [userId]
  );
}

async function reloadJob(jobId: string): Promise<OnboardingJob | null> {
  return queryOne<OnboardingJob>(`select ${JOB_COLUMNS} from onboarding_job where id = $1`, [jobId]);
}

// ── Step 1: scan ───────────────────────────────────────────────────────────────

/** Stage one Graph page in a single multi-row INSERT (vs. one round-trip each). */
async function stageMessages(user: SessionUser, jobId: string, messages: any[], own: string): Promise<void> {
  const placeholders: string[] = [];
  const values: unknown[] = [];
  let p = 0;
  for (const m of messages) {
    const from = m.from?.emailAddress?.address?.toLowerCase() ?? null;
    const recipients = [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])]
      .map((r: any) => r.emailAddress?.address?.toLowerCase())
      .filter(Boolean) as string[];
    const participants = Array.from(new Set([from, ...recipients].filter((x): x is string => !!x && x !== own)));
    const postcodes = extractPostcodes(`${m.subject ?? ''} ${m.bodyPreview ?? ''}`);

    placeholders.push(
      `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7},$${p + 8},$${p + 9},$${p + 10},$${p + 11})`
    );
    values.push(
      jobId,
      user.tenantId,
      m.id,
      m.conversationId ?? null,
      (m.subject ?? '').slice(0, 400),
      from,
      participants,
      m.receivedDateTime ?? null,
      (m.bodyPreview ?? '').slice(0, 600),
      postcodes,
      Boolean(m.hasAttachments)
    );
    p += 11;
  }
  if (!placeholders.length) return;
  await query(
    `insert into onboarding_message
      (job_id, tenant_id, graph_message_id, graph_conversation_id, subject, from_address, participants, received_at, body_preview, postcodes, has_attachments)
     values ${placeholders.join(',')}
     on conflict (job_id, graph_message_id) do nothing`,
    values
  );
}

async function scanPage(user: SessionUser, job: OnboardingJob): Promise<void> {
  if (job.messages_scanned >= MESSAGE_CAP) {
    await query(`update onboarding_job set status = 'CLUSTERING', updated_at = now() where id = $1`, [job.id]);
    return;
  }

  const own = user.email.toLowerCase();
  const deadline = Date.now() + SCAN_SLICE_MS;
  let cursor = job.scan_cursor; // Graph @odata.nextLink; null on the first slice
  let scanned = job.messages_scanned;

  // Drain pages until the slice budget is spent, the cap is hit, or mail runs out.
  // Pulling many pages per HTTP slice (instead of one) is the main scan speed-up.
  do {
    const { messages, nextLink } = await listMailSince(user.userId, job.since, cursor, SCAN_PAGE_SIZE);
    await stageMessages(user, job.id, messages, own);
    scanned += messages.length;
    cursor = nextLink;
  } while (cursor && scanned < MESSAGE_CAP && Date.now() < deadline);

  const done = !cursor || scanned >= MESSAGE_CAP;
  await query(
    `update onboarding_job set messages_scanned = $1, scan_cursor = $2, status = $3, updated_at = now() where id = $4`,
    [scanned, cursor, done ? 'CLUSTERING' : 'SCANNING', job.id]
  );
}

// ── Step 2: cluster ─────────────────────────────────────────────────────────────

class DSU {
  private parent = new Map<string, string>();
  add(x: string) {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  find(x: string): string {
    this.add(x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

async function clusterJob(job: OnboardingJob): Promise<void> {
  const msgs = await query<{
    graph_message_id: string;
    graph_conversation_id: string | null;
    participants: string[];
    postcodes: string[];
  }>(
    `select graph_message_id, graph_conversation_id, participants, postcodes from onboarding_message where job_id = $1`,
    [job.id]
  );

  const threadKey = (m: { graph_conversation_id: string | null; graph_message_id: string }) =>
    m.graph_conversation_id || m.graph_message_id;

  const dsu = new DSU();
  const threadParticipants = new Map<string, Set<string>>();
  const threadPostcodes = new Map<string, Set<string>>();
  const threadKeys = new Set<string>();

  for (const m of msgs) {
    const tk = threadKey(m);
    threadKeys.add(tk);
    dsu.add(tk);
    const ps = threadParticipants.get(tk) ?? new Set<string>();
    for (const p of m.participants ?? []) if (!isNoiseAddress(p)) ps.add(p.toLowerCase());
    threadParticipants.set(tk, ps);
    const pc = threadPostcodes.get(tk) ?? new Set<string>();
    for (const p of m.postcodes ?? []) pc.add(p.toUpperCase());
    threadPostcodes.set(tk, pc);
  }

  // Merge threads sharing a property postcode (the strongest conveyancing signal).
  const byPostcode = new Map<string, string[]>();
  for (const [tk, pcs] of threadPostcodes) {
    for (const pc of pcs) {
      const list = byPostcode.get(pc) ?? [];
      list.push(tk);
      byPostcode.set(pc, list);
    }
  }
  for (const list of byPostcode.values()) for (let i = 1; i < list.length; i++) dsu.union(list[0], list[i]);

  // Merge threads sharing ≥2 external participants (same people, same deal).
  const byPair = new Map<string, string[]>();
  for (const [tk, ps] of threadParticipants) {
    const arr = [...ps].sort();
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = `${arr[i]}|${arr[j]}`;
        const list = byPair.get(key) ?? [];
        list.push(tk);
        byPair.set(key, list);
      }
    }
  }
  for (const list of byPair.values()) for (let i = 1; i < list.length; i++) dsu.union(list[0], list[i]);

  // Assign stable cluster keys and write them back in one UPDATE per cluster.
  const rootToCluster = new Map<string, string>();
  let n = 0;
  const byCluster = new Map<string, string[]>();
  for (const m of msgs) {
    const root = dsu.find(threadKey(m));
    let ck = rootToCluster.get(root);
    if (!ck) {
      ck = `c${++n}`;
      rootToCluster.set(root, ck);
    }
    const ids = byCluster.get(ck) ?? [];
    ids.push(m.graph_message_id);
    byCluster.set(ck, ids);
  }
  for (const [ck, ids] of byCluster) {
    await query(`update onboarding_message set cluster_key = $1 where job_id = $2 and graph_message_id = any($3)`, [
      ck,
      job.id,
      ids,
    ]);
  }

  await query(`update onboarding_job set status = 'PROPOSING', threads_found = $1, updated_at = now() where id = $2`, [
    threadKeys.size,
    job.id,
  ]);
}

// ── Step 3: propose ──────────────────────────────────────────────────────────────

function buildDigest(
  msgs: Array<{ subject: string | null; from_address: string | null; participants: string[]; body_preview: string | null; received_at: string | Date | null }>
): string {
  const parts = msgs.slice(0, 40).map((m) => {
    // pg returns timestamptz columns as Date objects, so coerce before slicing —
    // calling .slice() on a Date throws and (until now) silently killed the proposal.
    const when = m.received_at ? new Date(m.received_at).toISOString().slice(0, 10) : '';
    return `[${when}] from ${m.from_address ?? 'unknown'} | to ${(m.participants ?? []).join(', ')}\nSubject: ${m.subject ?? ''}\n${m.body_preview ?? ''}`;
  });
  return parts.join('\n---\n').slice(0, 8000);
}

async function proposeNextClusters(user: SessionUser, job: OnboardingJob): Promise<void> {
  const clusters = await query<{ cluster_key: string; cnt: number; convs: string[] | null }>(
    `select cluster_key,
            count(*)::int as cnt,
            array_agg(distinct graph_conversation_id) filter (where graph_conversation_id is not null) as convs
     from onboarding_message
     where job_id = $1 and cluster_key is not null
       and cluster_key not in (select cluster_key from onboarding_case where job_id = $1)
     group by cluster_key
     order by count(*) desc
     limit $2`,
    [job.id, PROPOSE_BATCH]
  );

  if (!clusters.length) {
    await query(`update onboarding_job set status = 'AWAITING_REVIEW', updated_at = now() where id = $1`, [job.id]);
    return;
  }

  const own = user.email.toLowerCase();

  // The per-cluster proposal is dominated by one LLM round-trip, so run a bounded
  // number of clusters in parallel rather than strictly one after another.
  for (let i = 0; i < clusters.length; i += PROPOSE_CONCURRENCY) {
    await Promise.all(clusters.slice(i, i + PROPOSE_CONCURRENCY).map((c) => proposeCluster(user, job, c, own)));
  }
}

async function proposeCluster(
  user: SessionUser,
  job: OnboardingJob,
  c: { cluster_key: string; cnt: number; convs: string[] | null },
  own: string
): Promise<void> {
  {
    const msgs = await query<{
      subject: string | null;
      from_address: string | null;
      participants: string[];
      body_preview: string | null;
      received_at: string | null;
      postcodes: string[];
    }>(
      `select subject, from_address, participants, body_preview, received_at, postcodes
       from onboarding_message where job_id = $1 and cluster_key = $2 order by received_at asc limit 40`,
      [job.id, c.cluster_key]
    );

    const convs = (c.convs ?? []).filter(Boolean);

    // Deterministic noise gate BEFORE spending an AI call. A real conveyancing
    // matter resembles correspondence about a property/person — not a one-shot
    // marketing blast. We only look harder when the cluster has:
    //   • a property postcode AND a human (non-bulk) counterparty, OR
    //   • a message the user actually sent (you don't reply to a Nike promo), OR
    //   • a substantive multi-message thread with a human counterparty.
    const userReplied = msgs.some((m) => (m.from_address ?? '').toLowerCase() === own);
    const hasPostcode = msgs.some((m) => (m.postcodes ?? []).length > 0);
    const hasHuman = msgs.some((m) =>
      [m.from_address, ...(m.participants ?? [])]
        .filter(Boolean)
        .some((a) => (a as string).toLowerCase() !== own && !isNoiseAddress(a))
    );
    const worthProposing = (hasPostcode && hasHuman) || userReplied || (msgs.length >= 3 && hasHuman);

    if (!worthProposing) {
      await query(
        `insert into onboarding_case
          (job_id, tenant_id, cluster_key, confidence, rationale, thread_count, message_count, conversation_ids, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'REJECTED')
         on conflict (job_id, cluster_key) do nothing`,
        [
          job.id,
          user.tenantId,
          c.cluster_key,
          null,
          'Skipped — looks like automated or marketing mail (no property reference, no reply, not a real thread).',
          Math.max(1, new Set(convs).size),
          c.cnt,
          convs,
        ]
      );
      return;
    }

    let proposal: Awaited<ReturnType<typeof proposeMatter>> | null = null;
    let proposeError: string | null = null;
    try {
      proposal = await proposeMatter({ userId: user.userId, tenantId: user.tenantId, threadDigest: buildDigest(msgs) });
    } catch (error) {
      // Don't mask an AI failure as "not a conveyancing matter" — capture it so a
      // systemic problem (bad key/model, rate limit) is visible instead of 0 cases.
      proposeError = describeGraphError(error);
    }

    const isCase = !!proposal && proposal.isConveyancingCase && (proposal.confidence ?? 0) >= MIN_CONFIDENCE;
    const rationale = proposal?.rationale ?? (proposeError ? `AI proposal failed — ${proposeError}` : 'Not recognised as a conveyancing matter.');

    await query(
      `insert into onboarding_case
        (job_id, tenant_id, cluster_key, proposed_matter_ref, property_address, buyer_names, seller_names,
         counterparty_solicitor, counterparty_agent, confidence, rationale, thread_count, message_count, conversation_ids, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       on conflict (job_id, cluster_key) do nothing`,
      [
        job.id,
        user.tenantId,
        c.cluster_key,
        isCase && isMeaningfulRef(proposal!.suggestedRef) ? proposal!.suggestedRef!.trim() : null,
        isCase ? proposal!.propertyAddress || null : null,
        isCase ? proposal!.buyerNames ?? [] : [],
        isCase ? proposal!.sellerNames ?? [] : [],
        isCase ? proposal!.counterpartySolicitor || null : null,
        isCase ? proposal!.counterpartyAgent || null : null,
        proposal?.confidence ?? null,
        rationale,
        Math.max(1, new Set(convs).size),
        c.cnt,
        convs,
        isCase ? 'PROPOSED' : 'REJECTED',
      ]
    );

    if (isCase) {
      await query(`update onboarding_job set cases_proposed = cases_proposed + 1, updated_at = now() where id = $1`, [job.id]);
    }
  }
}

// ── Step 4: provision ────────────────────────────────────────────────────────────

async function ingestCaseThreads(user: SessionUser, matterId: string, c: CaseRow): Promise<void> {
  const convs = (c.conversation_ids ?? []).filter(Boolean).slice(0, THREADS_PER_CASE);
  const allMessages: any[] = [];
  for (const conv of convs) {
    await query(
      `insert into email_thread (tenant_id, matter_id, graph_thread_id, graph_conversation_id, subject)
       values ($1,$2,$3,$4,$5) on conflict (tenant_id, graph_thread_id) do nothing`,
      [user.tenantId, matterId, conv, conv, null]
    );
    try {
      allMessages.push(...(await listThreadMessages(user.userId, conv)));
    } catch {
      /* a thread may have been moved/deleted since the scan — skip it */
    }
  }
  if (!allMessages.length) return;

  const text = threadToText(allMessages).slice(0, 24000);
  const existing = await queryOne<{ facts: Record<string, unknown> }>(
    `select facts from matter_summary where matter_id = $1 and tenant_id = $2`,
    [matterId, user.tenantId]
  );
  const extracted = await extractFacts({
    userId: user.userId,
    tenantId: user.tenantId,
    matterId,
    threadText: text,
    existingFacts: existing?.facts ?? {},
  });

  await query(
    `update matter_summary set facts = $1::jsonb, outstanding_items = $2::jsonb, risks = $3::jsonb, updated_at = now()
     where matter_id = $4 and tenant_id = $5`,
    [JSON.stringify(extracted.facts), JSON.stringify(extracted.outstanding), JSON.stringify(extracted.risks), matterId, user.tenantId]
  );
  for (const item of extracted.timeline) {
    await query(
      `insert into matter_timeline_event (tenant_id, matter_id, event_type, title, details, source_ref)
       values ($1,$2,'EMAIL',$3,$4,$5::jsonb)`,
      [user.tenantId, matterId, item.title, item.details, JSON.stringify({ source: 'onboarding' })]
    );
  }
  await upsertChunks({ tenantId: user.tenantId, matterId, sourceKind: 'EMAIL', text, metadata: { source: 'onboarding' } });

  const matter = await queryOne<{ tracker_item_id: string | null }>(
    `select tracker_item_id from matter where id = $1 and tenant_id = $2`,
    [matterId, user.tenantId]
  );
  if (matter?.tracker_item_id) {
    const today = new Date().toISOString().slice(0, 10);
    for (const item of extracted.timeline) {
      await appendTrackerRow(user.userId, matter.tracker_item_id, {
        date: today,
        type: 'UPDATE',
        detail: `${item.title}: ${item.details}`.slice(0, 250),
        owner: '',
        due: '',
        status: 'NOTED',
      }).catch(() => {});
    }
    for (const o of extracted.outstanding) {
      await appendTrackerRow(user.userId, matter.tracker_item_id, {
        date: today,
        type: 'OUTSTANDING',
        detail: String(o).slice(0, 250),
        owner: '',
        due: '',
        status: 'OPEN',
      }).catch(() => {});
    }
  }
}

async function provisionNextApproved(user: SessionUser, job: OnboardingJob): Promise<void> {
  const cases = await query<CaseRow>(
    `select id, cluster_key, proposed_matter_ref, property_address, buyer_names, seller_names,
            counterparty_solicitor, counterparty_agent, conversation_ids, edits
     from onboarding_case where job_id = $1 and status = 'APPROVED' order by created_at asc limit $2`,
    [job.id, PROVISION_BATCH]
  );

  if (!cases.length) {
    await query(`update onboarding_job set status = 'COMPLETED', completed_at = now(), updated_at = now() where id = $1`, [job.id]);
    return;
  }

  for (const c of cases) {
    try {
      const edits = (c.edits ?? {}) as Record<string, any>;
      const propertyAddress = String(edits.propertyAddress ?? c.property_address ?? '').trim();
      if (!propertyAddress) throw new Error('No property address to provision.');
      const matterRef = String(edits.matterRef ?? c.proposed_matter_ref ?? '').trim();

      // De-dup guard: if a matter already exists for this property (e.g. created
      // manually between scan and confirm), link to it instead of duplicating.
      const dup = await queryOne<{ id: string }>(
        `select id from matter where tenant_id = $1 and lower(property_address) = lower($2) limit 1`,
        [user.tenantId, propertyAddress]
      );

      let matterId: string;
      if (dup) {
        matterId = dup.id;
      } else {
        const created = await createMatter(user, {
          matterRef: matterRef || propertyAddress,
          propertyAddress,
          buyerNames: (edits.buyerNames as string[]) ?? c.buyer_names ?? [],
          sellerNames: (edits.sellerNames as string[]) ?? c.seller_names ?? [],
          counterpartySolicitor: c.counterparty_solicitor ?? undefined,
          counterpartyAgent: c.counterparty_agent ?? undefined,
        });
        matterId = created.id;
      }

      await ingestCaseThreads(user, matterId, c);

      await query(`update onboarding_case set status = 'ONBOARDED', matter_id = $1, updated_at = now() where id = $2`, [matterId, c.id]);
      await query(`update onboarding_job set cases_onboarded = cases_onboarded + 1, updated_at = now() where id = $1`, [job.id]);
      await writeAudit({
        tenantId: user.tenantId,
        matterId,
        actorUserId: user.userId,
        actionType: 'ONBOARDING_CASE_PROVISIONED',
        actionStatus: 'SUCCESS',
        payload: { caseId: c.id, clusterKey: c.cluster_key, reusedExisting: Boolean(dup) },
      });
    } catch (error) {
      const message = describeGraphError(error);
      await query(`update onboarding_case set status = 'FAILED', error = $1, updated_at = now() where id = $2`, [message.slice(0, 500), c.id]);
      await writeAudit({
        tenantId: user.tenantId,
        actorUserId: user.userId,
        actionType: 'ONBOARDING_CASE_PROVISIONED',
        actionStatus: 'FAILED',
        payload: { caseId: c.id, error: message },
      });
    }
  }
}

// ── Orchestrator ────────────────────────────────────────────────────────────────

/** Advance a job by exactly one bounded slice and return its fresh state. */
export async function advanceJob(user: SessionUser, job: OnboardingJob): Promise<OnboardingJob> {
  try {
    switch (job.status) {
      case 'SCANNING':
        await scanPage(user, job);
        break;
      case 'CLUSTERING':
        await clusterJob(job);
        break;
      case 'PROPOSING':
        await proposeNextClusters(user, job);
        break;
      case 'PROVISIONING':
        await provisionNextApproved(user, job);
        break;
      default:
        break; // AWAITING_REVIEW / terminal — nothing to do
    }
  } catch (error) {
    const message = describeGraphError(error);
    await query(`update onboarding_job set status = 'FAILED', error = $1, updated_at = now() where id = $2`, [message.slice(0, 500), job.id]);
  }
  return (await reloadJob(job.id))!;
}

/** Statuses the orchestrator can advance on its own (vs. waiting on the user). */
export function isAutoAdvanceable(status: string): boolean {
  return ['SCANNING', 'CLUSTERING', 'PROPOSING', 'PROVISIONING'].includes(status);
}
