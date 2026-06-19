import { assertFeature, config } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { accountForUser } from '@/lib/server/referrals';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Referral dashboard for the signed-in firm: their shareable code/link, credit
// balance, who they've referred, and commission totals.
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const account = await accountForUser(user.tenantId, user.email);

    const referees = await query<{ status: string; plan: string | null; created_at: string }>(
      `select ba.status, ba.plan, e.created_at
       from referral_edge e join billing_account ba on ba.id = e.referee_account_id
       where e.referrer_account_id = $1 order by e.created_at desc`,
      [account.id]
    );

    const totals = await query<{ status: string; total: string; n: string }>(
      `select status, coalesce(sum(amount_pennies),0)::text as total, count(*)::text as n
       from commission_ledger where referrer_account_id = $1 group by status`,
      [account.id]
    );
    const by = (s: string) => totals.find((t) => t.status === s);

    const appUrl = config.appUrl.replace(/\/$/, '');
    return ok({
      referralCode: account.referral_code,
      referralLink: `${appUrl}/start-trial?ref=${account.referral_code}`,
      creditBalancePennies: account.credit_balance_pennies,
      currency: config.billingCurrency,
      commissionPennies: config.referralCommissionPennies,
      referrals: {
        total: referees.length,
        active: referees.filter((r) => r.status === 'active').length,
        list: referees,
      },
      commissions: {
        accruedPennies: Number(by('ACCRUED')?.total ?? 0),
        appliedPennies: Number(by('APPLIED')?.total ?? 0),
        clawedBackPennies: Number(by('CLAWED_BACK')?.total ?? 0),
      },
    });
  } catch (error) {
    return fail(error);
  }
}
