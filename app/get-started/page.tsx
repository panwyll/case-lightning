import type { Metadata } from 'next';
import { config } from '@/lib/server/config';
import { NavHeader, SiteFooter, ctaHref, ROUTES, BRAND } from '../_components/shared';

export const metadata: Metadata = {
  title: 'Start your free trial — CONVEYi',
  description:
    'Sign in with your work Microsoft account and CONVEYi reads your recent mail to find your live matters. No credit card, no migration, nothing to install to begin.',
};

const PAGE_SOURCE = 'get_started';

// ?flow=web tells the OAuth callback this is a browser signup, so it lands the new firm
// in the app instead of the Office dialog bridge. See app/api/v1/auth/callback/route.ts.
const SIGN_IN_HREF = '/api/v1/auth/login?flow=web';

const steps: Array<[string, string]> = [
  [
    'Sign in with Microsoft',
    'Your existing work account — there’s no new password to create. Microsoft will show you a consent screen listing what CONVEYi can access; the next section explains exactly what it asks for and why.',
  ],
  [
    'We find your live matters',
    'CONVEYi reads your recent mail and works out which threads are the same transaction — property, parties, the other side’s solicitor. You get a list of your real cases to review, and you decide which ones to keep.',
  ],
  [
    'Then connect Outlook',
    'Once you’ve seen it work, add the Outlook add-in so drafting and triage happen where you already read your email. We walk you through it step by step inside the app.',
  ],
];

const permissionAsks: Array<[string, string]> = [
  ['Read and write your mail', 'To read the thread you have open and put a draft reply in your Drafts folder.'],
  ['Send mail as you', 'Only when you click Send. Nothing is sent without a person deciding to send it.'],
  ['Read and write your mailbox settings', 'To create the Reply / Action / Delegate categories in your mailbox.'],
  ['Read and write your files', 'Your own OneDrive only — the matter folder and the Excel tracker.'],
];

export default function GetStartedPage() {
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={SIGN_IN_HREF} signupLabel="Sign in with Microsoft" />

      <section className="px-6 pt-16 pb-4 md:pt-24">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet">Start free</p>
          <h1 className="mt-4 font-serif text-5xl font-semibold leading-tight tracking-tight md:text-6xl">
            See {BRAND} find your own cases.
          </h1>
          <p className="mt-5 text-lg text-ink-soft">
            {config.trialDays} days free. No credit card, no sales call, nothing to migrate. Sign in with
            the Microsoft account you already use for work and you’ll be looking at your own live
            matters in a few minutes.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <a
              href={SIGN_IN_HREF}
              data-cta="get_started_signin"
              className="inline-flex items-center justify-center gap-3 rounded-full bg-violet px-7 py-3.5 text-base font-semibold text-white shadow-violet transition-all duration-150 hover:bg-violet-dark active:scale-[0.98]"
            >
              {/* Microsoft's four-square mark — recognisable, and it tells people
                  exactly which credentials they're about to use. */}
              <span aria-hidden className="grid grid-cols-2 gap-[2px]">
                <span className="block h-2 w-2 bg-[#F25022]" />
                <span className="block h-2 w-2 bg-[#7FBA00]" />
                <span className="block h-2 w-2 bg-[#00A4EF]" />
                <span className="block h-2 w-2 bg-[#FFB900]" />
              </span>
              Sign in with Microsoft
            </a>
            <span className="text-sm text-ink-soft">Takes about a minute.</span>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-3xl px-6 pb-12">
        <section className="border-t border-line py-12">
          <h2 className="font-serif text-3xl font-semibold tracking-tight md:text-4xl">What happens next</h2>
          <ol className="mt-6 space-y-6">
            {steps.map(([title, body], i) => (
              <li key={title} className="flex gap-4">
                <span className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-full bg-violet/10 text-sm font-bold text-violet">
                  {i + 1}
                </span>
                <div>
                  <h3 className="text-lg font-semibold">{title}</h3>
                  <p className="mt-1 text-lg leading-relaxed text-ink-soft">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-t border-line py-12">
          <h2 className="font-serif text-3xl font-semibold tracking-tight md:text-4xl">
            About that consent screen
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-ink-soft">
            Microsoft will ask you to approve a list of permissions. It is a blunt list and it looks
            alarming, so here is what each line is actually for. Everything is scoped to{' '}
            <strong className="font-semibold text-ink">your own mailbox and your own OneDrive</strong> —
            CONVEYi cannot see a colleague’s mail, your SharePoint, or anything in your firm’s directory.
          </p>
          <div className="mt-6 space-y-4">
            {permissionAsks.map(([ask, why]) => (
              <div key={ask} className="border-l-2 border-violet/30 pl-4">
                <p className="font-semibold">{ask}</p>
                <p className="mt-0.5 text-lg leading-relaxed text-ink-soft">{why}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 text-lg leading-relaxed text-ink-soft">
            If your firm blocks new apps by default, your IT administrator will need to approve it —
            our{' '}
            <a href="/conveyi/security" className="underline decoration-violet/40 underline-offset-4 hover:text-ink">
              security page
            </a>{' '}
            is written for exactly that conversation.
          </p>
        </section>

        <section className="border-t border-line py-12">
          <h2 className="font-serif text-3xl font-semibold tracking-tight md:text-4xl">No card, no catch</h2>
          <p className="mt-5 text-lg leading-relaxed text-ink-soft">
            We don’t ask for payment details to start a trial. You get {config.trialDays} days to point
            it at real work and decide for yourself. If it isn’t earning its keep, do nothing and it
            stops — there’s no subscription running in the background to cancel.
          </p>
          <p className="mt-4 text-lg leading-relaxed text-ink-soft">
            Your emails and documents stay in your firm’s own Microsoft 365 tenant throughout, and
            drafts wait in your Drafts folder for a human to send.{' '}
            <a href={ROUTES.pricing} className="underline decoration-violet/40 underline-offset-4 hover:text-ink">
              See what it costs after that
            </a>
            .
          </p>
          <div className="mt-8">
            <a
              href={SIGN_IN_HREF}
              data-cta="get_started_signin_footer"
              className="inline-flex items-center justify-center rounded-full bg-violet px-7 py-3.5 text-base font-semibold text-white shadow-violet transition-all duration-150 hover:bg-violet-dark active:scale-[0.98]"
            >
              Start free with Microsoft
            </a>
          </div>
        </section>

        <section className="border-t border-line py-10">
          <p className="text-base text-ink-soft">
            Already using CONVEYi?{' '}
            <a href="/admin" className="underline decoration-violet/40 underline-offset-4 hover:text-ink">
              Open the app
            </a>
            . Rather talk to someone first?{' '}
            <a
              // Explicitly /waitlist, not ROUTES.signup — that now points here, and a
              // "get in touch" link that reloads the signup page is a dead end.
              href={ctaHref(ROUTES.contact, PAGE_SOURCE, 'contact_instead')}
              className="underline decoration-violet/40 underline-offset-4 hover:text-ink"
            >
              Get in touch
            </a>
            .
          </p>
        </section>
      </div>

      <SiteFooter />
    </main>
  );
}
