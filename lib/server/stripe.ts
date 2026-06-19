import Stripe from 'stripe';
import { config } from './config';

let _stripe: Stripe | null = null;

export function stripe(): Stripe {
  if (!_stripe) {
    if (!config.stripeSecretKey) throw new Error('STRIPE_SECRET_KEY is not set');
    _stripe = new Stripe(config.stripeSecretKey);
  }
  return _stripe;
}

/** Verify + parse a Stripe webhook payload. Throws if the signature is invalid. */
export function constructEvent(rawBody: string, signature: string): Stripe.Event {
  if (!config.stripeWebhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  return stripe().webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
}

/**
 * Apply account credit to a Stripe customer (negative balance = credit drawn down
 * on the next invoice). Returns the balance-transaction id. amountPennies > 0.
 */
export async function creditCustomerBalance(
  customerId: string,
  amountPennies: number,
  description: string
): Promise<string> {
  const txn = await stripe().customers.createBalanceTransaction(customerId, {
    amount: -Math.abs(amountPennies),
    currency: config.billingCurrency,
    description,
  });
  return txn.id;
}
