import type { Metadata } from 'next';
import { NavHeader, SiteFooter, ctaHref, ROUTES } from '../../_components/shared';

export const metadata: Metadata = {
  title: 'Terms of Use — CaseLightning',
  description: 'The terms governing use of the CaseLightning (CONVEYi) Outlook add-in and service.',
};

const PAGE_SOURCE = 'terms';

const LEGAL_ENTITY = '[Legal entity name]';
const CONTACT_EMAIL = '[support@yourdomain]';
const GOVERNING_LAW = 'England and Wales';
const EFFECTIVE = '[Effective date]';

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-10 text-2xl font-semibold">{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-ink/75">{children}</p>;
}

export default function TermsPage() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      <section className="mx-auto max-w-3xl px-6 pt-16 pb-16 md:pt-24">
        <h1 className="text-3xl font-bold md:text-4xl">Terms of Use</h1>
        <p className="mt-3 text-sm text-ink/50">Effective {EFFECTIVE} · last reviewed [date]</p>

        <div className="mt-6 rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900">
          <strong>Draft for review.</strong> Complete the bracketed details and have these terms
          reviewed by a qualified person before publication.
        </div>

        <P>
          These Terms of Use govern your access to and use of CaseLightning / CONVEYi (the “Service”),
          provided by {LEGAL_ENTITY}. By installing or using the Service you agree to these terms. If
          you are using it on behalf of a firm, you confirm you are authorised to bind that firm.
        </P>

        <H2>1. The Service</H2>
        <P>
          CaseLightning is an Outlook add-in and web application that helps UK conveyancing firms triage
          email, draft replies, generate documents and manage matters. It requires a Microsoft 365
          account and the permissions requested at sign-in. Specific paid features depend on your
          subscription plan.
        </P>

        <H2>2. Accounts &amp; acceptable use</H2>
        <P>
          You are responsible for activity under your account and for keeping credentials secure. You
          must not misuse the Service, attempt to access another firm’s data, reverse engineer it,
          or use it unlawfully or to process data you have no right to process.
        </P>

        <H2>3. AI-generated output</H2>
        <P>
          The Service uses AI to produce drafts, summaries and documents. <strong>Output is a
          starting point, not legal advice, and may contain errors.</strong> You are responsible for
          reviewing and approving anything before it is sent, filed or relied upon. The Service never
          sends client emails automatically unless you explicitly enable and authorise an auto-send
          rule, for which you accept professional responsibility.
        </P>

        <H2>4. Your data</H2>
        <P>
          Your emails and documents remain in your own Microsoft 365 tenant. Our handling of personal
          data is described in our{' '}
          <a className="text-violet underline" href="/conveyi/privacy">Privacy Policy</a>, and where we
          act as a processor, in the data processing agreement with your firm. You retain ownership of
          your data.
        </P>

        <H2>5. Subscription &amp; billing</H2>
        <P>
          Paid plans are billed via Stripe on the terms shown at checkout. Fees are recurring until
          cancelled. Plan features and limits are as described in the app and on our pricing page.
        </P>

        <H2>6. Availability</H2>
        <P>
          We aim for high availability but the Service is provided “as is” and depends on third-party
          services (notably Microsoft 365 and our AI providers). We may modify or discontinue features
          with reasonable notice.
        </P>

        <H2>7. Liability</H2>
        <P>
          To the extent permitted by law, we are not liable for indirect or consequential loss, or for
          loss arising from your reliance on AI output without review. Nothing in these terms excludes
          liability that cannot lawfully be excluded. Our total liability is limited as set out in your
          subscription agreement [or: to the fees paid in the preceding 12 months].
        </P>

        <H2>8. Termination</H2>
        <P>
          You may stop using the Service and cancel your subscription at any time. We may suspend or
          terminate access for breach of these terms. On termination we delete or return your data per
          the Privacy Policy and any data processing agreement.
        </P>

        <H2>9. Governing law</H2>
        <P>These terms are governed by the laws of {GOVERNING_LAW}, and disputes are subject to its courts.</P>

        <H2>10. Contact</H2>
        <P>
          {LEGAL_ENTITY} — <a className="text-violet underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </P>
      </section>

      <SiteFooter />
    </main>
  );
}
