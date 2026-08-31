import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { GuestCodeForm } from '@/components/GuestCodeForm';
import { GuestSections } from '@/components/GuestSections';
import { RsvpForm, type ExistingRsvp } from '@/components/RsvpForm';
import { SiteFooter, SiteHeader } from '@/components/SiteChrome';
import { VisitBeacon } from '@/components/VisitBeacon';
import { wedding } from '@/content/wedding';
import { toPublicGuest } from '@/lib/guest-schema';
import { getGuest } from '@/lib/guests';
import { currentSessions } from '@/lib/session';
import { store } from '@/lib/store';

// Every render depends on the visitor's cookie, so nothing here may ever be
// prerendered or cached: a static /g/<slug> would hand one guest's page to
// anyone who guessed the slug.
export const dynamic = 'force-dynamic';

export default async function GuestPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ k?: string; bad?: string; preview?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;

  // A fresh personal link: swap the code for a cookie, then come back clean.
  if (query.k) {
    redirect(`/g/${encodeURIComponent(slug)}/enter?k=${encodeURIComponent(query.k)}`);
  }

  const guest = getGuest(slug);
  if (!guest) notFound();

  const { admin, guestSlug } = await currentSessions();
  const isOwner = guestSlug === slug;
  const previewing = admin && !isOwner;

  if (!isOwner && !admin) {
    return <LockedPage slug={slug} bad={query.bad === '1'} />;
  }

  // Drafts are for us only, however you arrived.
  if (guest.status === 'draft' && !admin) notFound();

  if (guest.status === 'closed') {
    return <ClosedPage displayName={guest.displayName} />;
  }

  const rsvp = await store()
    .getRsvp(slug)
    .catch(() => null);

  const existing: ExistingRsvp = rsvp
    ? {
        members: rsvp.members.map((m) => ({
          memberId: m.memberId,
          attending: m.attending,
          choices: m.choices,
          dietary: m.dietary,
        })),
        extras: rsvp.extras,
        message: rsvp.message,
        updatedAt: rsvp.updatedAt,
      }
    : null;

  const deadlineLabel = guest.rsvpDeadline ?? wedding.rsvpDeadlineLabel;

  return (
    <>
      {previewing ? <PreviewBar slug={slug} status={guest.status} /> : null}
      <SiteHeader guestName={guest.displayName} />
      {isOwner ? <VisitBeacon slug={slug} path={`/g/${slug}`} /> : null}

      <main className="wrap py-14 sm:py-20">
        <section>
          {guest.hero.kicker ? (
            <p className="text-xs uppercase tracking-[0.2em] text-brass">{guest.hero.kicker}</p>
          ) : null}
          <h1 className="mt-4 font-display text-4xl leading-tight sm:text-6xl">
            {guest.hero.headline}
          </h1>
          {guest.hero.blurb ? (
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-soft">{guest.hero.blurb}</p>
          ) : null}
        </section>

        <section className="mt-10 flex flex-wrap gap-x-10 gap-y-4 rounded-xl2 border border-line bg-paper-deep/50 p-6 text-sm">
          <Fact label="When" value={`${wedding.dateLabel}, ${wedding.timeLabel}`} />
          <Fact label="Where" value={wedding.venue.name} />
          <Fact label="Invited to" value={guest.invitedTo.join(', ')} />
        </section>

        <div className="mt-12">
          <RsvpForm
            guest={toPublicGuest(guest)}
            existing={existing}
            optionalEvents={[...wedding.optionalEvents]}
            deadlineLabel={deadlineLabel}
          />
        </div>

        <GuestSections sections={guest.sections} />

        <p className="mt-12 text-sm text-ink-soft">
          Everything else about the day —{' '}
          <Link className="text-brass hover:text-brass-dark" href="/schedule">
            the running order
          </Link>
          ,{' '}
          <Link className="text-brass hover:text-brass-dark" href="/travel">
            travel and rooms
          </Link>
          , and{' '}
          <Link className="text-brass hover:text-brass-dark" href="/faq">
            the usual questions
          </Link>
          .
        </p>
      </main>

      <SiteFooter />
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-[0.14em] text-ink-soft">{label}</div>
      <div className="mt-1">{value}</div>
    </div>
  );
}

function PreviewBar({ slug, status }: { slug: string; status: string }) {
  return (
    <div className="bg-forest px-5 py-2 text-sm text-paper">
      <div className="wrap flex flex-wrap items-center justify-between gap-3">
        <span>
          Previewing <strong>{slug}</strong> as an admin — status <strong>{status}</strong>. Nothing
          here is being counted as a visit.
        </span>
        <Link href={`/admin/g/${slug}`} className="underline">
          Back to the dashboard
        </Link>
      </div>
    </div>
  );
}

function LockedPage({ slug, bad }: { slug: string; bad: boolean }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-16">
      <div className="w-full max-w-md">
        <h1 className="font-display text-3xl">This page is someone&rsquo;s in particular</h1>
        <p className="mt-4 leading-relaxed text-ink-soft">
          {bad
            ? 'That code did not match. Codes are eight characters and are case-insensitive.'
            : 'Personal pages open from the link we sent you. If you have the code from the bottom of your invitation, put it in here.'}
        </p>
        <GuestCodeForm slug={slug} />
        <p className="mt-6 text-sm text-ink-soft">
          Or{' '}
          <Link className="text-brass hover:text-brass-dark" href="/login">
            use the shared password
          </Link>{' '}
          to see the main site.
        </p>
      </div>
    </main>
  );
}

function ClosedPage({ displayName }: { displayName: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-16 text-center">
      <div className="max-w-md">
        <h1 className="font-display text-3xl">Thank you, {displayName}</h1>
        <p className="mt-4 leading-relaxed text-ink-soft">
          This page has done its job and is closed. We will be in touch with photographs
          and apologies.
        </p>
      </div>
    </main>
  );
}
