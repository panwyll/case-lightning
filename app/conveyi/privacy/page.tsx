import type { Metadata } from 'next';
import { NavHeader, SiteFooter, ctaHref, ROUTES } from '../../_components/shared';

export const metadata: Metadata = {
  title: 'Privacy Policy — CaseLightning',
  description:
    'How CaseLightning (CONVEYi) collects, uses, stores and shares personal data, the sub-processors involved, and your rights under UK GDPR.',
};

const PAGE_SOURCE = 'privacy';

// NOTE TO OPERATOR: items in [square brackets] must be completed and the whole
// document reviewed by a qualified person before relying on it. Last reviewed: [date].
const LEGAL_ENTITY = '[Legal entity name]';
const CONTACT_EMAIL = '[privacy@yourdomain]';
const ICO_REG = '[ICO registration number]';
const POSTAL = '[Registered address]';
const EFFECTIVE = '[Effective date]';

const SUBPROCESSORS: Array<[string, string, string]> = [
  ['Microsoft (Microsoft 365 / Graph / OneDrive)', 'Hosts your mailbox, files and the data the add-in reads and writes. Your emails and documents stay in your own organisation’s Microsoft 365 tenant.', 'EU/UK or tenant region'],
  ['Anthropic (Claude)', 'Generates email drafts, summaries, classifications and document text from the matter content sent for each request.', 'USA'],
  ['Groq (failover only)', 'Used only if no Anthropic key is configured, to generate the same outputs. Avoid in production by configuring Anthropic.', 'USA'],
  ['Voyage AI / OpenAI (embeddings)', 'Converts matter text into vector embeddings for retrieval. Only the configured provider is used.', 'USA'],
  ['Supabase (PostgreSQL)', 'Stores matter records, identifiers, embeddings, audit logs and metering. EU region recommended.', 'EU'],
  ['Vercel', 'Hosts and serves the application and APIs.', 'EU/US edge'],
  ['Stripe', 'Processes subscription billing. Receives billing contact and payment data, not matter content.', 'USA/EU'],
];

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-10 text-2xl font-semibold">{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-ink/75">{children}</p>;
}

export default function PrivacyPage() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      <section className="mx-auto max-w-3xl px-6 pt-16 pb-16 md:pt-24">
        <h1 className="text-3xl font-bold md:text-4xl">Privacy Policy</h1>
        <p className="mt-3 text-sm text-ink/50">Effective {EFFECTIVE} · last reviewed [date]</p>

        <div className="mt-6 rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900">
          <strong>Draft for review.</strong> This policy is a complete first draft grounded in how
          CaseLightning actually processes data, but the bracketed details and the document as a whole
          must be reviewed by a qualified person before publication.
        </div>

        <P>
          This policy explains how {LEGAL_ENTITY} (“we”, “us”) processes personal data through
          CaseLightning / CONVEYi (the “Service”), an Outlook add-in that helps UK conveyancing firms
          triage email, draft replies and manage matters. It is written to meet UK GDPR and the Data
          Protection Act 2018.
        </P>

        <H2>Who is the controller</H2>
        <P>
          For the personal data a conveyancing firm processes about its own clients and matters, the
          <strong> firm is the data controller</strong> and we act as a <strong>processor</strong> on
          its behalf under our customer terms / data processing agreement. For account, billing and
          support data about the firm and its users, we are the controller. Our registered details:
          {' '}{LEGAL_ENTITY}, {POSTAL}, ICO registration {ICO_REG}.
        </P>

        <H2>What data we process</H2>
        <ul className="mt-3 space-y-2 text-ink/75">
          <li>• <strong>Mailbox content</strong> you act on: email subject, body, participants and attachments of the messages you open or that auto-triage processes.</li>
          <li>• <strong>Matter data</strong>: property addresses, party names, dates, counterparties, documents and the records you create.</li>
          <li>• <strong>Account data</strong>: your name, work email, Microsoft tenant/user identifiers, role.</li>
          <li>• <strong>Billing data</strong>: firm billing contact and subscription status (card details are handled by Stripe, not us).</li>
          <li>• <strong>Operational data</strong>: audit logs, and per-request AI usage metering (token counts and cost — <em>not</em> message content).</li>
        </ul>

        <H2>How we use it &amp; legal bases</H2>
        <P>
          We process matter and mailbox content solely to provide the Service to your firm (performance
          of contract, and our legitimate interest in operating the product); account and billing data
          to manage your subscription (contract and legal obligation); and operational data to secure,
          debug and improve the Service (legitimate interests). We do <strong>not</strong> sell personal
          data or use your matter content to train our own models.
        </P>

        <H2>Where your data lives</H2>
        <P>
          Your emails and documents remain in your firm’s own Microsoft 365 tenant — we read and write
          via Microsoft Graph using least-privilege permissions scoped to the signed-in user’s mailbox
          and OneDrive. Matter records, identifiers, embeddings and audit logs are stored in our
          database. Data is logically isolated per firm (tenant): one firm can never access another’s
          matters or content.
        </P>

        <H2>AI processing</H2>
        <P>
          To produce drafts, summaries, classifications and document text, the relevant matter/email
          content is sent to our AI sub-processor (Anthropic Claude) for that request. Content is sent
          as data, never as instructions, and is not used to train the provider’s models under our
          commercial terms. If your firm supplies its own AI key (BYOK), those requests go to your own
          provider account instead.
        </P>

        <H2>Sub-processors</H2>
        <P>We use the following sub-processors. Each is engaged under a data processing agreement.</P>
        <div className="mt-4 overflow-hidden rounded-xl border border-ink/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-ink/[0.03] text-left">
                <th className="px-4 py-2 font-semibold">Sub-processor</th>
                <th className="px-4 py-2 font-semibold">Purpose</th>
                <th className="px-4 py-2 font-semibold">Region</th>
              </tr>
            </thead>
            <tbody>
              {SUBPROCESSORS.map(([name, purpose, region], i) => (
                <tr key={name} className={i % 2 ? 'bg-ink/[0.02]' : ''}>
                  <td className="px-4 py-2 align-top font-medium">{name}</td>
                  <td className="px-4 py-2 align-top text-ink/70">{purpose}</td>
                  <td className="whitespace-nowrap px-4 py-2 align-top text-ink/60">{region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <P>
          Where a sub-processor is outside the UK/EEA, transfers are covered by the UK International
          Data Transfer Agreement / Addendum to the EU Standard Contractual Clauses or an adequacy
          decision.
        </P>

        <H2>Retention</H2>
        <P>
          We retain matter and account data for as long as your firm has an active account, then delete
          or return it per your data processing agreement. Deleting a matter removes its records
          (identifiers, documents register, embeddings, triage) from our database; files in your own
          OneDrive remain under your control. Audit logs are kept for [retention period].
        </P>

        <H2>Your rights</H2>
        <P>
          Under UK GDPR you have rights of access, rectification, erasure, restriction, portability and
          objection. Where your firm is the controller of matter data, please direct requests to your
          firm; we will assist them as processor. For account data we control, contact us at{' '}
          <a className="text-violet underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. You
          may also complain to the ICO (ico.org.uk).
        </P>

        <H2>Security</H2>
        <P>
          Secrets are encrypted at rest, transport is HTTPS/TLS, access is least-privilege and
          tenant-isolated, and every significant action is recorded in an audit log. Report security
          concerns to <a className="text-violet underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </P>

        <H2>Changes</H2>
        <P>We will update this policy as the Service evolves and post the new effective date here.</P>

        <H2>Contact</H2>
        <P>
          {LEGAL_ENTITY}, {POSTAL}. Email{' '}
          <a className="text-violet underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </P>
      </section>

      <SiteFooter />
    </main>
  );
}
