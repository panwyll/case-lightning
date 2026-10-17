/**
 * How the firm's correspondence is landing (Analytics → Cases), once the routine work is automated: what is left to watch
 * is how quickly people hear from us, how much of a case's life waits on us, and whether what goes out lands (bounces,
 * secure links opened, follow-ups, drafts approved as written). The last four weeks beside the four before.
 */
import { query, queryOne } from '../db';

export interface MessagingWindow {
  /** Hours from an email to us to the next one we sent on that conversation: everyone, and clients. */
  replyHours: number | null;
  clientReplyHours: number | null;
  replies: number;
  /** Share of live cases' time with something on our side of the Tasks list. */
  waitingOnUs: number | null;
  /** Messages CONVEYi sent, and the share answered within two days by a question, a chase or "any news?" from the case. */
  sent: number;
  followUpRate: number | null;
  /** Share of those messages that bounced. */
  bounceRate: number | null;
  /** Secure file links sent, and the share opened. */
  links: number;
  linksOpened: number | null;
  /** Messages a person approved or rejected, and the share approved exactly as CONVEYi drafted them. */
  reviewed: number;
  approvedAsDrafted: number | null;
}

const DAY = 86_400_000;
const r1 = (x: number) => Math.round(x * 10) / 10;
const share = (n: number, d: number) => (d ? n / d : null);

async function windowOf(tenantId: string, from: Date, to: Date): Promise<MessagingWindow> {
  const [replies, tasks, live, sent, links, reviewed] = await Promise.all([
    // Each email to us that was answered (within 14 days, on its conversation), and how long that took.
    query<{ client: boolean; hours: number }>(
      `select 'client' = any(r.roles) as client, extract(epoch from (min(s.at) - r.at)) / 3600 as hours
         from epa_action r join epa_action s on s.tenant_id = r.tenant_id and s.conversation_id = r.conversation_id and s.source = 'sent' and s.at > r.at and s.at <= r.at + interval '14 days'
        where r.tenant_id = $1 and r.source = 'received' and r.conversation_id is not null and coalesce(r.category, '') <> 'other' and r.at >= $2 and r.at < $3
        group by r.id, r.roles, r.at`, [tenantId, from, to]
    ).catch(() => []),
    // Every stretch a task of ours was open on a case, within the window.
    query<{ matter_id: string; a: Date; b: Date | null }>(
      `select matter_id, opened_at as a, closed_at as b from task_record where tenant_id = $1 and bucket in ('do', 'escalate') and opened_at < $3 and (closed_at is null or closed_at > $2)`, [tenantId, from, to]
    ).catch(() => []),
    queryOne<{ n: number }>(
      `select count(*)::int as n from matter_engine_state s join matter m on m.id = s.matter_id
        where m.tenant_id = $1 and s.state->>'enrolled' = 'true' and s.state->>'closedAt' is null and coalesce(m.sandbox, false) = false`, [tenantId]
    ).catch(() => null),
    // What CONVEYi sent by email, whether it bounced, and whether the case wrote back within two days asking again.
    query<{ bounced: boolean; followed: boolean }>(
      `select c.status like 'FAILED%' as bounced,
              exists (select 1 from epa_action r where r.tenant_id = c.tenant_id and r.source = 'received' and r.case_id = c.matter_id::text
                         and r.category in ('question', 'update_request', 'chaser_received') and r.at > c.created_at and r.at <= c.created_at + interval '2 days') as followed
         from client_message c where c.tenant_id = $1 and c.direction = 'OUT' and c.channel = 'email' and c.created_at >= $2 and c.created_at < $3`, [tenantId, from, to]
    ).catch(() => []),
    queryOne<{ n: number; opened: number }>(
      `select count(*)::int as n, count(first_opened_at)::int as opened from file_share where tenant_id = $1 and created_at >= $2 and created_at < $3`, [tenantId, from, to]
    ).catch(() => null),
    queryOne<{ n: number; asis: number }>(
      `select count(*)::int as n, count(*) filter (where type = 'action_approved' and payload->'edited' is null)::int as asis
         from matter_event where tenant_id = $1 and type in ('action_approved', 'action_rejected') and created_at >= $2 and created_at < $3`, [tenantId, from, to]
    ).catch(() => null),
  ]);
  const avg = (xs: number[]) => (xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  // Our time: each case's stretches with a task open, merged so two tasks at once count once.
  const byCase = new Map<string, Array<[number, number]>>();
  for (const t of tasks) {
    const a = Math.max(t.a.getTime(), from.getTime());
    const b = Math.min((t.b ?? to).getTime(), to.getTime());
    if (b > a) (byCase.get(t.matter_id) ?? byCase.set(t.matter_id, []).get(t.matter_id)!).push([a, b]);
  }
  let ours = 0;
  for (const xs of byCase.values()) {
    xs.sort((p, q) => p[0] - q[0]);
    let [s, e] = xs[0];
    for (const [a, b] of xs.slice(1)) { if (a <= e) e = Math.max(e, b); else { ours += e - s; [s, e] = [a, b]; } }
    ours += e - s;
  }
  const caseTime = (live?.n ?? 0) * (to.getTime() - from.getTime());
  return {
    replyHours: avg(replies.map((x) => Number(x.hours))),
    clientReplyHours: avg(replies.filter((x) => x.client).map((x) => Number(x.hours))),
    replies: replies.length,
    waitingOnUs: caseTime ? Math.min(1, ours / caseTime) : null,
    sent: sent.length,
    followUpRate: share(sent.filter((x) => x.followed).length, sent.length),
    bounceRate: share(sent.filter((x) => x.bounced).length, sent.length),
    links: links?.n ?? 0,
    linksOpened: share(links?.opened ?? 0, links?.n ?? 0),
    reviewed: reviewed?.n ?? 0,
    approvedAsDrafted: share(reviewed?.asis ?? 0, reviewed?.n ?? 0),
  };
}

/** The last four weeks, and the four before. */
export async function messagingMetrics(tenantId: string, now = new Date()): Promise<{ current: MessagingWindow; previous: MessagingWindow }> {
  const a = new Date(now.getTime() - 28 * DAY);
  const b = new Date(now.getTime() - 56 * DAY);
  const [current, previous] = await Promise.all([windowOf(tenantId, a, now), windowOf(tenantId, b, a)]);
  return { current, previous };
}
