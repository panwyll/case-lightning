/**
 * Product switches that are code, not firm settings. Flip one and redeploy.
 *
 * REFERRALS_ENABLED: the referral scheme (£10 per case a referred firm runs). Hidden everywhere
 * while it is parked (2026-09-30); the backend (codes, commissions, the monthly apply cron) is
 * untouched, so turning it back on is this one line.
 */
export const REFERRALS_ENABLED = false;
