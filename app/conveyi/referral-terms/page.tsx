import type { Metadata } from 'next';
import { NavHeader, SiteFooter, ctaHref, ROUTES } from '../../_components/shared';

export const metadata: Metadata = {
  title: 'Referral rewards — how payments work — CaseLightning',
  description:
    'How CaseLightning referral credit works: earn recurring account credit for every firm you refer, when it pays, and the full terms.',
};

const PAGE_SOURCE = 'referral_terms';

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-10 text-2xl font-semibold">{children}</h2>;
}

export default function ReferralTermsPage() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      <section className="mx-auto max-w-3xl px-6 pt-16 pb-16 md:pt-24">
        <p className="text-sm font-semibold uppercase tracking-wide text-ink/50">Referrals</p>
        <h1 className="mt-2 text-3xl font-bold md:text-4xl">Earn £50 a month, for every firm you refer</h1>
        <p className="mt-4 text-lg text-ink/70">
          Share your link. Every firm that subscribes through it earns you <strong>£50 a month in
          account credit</strong> — recurring, for as long as they stay subscribed. Refer five firms
          and that’s £250 a month off your own bill.
        </p>

        <H2>How the payments actually work</H2>
        <ol className="mt-4 space-y-4 text-ink/80">
          <li>
            <span className="font-semibold">1. They sign up with your link.</span> The firm subscribes
            using your referral link (or enters your code at checkout). They’re tied to you as their
            referrer — one referrer per firm.
          </li>
          <li>
            <span className="font-semibold">2. Credit accrues when they pay.</span> Each time that firm
            pays a monthly invoice, £50 is <em>accrued</em> to you. Nothing accrues from a sign-up that
            never pays, or during an unpaid trial.
          </li>
          <li>
            <span className="font-semibold">3. It’s applied the following month.</span> Accrued credit
            becomes payable on the <strong>first of the next month</strong> and is automatically applied
            to your account as credit — it draws down your next CaseLightning invoice.
          </li>
          <li>
            <span className="font-semibold">4. It keeps coming.</span> As long as the referred firm stays
            subscribed and paying, you keep earning £50 each month they pay. It’s recurring, not a
            one-off bounty.
          </li>
        </ol>

        <H2>The fine print</H2>
        <ul className="mt-4 space-y-2 text-ink/70">
          <li>• <strong>Account credit, not cash.</strong> Credit reduces your CaseLightning bill; it has no cash value and isn’t withdrawable.</li>
          <li>• <strong>One referrer per firm.</strong> A firm can only be referred once, by one referrer. Self-referrals (referring your own firm) don’t qualify.</li>
          <li>• <strong>It must be a real, paid subscription.</strong> Credit accrues only after a referred firm’s genuine, successful payment.</li>
          <li>• <strong>Clawback on refunds/cancellations.</strong> If a referred firm’s payment is refunded, charged back, or the invoice is voided, the matching credit is reversed (clawed back) — including credit already applied.</li>
          <li>• <strong>Recurring while active.</strong> You earn for each month the referred firm pays; if they cancel, future credit simply stops.</li>
          <li>• <strong>We may change or end the programme</strong> with reasonable notice. Abuse (fake firms, fraudulent sign-ups) voids credit.</li>
        </ul>

        <p className="mt-8 text-sm text-ink/50">
          The reward amount shown in the app reflects the current rate and is the authoritative figure if
          it differs from this page. See also our{' '}
          <a className="text-violet underline" href="/conveyi/terms">Terms of Use</a> and{' '}
          <a className="text-violet underline" href="/conveyi/privacy">Privacy Policy</a>.
        </p>
      </section>

      <SiteFooter />
    </main>
  );
}
