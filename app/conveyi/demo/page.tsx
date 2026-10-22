import { NavHeader, SiteFooter, ctaHref, ROUTES } from '../../_components/shared';
import { availableSlots, DEMO_HOST, DEMO_MEETING_URL } from '@/lib/server/demo/bookings';
import { DemoScheduler } from './DemoScheduler';

export const dynamic = 'force-dynamic';
const PAGE_SOURCE = 'demo';

/** Book a demo: the visitor picks a free time and both diaries get the invite (lib/server/demo/bookings.ts). */
export default async function DemoPage() {
  const days = await availableSlots().catch((e) => { console.error('demo slots failed', e); return []; });
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.signup, PAGE_SOURCE, 'nav_signup')} />
      <section className="px-6 py-12 md:py-16">
        <div className="mx-auto grid max-w-6xl gap-10 md:grid-cols-[1fr_1.45fr] md:gap-14">
          <div>
            <h1 className="font-serif text-4xl font-semibold leading-tight tracking-tight md:text-5xl">Book A 15-Minute Demo</h1>
            <p className="mt-5 text-lg text-ink-soft">We show you CONVEYi on the kind of cases your firm runs, and how we measure your fee earners’ caseload before you start.</p>
            <p className="mt-4 text-lg text-ink-soft">You pay nothing until your team handles double the cases.</p>
            <p className="mt-6 text-sm text-ink-soft">With {DEMO_HOST.name}, Case Lightning</p>
          </div>
          <DemoScheduler initial={days} phoneCall={!DEMO_MEETING_URL} host={DEMO_HOST.name} />
        </div>
      </section>
      <SiteFooter />
    </main>
  );
}
