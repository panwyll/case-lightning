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
async function safe<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  try {
    return (await query(sql)) as T[];
  } catch (err) {
    console.warn('[internal metrics] query failed:', (err as Error).message);
    return [];
  }
}

export async function GET(req: NextRequest) {
  try {
    assertFeature('db');
    if (!config.internalDashboardKey) {
      return fail(new Error('INTERNAL_DASHBOARD_KEY is not set — internal dashboard is disabled.'));
    }
    if (!authorize(req)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }

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
    ] = await Promise.all([
      safe('select * from v_funnel_global'),
      safe('select * from v_global_economics'),
      safe('select * from v_tenant_economics order by gross_profit_pennies_30d desc nulls last'),
      safe('select * from v_user_economics order by ai_cost_usd_30d desc nulls last limit 100'),
      safe('select * from v_usage_by_feature'),
      safe('select * from v_usage_by_user order by cost_usd desc nulls last limit 100'),
      safe('select * from v_acquisition_monthly'),
      safe('select * from v_churn_monthly'),
      safe('select * from v_mrr_movement_monthly'),
      safe('select * from v_retention_summary'),
      safe("select * from v_visits_daily where day >= current_date - interval '60 days' order by day"),
      safe('select * from v_visits_by_channel limit 50'),
      safe('select * from v_revenue_by_tenant'),
    ]);

    return ok({
      generatedAt: new Date().toISOString(),
      funnel,
      economics: { global: global[0] ?? null, byTenant: tenants, byUser: users },
      usage: { byFeature: usageByFeature, byUser: usageByUser },
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
