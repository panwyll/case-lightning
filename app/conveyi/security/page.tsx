import type { Metadata } from 'next';
import { ctaHref, ROUTES, Cta, NavHeader, SiteFooter } from '../../_components/shared';

export const metadata: Metadata = {
  title: 'Security & data protection — CONVEYi',
  description:
    'How CONVEYi handles your firm’s data: what stays in your Microsoft 365 tenant, what we store, our sub-processors, the Graph permissions we request and why, and how to get a DPA. Written for IT and compliance reviewers.',
};

const PAGE_SOURCE = 'security';

// NOTE TO OPERATOR: items in [square brackets] are facts only you can supply — fill them
// in before pointing a firm's IT department at this page. Same convention as /conveyi/privacy.
const LEGAL_ENTITY = 'AIFTRC LTD'; // matches ProviderName in the add-in manifest
const COMPANY_NO = '17313284'; // verified against Companies House
const ICO_REG = '[ICO registration number]';
const DB_REGION = 'EU';

// Every third party that touches customer data, taken from the code rather than from
// memory: ai.ts (Anthropic + Groq), embeddings.ts (Voyage/OpenAI), graph.ts (Microsoft),
// billing.ts (Stripe), db.ts (Supabase), the waitlist route (Resend) and Vercel hosting.
const subProcessors: Array<[string, string, string, string]> = [
  ['Anthropic (Claude)', 'Drafting, summarising, triage classification', 'Email content and matter facts for the message being worked on', 'USA'],
  ['Groq', 'Call-note transcription; AI failover if Anthropic is unavailable', 'Call audio you record; email content only when failover is active', 'USA'],
  ['Voyage AI or OpenAI', 'Embeddings for case-file search', 'Chunks of matter documents and emails', 'USA'],
  ['Microsoft', 'Outlook, OneDrive and Excel via Microsoft Graph', 'Stays inside your own Microsoft 365 tenant', 'Your tenant’s region'],
  ['Supabase', 'Application database (Postgres)', 'Matter records, extracted facts, audit log', DB_REGION],
  ['Vercel', 'Application hosting', 'Request data in transit', 'EU/US edge'],
  ['Stripe', 'Subscription billing', 'Billing contact and payment details — we never see card numbers', 'USA / EU'],
  ['Resend', 'Transactional and waitlist email', 'Email address and message content we send you', 'USA'],
];

const permissions: Array<[string, string]> = [
  ['Mail.ReadWrite', 'Read the thread you have open and create a draft reply. There is no permission that lets CONVEYi send on its own.'],
  ['Mail.Send', 'Only used when a human clicks Send in the pane, or for a rule your firm has explicitly switched on.'],
  ['MailboxSettings.ReadWrite', 'Create and colour the triage categories (Reply / Action / Delegate) in your mailbox.'],
  ['Files.ReadWrite', 'Your own OneDrive — the matter folder and Excel tracker. Scoped to /me only.'],
  ['User.Read', 'Your name and email, to sign you in.'],
  ['Team.ReadBasic.All, ChannelMessage.Send', 'Optional: post a matter summary to a Teams channel. Unused unless you turn it on.'],
];

const notRequested = [
  'Files.ReadWrite.All — we cannot see other people’s files',
  'Sites.ReadWrite.All — we do not touch SharePoint',
  'Mail.Read.Shared — we cannot read other people’s mailboxes',
  'Directory or admin-level permissions of any kind',
];

const jumpLinks: Array<[string, string]> = [
  ['#where', 'Where data lives'],
  ['#permissions', 'Permissions'],
  ['#subprocessors', 'Sub-processors'],
  ['#tenancy', 'Separation'],
  ['#exit', 'Exit & portability'],
  ['#paperwork', 'DPA & paperwork'],
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-line py-12 first:border-t-0">
      <h2 className="font-serif text-3xl font-semibold tracking-tight md:text-4xl">{title}</h2>
      <div className="mt-5 space-y-4 text-lg leading-relaxed text-ink-soft">{children}</div>
    </section>
  );
}

export default function SecurityPage() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      <section className="px-6 pt-16 pb-4 md:pt-24">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">Security &amp; data protection</p>
          <h1 className="mt-4 font-serif text-5xl font-semibold leading-tight tracking-tight md:text-6xl">
            Your files never leave your firm.
          </h1>
          <p className="mt-5 text-lg text-ink-soft">
            Written for the person your firm asks to check this before you buy. If you need something
            that isn’t here, ask and we’ll answer properly rather than send you a brochure.
          </p>
          <nav className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium text-ink-soft">
            {jumpLinks.map(([href, label]) => (
              <a key={href} href={href} className="underline decoration-violet/40 underline-offset-4 hover:text-ink">
                {label}
              </a>
            ))}
          </nav>
        </div>
      </section>

      <div className="mx-auto max-w-3xl px-6 pb-12">
        <Section id="where" title="Where your data lives">
          <p>
            CONVEYi is an Outlook add-in, not a portal. Your emails, documents and the Excel tracker stay
            in <strong className="font-semibold text-ink">your own Microsoft 365 tenant</strong> — the mailbox
            and OneDrive you already pay Microsoft for. We do not copy your document library onto our
            servers, and we do not need you to migrate anything to start.
          </p>
          <p>What we <em>do</em> store, in our own database, is the case record that makes matching work:</p>
          <ul className="ml-5 list-disc space-y-1">
            <li>Matter records — reference, address, parties, stage, key dates and figures</li>
            <li>Email metadata and extracted facts for messages matched to a matter</li>
            <li>Search index chunks derived from matter documents and emails</li>
            <li>An audit log of every action taken, for your own accountability trail</li>
            <li>Your Microsoft sign-in tokens, so the add-in can act on your behalf</li>
          </ul>
        </Section>

        <Section id="permissions" title="What we ask Microsoft for, and why">
          <p>
            Least privilege is the design, not an afterthought. Every permission below is delegated —
            CONVEYi can only ever do what the signed-in user could already do themselves.
          </p>
          <div className="overflow-x-auto">
            <table className="mt-2 w-full border-collapse text-base">
              <tbody>
                {permissions.map(([scope, why]) => (
                  <tr key={scope} className="border-b border-line align-top">
                    <td className="py-3 pr-5 font-mono text-sm font-semibold text-ink whitespace-nowrap">{scope}</td>
                    <td className="py-3 text-ink-soft">{why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pt-2">Deliberately <strong className="font-semibold text-ink">not</strong> requested:</p>
          <ul className="ml-5 list-disc space-y-1">
            {notRequested.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </Section>

        <Section id="drafts" title="It drafts. It does not send.">
          <p>
            By default every reply CONVEYi produces lands in your Outlook Drafts for a human to read,
            edit and send. Automatic sending exists, but it is off unless your firm turns it on, is
            configured rule by rule, and can be switched off at any time. Nothing goes to a client
            without someone at your firm deciding it should.
          </p>
        </Section>

        <Section id="subprocessors" title="Sub-processors">
          <p>
            These are the third parties that may process your data, what for, and where. AI providers
            process content in the United States; if that is a problem for your firm, tell us before
            you buy rather than after.
          </p>
          <div className="overflow-x-auto">
            <table className="mt-2 w-full border-collapse text-base">
              <thead>
                <tr className="border-b border-line text-left text-sm uppercase tracking-wide text-ink-soft">
                  <th className="py-2 pr-4 font-semibold">Provider</th>
                  <th className="py-2 pr-4 font-semibold">Purpose</th>
                  <th className="py-2 pr-4 font-semibold">Data</th>
                  <th className="py-2 font-semibold">Region</th>
                </tr>
              </thead>
              <tbody>
                {subProcessors.map(([name, purpose, data, region]) => (
                  <tr key={name} className="border-b border-line align-top">
                    <td className="py-3 pr-4 font-semibold text-ink">{name}</td>
                    <td className="py-3 pr-4 text-ink-soft">{purpose}</td>
                    <td className="py-3 pr-4 text-ink-soft">{data}</td>
                    <td className="py-3 text-ink-soft whitespace-nowrap">{region}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-base">
            If you bring your own Anthropic API key, that firm’s drafting runs against your Anthropic
            account rather than ours.
          </p>
        </Section>

        <Section id="tenancy" title="Separation between firms">
          <p>
            Every record carries the firm it belongs to, and every query is scoped to the signed-in
            user’s firm. One firm cannot see another firm’s matters, documents or audit trail. AI
            prompts are built from a single firm’s data at a time — your files are never used to train
            a model, and never form part of another firm’s answer.
          </p>
        </Section>

        <Section id="exit" title="Leaving, and getting your data out">
          <p>
            The awkward question first: if you stop paying, what happens to your files? Very little,
            because the files were never ours. Your matter folders, saved emails, drafts and Excel
            trackers are already in your OneDrive and stay exactly where they are.
          </p>
          <p>
            Ask us to delete your account and we remove your firm’s records from our database —
            matters, extracted facts, search index and audit log. Deleting a single matter cascades to
            its documents, facts and triage records the same way.
          </p>
        </Section>

        <Section id="paperwork" title="Paperwork your firm will want">
          <ul className="ml-5 list-disc space-y-2">
            <li><strong className="font-semibold text-ink">Data Processing Agreement</strong> — available on request; we will sign yours or provide ours.</li>
            {/* Hidden until filled in — a public page aimed at compliance reviewers must not
                show them an unfilled [placeholder]. */}
            {!ICO_REG.startsWith('[') && (
              <li><strong className="font-semibold text-ink">ICO registration</strong> — {ICO_REG}.</li>
            )}
            <li><strong className="font-semibold text-ink">Cyber insurance</strong> — certificate available on request.</li>
            <li><strong className="font-semibold text-ink">Security questionnaire</strong> — send yours over; we complete them rather than refusing.</li>
            <li><strong className="font-semibold text-ink">Company</strong> — {LEGAL_ENTITY}, registered in England &amp; Wales, no. {COMPANY_NO}.</li>
            <li><strong className="font-semibold text-ink">Privacy policy</strong> — <a href="/conveyi/privacy" className="underline decoration-violet/40 underline-offset-4 hover:text-ink">the full UK GDPR notice</a>, including your rights as a data subject.</li>
          </ul>
          <p>
            If you are Lexcel-accredited, your supplier due-diligence obligations are exactly what this
            page is written to satisfy. Ask for anything missing.
          </p>
        </Section>

        <Section id="contact" title="Ask us something">
          <p>
            Security questions get a real answer from someone who has read the code, usually the same
            day. Get in touch and say what your firm needs.
          </p>
          <div className="pt-2">
            <Cta label="Get in touch" href={ctaHref(ROUTES.signup, PAGE_SOURCE, 'security_contact')} dataCta="security_contact" size="lg" />
          </div>
        </Section>
      </div>

      <SiteFooter />
    </main>
  );
}
