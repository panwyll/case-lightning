# Usage analytics & economics

Global, platform-owner analytics delivered as SQL views over a per-call metering
fact table. Point an external BI tool (Metabase, Grafana, Supabase charts) at the
Postgres database and query the views below. Migration: `009_analytics.sql`.

## How it's collected

Every metered model call writes one `usage_event` row at the chokepoints in
`lib/server/ai.ts` (`structured()`, `reviewDocument()`, `embed()`), via
`lib/server/usage.ts`. Captured per call: tenant, user, matter, feature, provider,
model, tier, input/output/cache tokens, **resolved USD cost**, latency, BYOK flag,
status. Metering is best-effort — a failed write never breaks the product path.

- **Cost is stored in USD** (`cost_usd`) — what the provider actually charged us.
  Rates live in `lib/server/pricing.ts` (mirrored into `model_price` for BI).
- **BYOK calls cost £0 to us** (`byok = true`, `cost_usd = 0`) — the user pays.
- **Revenue is GBP**; economics views convert USD→GBP via
  `analytics_param('gbp_per_usd')`. Update that row as FX moves:
  `update analytics_param set value = 0.81 where key = 'gbp_per_usd';`
- Subscription MRR comes from `plan_price` joined to `billing_account`.

## Views

| View | Answers |
|---|---|
| `v_usage_daily` | Daily calls/tokens/cost per tenant × user × feature × model (materialized rollup `mv_usage_daily`) |
| `v_usage_by_user` | Lifetime calls, tokens, cost, first/last active per user |
| `v_usage_by_tenant` | Calls, active users, tokens, cost per tenant |
| `v_usage_by_feature` | What gets used: calls/users/tenants/tokens/cost/latency per feature |
| `v_revenue_by_tenant` | Plan, status, MRR, credit balance per billing account |
| `v_tenant_economics` | **Profit per tenant (30d)**: active MRR − AI cost (GBP) |
| `v_user_economics` | **Profit per user (30d)**: tenant MRR allocated per active user − their AI cost |
| `v_global_economics` | **One-row global**: total MRR, total AI cost, gross profit, outstanding credit |
| `v_activity` | Raw union of audit actions + metered usage (tagged `source`) for ad-hoc exploration |
| `v_user_sessions` | Gap-based sessions (>30 min = new session): start/end, action count, `action_sequence` |
| `v_feature_funnel` | Feature adoption: distinct users/tenants/events per action |

### Notes on profit

- All profit/cost views use a trailing **30-day** window for cost, against current
  active MRR. Adjust the interval in the view if you want a different basis.
- `v_user_economics` allocates a tenant's MRR evenly across its active users
  (`MRR / active_user_count`) — a simplifying assumption, not exact attribution.
  Use `v_tenant_economics` / `v_global_economics` for true revenue figures.
- Monetary outputs are in **pennies (GBP)** unless suffixed `_usd`.

## The rollup

`mv_usage_daily` pre-aggregates the fact table. The live views don't depend on it,
so it's optional until volume is large. Refresh it via
`GET /api/v1/admin/analytics/refresh` (CRON_SECRET-protected). To run it daily, add
to `vercel.json` crons when the Hobby cron limit allows:

```json
{ "path": "/api/v1/admin/analytics/refresh", "schedule": "30 3 * * *" }
```

## Example queries

```sql
-- Global P&L right now
select * from v_global_economics;

-- Most/least profitable tenants
select tenant_name, mrr_pennies_gbp, ai_cost_pennies_gbp_30d, gross_profit_pennies_30d
from v_tenant_economics order by gross_profit_pennies_30d asc;

-- Spend by feature
select feature, calls, users, round(cost_usd::numeric, 4) as cost_usd
from v_usage_by_feature order by cost_usd desc;

-- A user's journey: the sequence of actions in each session
select started_at, action_count, action_sequence
from v_user_sessions where actor_user_id = '<uuid>' order by started_at desc;
```
