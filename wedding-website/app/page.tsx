import Link from 'next/link';
import { Countdown } from '@/components/Countdown';
import { SiteFooter, SiteHeader } from '@/components/SiteChrome';
import { VisitBeacon } from '@/components/VisitBeacon';
import { wedding } from '@/content/wedding';
import { getGuest } from '@/lib/guests';
import { currentSessions } from '@/lib/session';

export default async function HomePage() {
  const { guestSlug } = await currentSessions();
  const guest = guestSlug ? getGuest(guestSlug) : null;

  return (
    <>
      <SiteHeader guestName={guest?.displayName} />
      <VisitBeacon slug={guestSlug} path="/" />

      <main>
        <section className="wrap py-16 sm:py-24">
          <p className="text-xs uppercase tracking-[0.2em] text-brass">
            {wedding.dateLabel} · {wedding.venue.name}
          </p>
          <h1 className="mt-5 font-display text-5xl leading-[1.05] sm:text-7xl">
            {wedding.partnerOne}
            <span className="text-brass"> & </span>
            {wedding.partnerTwo}
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-soft">{wedding.intro}</p>

          <div className="mt-10">
            <Countdown iso={wedding.date} />
          </div>

          {guest ? (
            <div className="mt-10 panel inline-flex flex-wrap items-center gap-4 p-5">
              <p className="text-sm text-ink-soft">
                Your own page has your menu, your seats and your RSVP.
              </p>
              <Link href={`/g/${guest.slug}`} className="btn-primary">
                Go to {guest.displayName}&rsquo;s page
              </Link>
            </div>
          ) : (
            <p className="mt-10 text-sm text-ink-soft">
              Everyone was sent a personal link with their own page on it. Lost yours?{' '}
              <a className="text-brass hover:text-brass-dark" href={`mailto:${wedding.contact.email}`}>
                Ask us for it again.
              </a>
            </p>
          )}
        </section>

        <div className="wrap">
          <div className="rule" />
        </div>

        <section className="wrap grid gap-8 py-14 sm:grid-cols-3">
          <Card title="When" lines={[wedding.dateLabel, wedding.timeLabel]} href="/schedule" cta="The full day" />
          <Card
            title="Where"
            lines={[wedding.venue.name, ...wedding.venue.addressLines]}
            href="/travel"
            cta="Getting there"
          />
          <Card
            title={wedding.dressCode.title}
            lines={[wedding.dressCode.body]}
            href="/faq"
            cta="Other questions"
          />
        </section>
      </main>

      <SiteFooter />
    </>
  );
}

function Card({
  title,
  lines,
  href,
  cta,
}: {
  title: string;
  lines: readonly string[];
  href: string;
  cta: string;
}) {
  return (
    <div className="panel flex flex-col p-6">
      <h2 className="text-xl">{title}</h2>
      <div className="mt-3 flex-1 space-y-1 text-sm leading-relaxed text-ink-soft">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <Link href={href} className="mt-5 text-sm text-brass hover:text-brass-dark">
        {cta} &rarr;
      </Link>
    </div>
  );
}
