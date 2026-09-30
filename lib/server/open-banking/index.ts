/**
 * Which open banking provider this deployment uses: GoCardless Bank Account Data when its secrets are
 * set, the demo bank anywhere else outside production, and none in production without a provider (the
 * form then offers uploads only).
 */
import type { OpenBankingProvider } from './provider';
import { GoCardlessBankData } from './gocardless';
import { DemoBank } from './mock';

let chosen: OpenBankingProvider | null | undefined;
export function openBanking(): OpenBankingProvider | null {
  if (chosen !== undefined) return chosen;
  const id = process.env.GOCARDLESS_SECRET_ID, key = process.env.GOCARDLESS_SECRET_KEY;
  chosen = id && key ? new GoCardlessBankData({ secretId: id, secretKey: key }) : process.env.NODE_ENV !== 'production' || process.env.OPEN_BANKING_DEMO === '1' ? new DemoBank() : null;
  return chosen;
}
export { HISTORY_DAYS, type Institution, type ConnectedAccount } from './provider';
