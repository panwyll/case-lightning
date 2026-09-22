import type { Metadata } from 'next';
import { NavHeader, SiteFooter, ctaHref, ROUTES } from '../../_components/shared';

export const metadata: Metadata = {
  title: 'Support — CONVEYi',
  description:
    'How to get help with CONVEYi: who to contact, what to send, response targets, how to connect or disconnect LEAP and Microsoft 365, and how to report a security issue.',
};

const PAGE_SOURCE = 'support';

// NOTE TO OPERATOR: same convention as /conveyi/privacy and /conveyi/security — the
// bracketed values are facts only you can supply. This page is the Support URL given to
// the LEAP developer portal and to Microsoft AppSource, so a reviewer will open it:
// fill the brackets in before either submission.
const LEGAL_ENTITY = 'AIFTRC LTD';
const COMPANY_NO = '17313284';
const SUPPORT_EMAIL = '[support@caselightning.co.uk]';
const SECURITY_EMAIL = '[security@caselightning.co.uk]';
const PRIVACY_EMAIL = '[privacy@caselightning.co.uk]';
const HOURS = 'Monday to Friday, 9am–6pm UK time, excluding English bank holidays';

/** What we aim to respond in. Deliberately modest and honest — a target we can hold to. */
const TARGETS: Array<[string, string, string]> = [
  ['Urgent', 'Nobody at the firm can sign in, matters are not syncing, or a decision cannot be actioned.', 'Same working day'],
  ['High', 'One matter or one person is affected; there is a workaround.', 'Next working day'],
  ['Normal', 'A question, a document read wrongly, a change you would like.', 'Two working days'],
  ['Security', 'A suspected vulnerability or a data incident.', 'Within 24 hours, any day'],
];

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-10 text-2xl font-semibold">{children}</h2>;
}
function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-6 text-lg font-semibold">{children}</h3>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-ink/75">{children}</p>;
}
function Mail({ address }: { address: string }) {
  return <a className="text-violet underline" href={`mailto:${address}`}>{address}</a>;
}

export default function SupportPage() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />

      <section className="mx-auto max-w-3xl px-6 pt-16 pb-16 md:pt-24">
        <h1 className="text-3xl font-bold md:text-4xl">Support</h1>
        <P>
          A real person reads every message. Tell us the matter reference and what you expected to
          happen, and we can usually see the rest for ourselves — every conclusion CONVEYi reaches is
          recorded with the document it came from, so we can replay what it did rather than guess.
        </P>

        <div className="mt-6 rounded-xl border border-ink/10 bg-ink/[0.02] p-5">
          <div className="text-sm text-ink-soft">Email us</div>
          <div className="mt-1 text-xl font-semibold"><Mail address={SUPPORT_EMAIL} /></div>
          <div className="mt-2 text-sm text-ink/70">{HOURS}. Security reports are read every day — see below.</div>
        </div>

        <H2>What to send</H2>
        <P>Four things get you an answer in one round rather than three:</P>
        <ul className="mt-3 space-y-2 text-ink/75">
          <li>• <strong>The matter reference</strong> (and the LEAP matter number, if you use LEAP).</li>
          <li>• <strong>What you expected, and what happened instead.</strong> “It read the CON29 as clear but there is an enforcement notice on page 4” tells us more than “the search is wrong”.</li>
          <li>• <strong>When</strong>, roughly — the day and the hour is enough to find it in the log.</li>
          <li>• <strong>A screenshot</strong>, if something looked wrong on screen.</li>
        </ul>
        <P>
          Please do not email client documents or bank details to us. We can see the matter from our
          side once you give us the reference, and anything we need beyond that we will ask for
          through a channel your firm is comfortable with.
        </P>

        <H2>What we aim to respond in</H2>
        <div className="mt-4 overflow-hidden rounded-xl border border-ink/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-ink/[0.03] text-left">
                <th className="px-4 py-2 font-semibold">Priority</th>
                <th className="px-4 py-2 font-semibold">What it means</th>
                <th className="px-4 py-2 font-semibold">First response</th>
              </tr>
            </thead>
            <tbody>
              {TARGETS.map(([level, meaning, target], i) => (
                <tr key={level} className={i % 2 ? 'bg-ink/[0.02]' : ''}>
                  <td className="px-4 py-2 align-top font-medium">{level}</td>
                  <td className="px-4 py-2 align-top text-ink/70">{meaning}</td>
                  <td className="whitespace-nowrap px-4 py-2 align-top text-ink/60">{target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <P>
          These are targets for a first human response, not for a fix. If something is going to take
          longer than the response target to put right, we will say so and tell you what we are doing
          instead of going quiet.
        </P>

        <H2>The things people ask first</H2>

        <H3>A decision is sitting there and I cannot action it</H3>
        <P>
          Two deliberate gates can do that. The <strong>source gate</strong>: the buttons unlock once
          you have scrolled the document or spent a few seconds on it, because a decision you have not
          read is not a decision. And <strong>shadow mode</strong>: a matter being observed shows the
          engine’s conclusions for comparison but nothing is actionable. The banner at the top of the
          matter says which one applies.
        </P>

        <H3>It read a document wrongly</H3>
        <P>
          Tell us the matter and the document. Every extracted fact carries the page and the words it
          came from, so we can see exactly what it read and why. Nothing a reader gets wrong can enter
          the case on its own — a person approves it first — but a reader that is wrong often is a bug
          and we want it.
        </P>

        <H3>A payment is blocked</H3>
        <P>
          That is by design and we cannot lift it for you. A change of bank details has to be verified
          on a channel the sender does not control — a call back to a number already on file, Lawyer
          Checker, in person — and the verification recorded against it. This is the one part of the
          system that is deliberately inconvenient.
        </P>

        <H3>Something is missing from a matter</H3>
        <P>
          A document CONVEYi cannot place yet is held and retried rather than dropped. If it has been
          in LEAP or OneDrive for more than an hour and still is not on the matter, send us the
          reference — that usually means the classifier is unsure and a person needs to file it.
        </P>

        <H2>Connecting and disconnecting</H2>

        <H3>LEAP</H3>
        <P>
          A partner or administrator connects LEAP once, from Settings → Integrations, and consents on
          LEAP’s own screen. CONVEYi then reads conveyancing matters, the parties on them and the
          documents filed to them, and writes back tasks, file notes and clearly-labelled DRAFT
          documents into a CONVEYi folder. It never edits or deletes anything your firm created, and it
          does not touch accounting, trust or client money.
        </P>
        <P>
          New matters start in <strong>shadow mode</strong>: CONVEYi forms its conclusions and logs
          them, and writes nothing into LEAP until you promote the matter. To disconnect entirely,
          revoke the connection in LEAP or ask us — either stops all reading and all write-back
          immediately. What is already in your LEAP file stays in your LEAP file.
        </P>

        <H3>Microsoft 365</H3>
        <P>
          The add-in works inside your firm’s own Microsoft 365 tenant, on the signed-in person’s
          mailbox and OneDrive. An administrator can withdraw consent at any time from the Microsoft
          365 admin centre. The permissions we request, and why each one is needed, are listed on the{' '}
          <a className="text-violet underline" href="/conveyi/security">security page</a>.
        </P>

        <H2>Reporting a security issue</H2>
        <P>
          Email <Mail address={SECURITY_EMAIL} /> with what you found and how to reproduce it. We will
          acknowledge within 24 hours, any day of the week. Please give us a reasonable chance to fix
          it before making it public; we will not pursue anyone who reports a genuine finding in good
          faith and does not access or alter other people’s data.
        </P>

        <H2>Data requests, DPAs and account changes</H2>
        <P>
          Your firm is the controller of its own matter data and we are its processor, so a client’s
          access or erasure request comes to you — we will help you answer it. For a data processing
          agreement, a sub-processor list, or a question about how we hold data, write to{' '}
          <Mail address={PRIVACY_EMAIL} />. Billing, seats and cancellation: <Mail address={SUPPORT_EMAIL} />.
        </P>
        <P>
          The detail sits on the{' '}
          <a className="text-violet underline" href="/conveyi/privacy">privacy policy</a>, the{' '}
          <a className="text-violet underline" href="/conveyi/security">security page</a> and the{' '}
          <a className="text-violet underline" href="/conveyi/terms">terms of use</a>.
        </P>

        <H2>Outages</H2>
        <P>
          If CONVEYi is down for everyone we will say so by email to each firm’s administrators, and
          again when it is back, with what happened. We would rather tell you than have you find out
          by refreshing.
        </P>

        <H2>Who we are</H2>
        <P>
          {LEGAL_ENTITY}, registered in England and Wales, company number {COMPANY_NO}. CONVEYi is
          built for conveyancing firms in England &amp; Wales.
        </P>
      </section>

      <SiteFooter />
    </main>
  );
}
