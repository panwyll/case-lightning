/**
 * The owner's console (/internal): what is happening across every firm. Overview, firms (and
 * one firm in depth), billing and comps, usage and cost, and errors from every source. Each
 * query is best-effort: one that fails returns empty rather than blanking the page.
 */
import { query } from './db';
import { listFirms } from './firms-admin';
import { getTenantBilling } from './plan';

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  try { return (await query(sql, params)) as T[]; } catch (err) {
    // Before migration 112 there is no app_error table: the other sources still show.
    if (/app_error/.test((err as Error).message) && sql.includes('from app_error')) return rows<T>(sql.replace(/select created_at, source, coalesce\(route, ''\) as route, status, message, detail, tenant_id from app_error\s*union all/, ''), params);
    console.warn('[internal console]', (err as Error).message);
    return [];
  }
}
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await rows<T>(sql, params))[0] ?? null;

type Firm = Awaited<ReturnType<typeof listFirms>>[number];
export function standing(f: Pick<Firm, 'comp_plan' | 'comp_until' | 'graceEndsAt' | 'status' | 'entitled'>): 'comped' | 'grace' | 'trial' | 'paying' | 'suspended' | 'pilot' {
  if (f.status === 'pilot') return 'pilot';
  if (f.comp_plan && (!f.comp_until || new Date(f.comp_until) > new Date())) return 'comped';
  if (f.graceEndsAt) return 'grace';
  if (f.status === 'trialing') return 'trial';
  return f.entitled ? 'paying' : 'suspended';
}

/** Errors from every source, newest first: server errors, failed AI calls, failed engine sends, failed billing reports. */
const ERRORS_SQL = `
select * from (
  select created_at, source, coalesce(route, '') as route, status, message, detail, tenant_id from app_error
  union all
  select created_at, 'ai' as source, event_type || ' · ' || coalesce(model, '') as route, null::int as status, coalesce(meta->>'error', '(no reason recorded)') as message, null::text as detail, tenant_id from usage_event where status = 'FAILED'
  union all
  select created_at, 'send' as source, coalesce(payload->>'action', '') as route, null::int as status, coalesce(payload->>'reason', '(no reason recorded)') as message, null::text as detail, tenant_id from matter_event where type = 'action_failed'
  union all
  select charged_at as created_at, 'billing' as source, 'case charge' as route, null::int as status, coalesce(stripe_error, 'Stripe report failed') as message, null::text as detail, tenant_id from matter_charge where unbilled_reason = 'ERROR'
) e
where created_at >= now() - make_interval(days => $1::int) and ($2::text is null or source = $2::text) and ($3::uuid is null or tenant_id = $3::uuid)
order by created_at desc limit 500`;

export async function overview() {
  const firms = await listFirms();
  const count = (s: ReturnType<typeof standing>) => firms.filter((f) => standing(f) === s).length;
  const [cases, ai, errors, held, recentErrors] = await Promise.all([
    one<{ month: number; billed: number; pennies: string; all_time: number }>(`select count(*) filter (where charged_at >= date_trunc('month', now()))::int as month, count(*) filter (where billed and charged_at >= date_trunc('month', now()))::int as billed, coalesce(sum(amount_pennies) filter (where billed and charged_at >= date_trunc('month', now())), 0)::text as pennies, count(*)::int as all_time from matter_charge`),
    one<{ calls_24h: number; failed_24h: number; cost_30d: string; calls_30d: number }>(`select count(*) filter (where created_at >= now() - interval '1 day')::int as calls_24h, count(*) filter (where status = 'FAILED' and created_at >= now() - interval '1 day')::int as failed_24h, coalesce(sum(cost_usd) filter (where created_at >= now() - interval '30 days'), 0)::text as cost_30d, count(*) filter (where created_at >= now() - interval '30 days')::int as calls_30d from usage_event`),
    one<{ n: number }>(`select count(*)::int as n from (${ERRORS_SQL}) x`, [1, null, null]),
    one<{ n: number }>(`select count(*)::int as n from held_mail`),
    rows(ERRORS_SQL.replace('limit 500', 'limit 8'), [7, null, null]),
  ]);
  return {
    firms: { total: firms.length, new30d: firms.filter((f) => Date.now() - new Date(f.created_at).getTime() < 30 * 86_400_000).length, paying: count('paying'), trial: count('trial'), comped: count('comped'), grace: count('grace'), suspended: count('suspended') },
    cases, ai, errors24h: errors?.n ?? 0, heldMail: held?.n ?? 0, recentErrors,
    recentFirms: firms.slice(0, 6).map((f) => ({ id: f.id, name: f.name, contact: f.contact, created_at: f.created_at, standing: standing(f), users: f.users, cases: f.cases })),
  };
}

export async function firms() {
  const list = await listFirms();
  const extra = await rows<{ tenant_id: string; last_seen: string | null; ai_cost_30d: string; ai_calls_30d: number; charged: number; errors_7d: number }>(`
    select t.id as tenant_id,
           greatest((select max(created_at) from audit_log a where a.tenant_id = t.id), (select max(created_at) from usage_event u where u.tenant_id = t.id))::text as last_seen,
           coalesce((select sum(cost_usd) from usage_event u where u.tenant_id = t.id and u.created_at >= now() - interval '30 days'), 0)::text as ai_cost_30d,
           (select count(*) from usage_event u where u.tenant_id = t.id and u.created_at >= now() - interval '30 days')::int as ai_calls_30d,
           (select count(*) from matter_charge c where c.tenant_id = t.id)::int as charged,
           (select count(*) from usage_event u where u.tenant_id = t.id and u.status = 'FAILED' and u.created_at >= now() - interval '7 days')::int as errors_7d
      from tenant t`);
  const by = new Map(extra.map((e) => [e.tenant_id, e]));
  return list.map((f) => ({ ...f, standing: standing(f), ...(by.get(f.id) ?? {}) }));
}

export async function firm(tenantId: string) {
  const [info, billing, users, events, charges, usage, errors] = await Promise.all([
    one(`select t.id, t.name, t.created_at::text, (select email from app_user u where u.tenant_id = t.id order by (u.role = 'ADMIN') desc, u.created_at limit 1) as contact from tenant t where t.id = $1`, [tenantId]),
    getTenantBilling(tenantId).catch(() => null),
    rows(`select u.email, u.display_name, u.role, u.created_at::text, greatest((select max(created_at) from audit_log a where a.actor_user_id = u.id), (select max(created_at) from usage_event e where e.actor_user_id = u.id))::text as last_seen from app_user u where u.tenant_id = $1 order by u.created_at`, [tenantId]),
    rows(`select occurred_at::text, event_type, from_status, to_status from subscription_event where tenant_id = $1 order by occurred_at desc limit 50`, [tenantId]),
    rows(`select c.charged_at::text, m.matter_ref, m.property_address, c.trigger_feature, c.billed, c.unbilled_reason, c.amount_pennies from matter_charge c left join matter m on m.id = c.matter_id where c.tenant_id = $1 order by c.charged_at desc limit 100`, [tenantId]),
    rows(`select event_type, count(*)::int as calls, count(*) filter (where status = 'FAILED')::int as failed, coalesce(sum(cost_usd), 0)::text as cost from usage_event where tenant_id = $1 and created_at >= now() - interval '30 days' group by 1 order by 2 desc`, [tenantId]),
    rows(ERRORS_SQL.replace('limit 500', 'limit 50'), [30, null, tenantId]),
  ]);
  const comp = await one<{ comp_plan: string | null; comp_until: string | null }>(`select comp_plan, comp_until::text from billing_account where tenant_id = $1 order by updated_at desc limit 1`, [tenantId]);
  return { info, billing, comp, users, events, charges, usage, errors };
}

export async function billing() {
  const list = await listFirms();
  const [events, byReason, monthly, failures] = await Promise.all([
    rows(`select e.occurred_at::text, e.event_type, e.from_status, e.to_status, case when t.name ~ '^Tenant-' then coalesce((select email from app_user u where u.tenant_id = t.id order by u.created_at limit 1), 'Unnamed firm') else t.name end as firm, e.tenant_id from subscription_event e left join tenant t on t.id = e.tenant_id order by e.occurred_at desc limit 100`),
    rows(`select case when billed then 'Billed' else coalesce(unbilled_reason, 'Unbilled') end as reason, count(*)::int as cases, coalesce(sum(amount_pennies), 0)::text as pennies from matter_charge group by 1 order by 2 desc`),
    rows(`select to_char(date_trunc('month', charged_at), 'YYYY-MM') as month, count(*)::int as cases, count(*) filter (where billed)::int as billed, coalesce(sum(amount_pennies) filter (where billed), 0)::text as pennies from matter_charge group by 1 order by 1 desc limit 12`),
    rows(`select c.charged_at::text, t.name as firm, c.stripe_error from matter_charge c left join tenant t on t.id = c.tenant_id where c.unbilled_reason = 'ERROR' order by c.charged_at desc limit 50`),
  ]);
  const firmsWith = list.map((f) => ({ ...f, standing: standing(f) }));
  return { firms: firmsWith, events, byReason, monthly, failures };
}

export async function usage(days: number) {
  const [daily, byFeature, byModel, byFirm] = await Promise.all([
    rows(`select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, count(*)::int as calls, count(*) filter (where status = 'FAILED')::int as failed, coalesce(sum(cost_usd), 0)::text as cost from usage_event where created_at >= now() - make_interval(days => $1::int) group by 1 order by 1`, [days]),
    rows(`select event_type as feature, count(*)::int as calls, count(*) filter (where status = 'FAILED')::int as failed, coalesce(sum(cost_usd), 0)::text as cost, coalesce(avg(latency_ms), 0)::int as avg_ms from usage_event where created_at >= now() - make_interval(days => $1::int) group by 1 order by 4 desc`, [days]),
    rows(`select coalesce(model, '—') as model, count(*)::int as calls, count(*) filter (where status = 'FAILED')::int as failed, coalesce(sum(cost_usd), 0)::text as cost, coalesce(sum(input_tokens), 0)::text as input_tokens, coalesce(sum(output_tokens), 0)::text as output_tokens from usage_event where created_at >= now() - make_interval(days => $1::int) group by 1 order by 4 desc`, [days]),
    rows(`select case when t.name ~ '^Tenant-' then coalesce((select email from app_user x where x.tenant_id = t.id order by x.created_at limit 1), 'Unnamed firm') else t.name end as firm, u.tenant_id, count(*)::int as calls, count(*) filter (where u.status = 'FAILED')::int as failed, coalesce(sum(u.cost_usd), 0)::text as cost from usage_event u left join tenant t on t.id = u.tenant_id where u.created_at >= now() - make_interval(days => $1::int) group by 1, 2 order by 5 desc limit 100`, [days]),
  ]);
  return { daily, byFeature, byModel, byFirm };
}

export async function errors(days: number, source: string | null, tenantId: string | null) {
  const list = await rows<{ created_at: string; source: string; route: string; status: number | null; message: string; detail: string | null; tenant_id: string | null }>(ERRORS_SQL, [days, source, tenantId]);
  const names = new Map((await rows<{ id: string; name: string }>(`select t.id, case when t.name ~ '^Tenant-' then coalesce((select email from app_user u where u.tenant_id = t.id order by u.created_at limit 1), 'Unnamed firm') else t.name end as name from tenant t`)).map((t) => [t.id, t.name]));
  // The same failure, repeated: grouped by where and the first words of what, so a flood reads as one line.
  const groups = new Map<string, { source: string; route: string; message: string; count: number; last: string }>();
  for (const e of list) {
    const key = `${e.source}|${e.route}|${e.message.replace(/[0-9a-f]{8}-[0-9a-f-]{27}|\d+/gi, '#').slice(0, 90)}`;
    const g = groups.get(key);
    if (g) { g.count += 1; if (e.created_at > g.last) g.last = e.created_at; }
    else groups.set(key, { source: e.source, route: e.route, message: e.message, count: 1, last: e.created_at });
  }
  return { errors: list.map((e) => ({ ...e, firm: e.tenant_id ? names.get(e.tenant_id) ?? null : null })), groups: [...groups.values()].sort((a, b) => b.count - a.count) };
}
