/**
 * Impact analytics from the historical import — a renewal-time "look how much this
 * firm corresponds" report. From the staged backlog we pair each incoming case email
 * with the firm's reply (in the same conversation) and measure the response gap.
 *
 * Only case emails that GOT a response count (per the spec). "Own" address = the
 * importing user's mailbox: messages from it are the firm's replies (outgoing), the
 * rest are incoming. One synthesis call's worth of plain SQL + arithmetic, no LLM.
 */
import { query, queryOne } from './db';
import { config } from './config';

export interface ImportAnalytics {
  available: boolean;
  cases: number; // distinct cases with at least one responded email
  responses: number; // responded incoming emails
  medianResponseMins: number;
  avgResponseMins: number;
  avgCaseResponseMins: number; // mean per case of its mean response time
  avgRepliesPerCase: number;
  estimatedHoursSaved: number; // responses × minutes-saved-per-reply (clearly an estimate)
}

const EMPTY: ImportAnalytics = {
  available: false,
  cases: 0,
  responses: 0,
  medianResponseMins: 0,
  avgResponseMins: 0,
  avgCaseResponseMins: 0,
  avgRepliesPerCase: 0,
  estimatedHoursSaved: 0,
};

export async function computeImportAnalytics(tenantId: string): Promise<ImportAnalytics> {
  // The most recent completed import, and the mailbox that ran it (the firm's "own").
  const job = await queryOne<{ id: string; user_id: string }>(
    `select id, user_id from onboarding_job
      where tenant_id = $1 and status = 'COMPLETED' order by created_at desc limit 1`,
    [tenantId]
  );
  if (!job) return EMPTY;
  const owner = await queryOne<{ email: string }>(`select email from app_user where id = $1`, [job.user_id]);
  const own = (owner?.email ?? '').toLowerCase();
  if (!own) return EMPTY;

  // Messages in clusters that are real cases (proposed/approved/onboarded), in time
  // order within each cluster.
  const rows = await query<{ cluster_key: string; from_address: string | null; received_at: string }>(
    `select msg.cluster_key, msg.from_address, msg.received_at
       from onboarding_message msg
       join onboarding_case c on c.job_id = msg.job_id and c.cluster_key = msg.cluster_key
      where msg.job_id = $1 and msg.received_at is not null
        and c.status in ('PROPOSED', 'APPROVED', 'ONBOARDED')
      order by msg.cluster_key, msg.received_at asc`,
    [job.id]
  );
  if (!rows.length) return EMPTY;

  // Per cluster, pair each incoming email with the firm's next reply → response gap.
  const gapsByCase = new Map<string, number[]>();
  let pendingT: number | null = null;
  let currentCluster = '';
  for (const r of rows) {
    if (r.cluster_key !== currentCluster) {
      currentCluster = r.cluster_key;
      pendingT = null;
    }
    const t = new Date(r.received_at).getTime();
    const outgoing = (r.from_address ?? '').toLowerCase() === own;
    if (outgoing) {
      if (pendingT !== null && t > pendingT) {
        const mins = (t - pendingT) / 60_000;
        if (mins > 0 && mins < 60 * 24 * 120) {
          // ignore > 120-day gaps (reopened threads / noise)
          if (!gapsByCase.has(currentCluster)) gapsByCase.set(currentCluster, []);
          gapsByCase.get(currentCluster)!.push(mins);
        }
        pendingT = null;
      }
    } else {
      pendingT = t; // most recent incoming becomes the one the next reply answers
    }
  }

  const allGaps: number[] = [];
  const caseMeans: number[] = [];
  for (const gaps of gapsByCase.values()) {
    if (!gaps.length) continue;
    allGaps.push(...gaps);
    caseMeans.push(gaps.reduce((a, b) => a + b, 0) / gaps.length);
  }
  if (!allGaps.length) return EMPTY;

  const sorted = [...allGaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = allGaps.reduce((a, b) => a + b, 0) / allGaps.length;
  const caseMean = caseMeans.reduce((a, b) => a + b, 0) / caseMeans.length;

  return {
    available: true,
    cases: gapsByCase.size,
    responses: allGaps.length,
    medianResponseMins: Math.round(median),
    avgResponseMins: Math.round(mean),
    avgCaseResponseMins: Math.round(caseMean),
    avgRepliesPerCase: Math.round((allGaps.length / gapsByCase.size) * 10) / 10,
    estimatedHoursSaved: Math.round((allGaps.length * config.estimatedMinutesSavedPerReply) / 60),
  };
}
