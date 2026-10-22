import { NavHeader, SiteFooter, ctaHref, ROUTES } from '../../../../_components/shared';
import { bookingByToken } from '@/lib/server/demo/bookings';
import { CancelDemo } from './CancelDemo';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Cancel Demo — CONVEYi | Case Lightning', robots: { index: false, follow: false } };

/** The cancel link from the booking emails: shows the demo, and cancels only when the button is pressed. */
export default async function CancelPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const b = await bookingByToken(token);
  return (
    <main className="bg-paper text-ink antialiased">
      <NavHeader signupHref={ctaHref(ROUTES.signup, 'demo_cancel', 'nav_signup')} />
      <section className="px-6 py-16 md:py-24">
        <div className="mx-auto max-w-xl">
          <CancelDemo token={token} booking={b} />
        </div>
      </section>
      <SiteFooter />
    </main>
  );
}
