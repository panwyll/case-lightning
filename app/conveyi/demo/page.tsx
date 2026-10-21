import { cookies } from 'next/headers';
import { NavHeader, SiteFooter, ctaHref, ROUTES } from '../../_components/shared';
import { firstTouch } from '@/lib/server/first-touch';
import { DemoCalendar } from './DemoCalendar';
import { DemoForm } from './DemoForm';

export const dynamic = 'force-dynamic';
const PAGE_SOURCE = 'demo';

/**
 * Book a demo. With a booking calendar set up (DEMO_BOOKING_URL, a Calendly event link), the visitor picks a time
 * here; the link carries where they first came from, so the booking does too. Without one, they leave their
 * details and we email them (DemoForm).
 */
export default async function DemoPage() {
  const configured = process.env.DEMO_BOOKING_URL ?? process.env.NEXT_PUBLIC_DEMO_BOOKING_URL ?? '';
  let url: string | null = null;
  if (/^https:\/\/calendly\.com\/[\w./-]+$/.test(configured.split('?')[0])) {
    const u = new URL(configured);
    const t = await firstTouch((await cookies()).get('cl_vid')?.value);
    u.searchParams.set('hide_gdpr_banner', '1');
    u.searchParams.set('primary_color', '5a27e0');
    if (t?.utm_source) u.searchParams.set('utm_source', t.utm_source);
    if (t?.utm_medium) u.searchParams.set('utm_medium', t.utm_medium);
    if (t?.utm_campaign) u.searchParams.set('utm_campaign', t.utm_campaign);
    u.searchParams.set('utm_content', 'demo_page');
    url = u.toString();
  }
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />
      <section className="px-6 py-16 md:py-24">
        <div className={`mx-auto grid gap-12 md:gap-16 ${url ? 'max-w-6xl md:grid-cols-[1fr_1.6fr]' : 'max-w-5xl md:grid-cols-[1fr_1.1fr]'}`}>
          <div>
            <h1 className="font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">Book A 15-Minute Demo</h1>
            <p className="mt-5 text-lg text-ink-soft">We show you CONVEYi on the kind of cases your firm runs, and how we measure your fee earners’ caseload before you start.</p>
            <p className="mt-4 text-lg text-ink-soft">You pay nothing until that caseload has doubled.</p>
          </div>
          {url ? <DemoCalendar url={url} /> : <DemoForm />}
        </div>
      </section>
      <SiteFooter />
    </main>
  );
}
