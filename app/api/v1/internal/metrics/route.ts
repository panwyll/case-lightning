import { NextRequest } from 'next/server';
import { assertFeature, config } from '@/lib/server/config';
import { query } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Owner-only global analytics feed for the internal dashboard (app/internal).
 * Gated by INTERNAL_DASHBOARD_KEY — sent as a Bearer token or ?key=. This is
 * cross-tenant data, deliberately NOT behind the per-tenant Outlook/Entra session.
 */
function authorize(req: NextRequest): boolean {
  const key = config.internalDashboardKey;
  if (!key) return false; // not configured → locked
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const provided = bearer || req.nextUrl.searchParams.get('key') || '';
  return provided.length > 0 && provided === key;
}

/** Run a view query, returning [] on any error so one bad view can't blank the page. */
async function safe<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  try {
    return (await query(sql, params)) as T[];
  } catch (err) {
    console.warn('[internal metrics] query failed:', (err as Error).message);
    return [];
  }
}

/**
 * The funnel, over a window.
 *
 * v_funnel_global counts everything ever recorded, which answers "how have we done in
 * total" and nothing else — you can't ask how last week went, which is the question you
 * actually have. A view can't take a parameter, so the windowed version lives here with
 * `since` bound in.
 *
 * The last stage is deliberately NOT windowed: "retained" is a state you're in now, not
 * an event that happened in the window, so filtering it by date would be meaningless.
 * Pass since = null for all time.
 */
const FUNNEL_SQL = `
with stages(stage, ord, cnt) as (
  values
    ('Visitors',              1, (select count(distinct visitor_id) from pageview_event
                                   where $1::timestamptz is null or created_at >= $1::timestamptz)),
    ('Viewed pricing/trial',  2, (select count(distinct visitor_id) from pageview_event
                                   where path ~* '(pricing|start-trial|get-started)'
                                     and ($1::timestamptz is null or created_at >= $1::timestamptz))),
    ('Joined waitlist',       3, (select count(*) from leads
                                   where $1::timestamptz is null or created_at >= $1::timestamptz)),
    ('Account created',       4, (select count(*) from billing_account
                                   where $1::timestamptz is null or created_at >= $1::timestamptz)),
    ('Activated (did something)', 5, (select count(distinct tenant_id) from audit_log
                                   where $1::timestamptz is null or created_at >= $1::timestamptz)),
    ('Created a matter',      6, (select count(distinct tenant_id) from matter
                                   where $1::timestamptz is null or created_at >= $1::timestamptz)),
    ('Paid',                  7, (select count(distinct billing_account_id) from subscription_event
                                   where event_type = 'PAID'
                                     and ($1::timestamptz is null or occurred_at >= $1::timestamptz))),
    ('Retained (active 30d+)',8, (select count(*) from billing_account
                                   where status = 'active' and created_at < now() - interval '30 days'))
)
select
  stage,
  ord as stage_order,
  cnt as count,
  round(100.0 * cnt / nullif(first_value(cnt) over (order by ord), 0), 1) as pct_of_top,
  round(100.0 * cnt / nullif(lag(cnt) over (order by ord), 0), 1) as conversion_from_prev_pct,
  greatest(coalesce(lag(cnt) over (order by ord), cnt) - cnt, 0) as dropoff_from_prev
from stages
order by ord`;

export async function GET(req: NextRequest) {
  try {
    assertFeature('db');
    if (!config.internalDashboardKey) {
      return fail(new Error('INTERNAL_DASHBOARD_KEY is not set — internal dashboard is disabled.'));
    }
    if (!authorize(req)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }

    // ?days=N windows the funnel and the daily series; ?days=all (or 0) means all time.
    // Defaults to 30 — "how are we doing lately" is the question you actually ask.
    const daysParam = req.nextUrl.searchParams.get('days') ?? '30';
    const days = daysParam === 'all' ? null : Math.max(1, Math.min(3650, Number(daysParam) || 30));
    const since = days === null ? null : new Date(Date.now() - days * 86_400_000).toISOString();
    // Daily series always cover at least the selected window.
    const seriesDays = days === null ? 3650 : Math.max(days, 30);

    const [
      funnel,
      global,
      tenants,
      users,
      usageByFeature,
      usageByUser,
      acquisitionMonthly,
      churnMonthly,
      mrrMovement,
      retention,
      visitsDaily,
      visitsByChannel,
      revenueByTenant,
      signupsDaily,
      tenantSignups,
    ] = await Promise.all([
      safe(FUNNEL_SQL, [since]),
      safe('select * from v_global_economics'),
      safe('select * from v_tenant_economics order by gross_profit_pennies_30d desc nulls last'),
      safe('select * from v_user_economics order by ai_cost_usd_30d desc nulls last limit 100'),
      safe('select * from v_usage_by_feature'),
      safe('select * from v_usage_by_user order by cost_usd desc nulls last limit 100'),
      safe('select * from v_acquisition_monthly'),
      safe('select * from v_churn_monthly'),
      safe('select * from v_mrr_movement_monthly'),
      safe('select * from v_retention_summary'),
      safe('select * from v_visits_daily where day >= current_date - make_interval(days => $1::int) order by day', [seriesDays]),
      safe('select * from v_visits_by_channel limit 50'),
      safe('select * from v_revenue_by_tenant'),
      safe('select * from v_signups_daily where day >= current_date - make_interval(days => $1::int) order by day', [seriesDays]),
      safe('select * from v_tenant_signups limit 200'),
    ]);

    return ok({
      generatedAt: new Date().toISOString(),
      window: { days, since },
      funnel,
      economics: { global: global[0] ?? null, byTenant: tenants, byUser: users },
      usage: { byFeature: usageByFeature, byUser: usageByUser },
      // Pre-revenue view: who has connected at all, not just who has paid.
      signups: { daily: signupsDaily, byTenant: tenantSignups },
      acquisition: acquisitionMonthly,
      churn: churnMonthly,
      mrrMovement,
      retention: retention[0] ?? null,
      visits: { daily: visitsDaily, byChannel: visitsByChannel },
      revenueByTenant,
    });
  } catch (error) {
    return fail(error);
  }
}
