import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CopyButton } from '@/components/CopyButton';
import { StatusPill } from '@/components/StatusPill';
import { guestCode, personalLink } from '@/lib/auth';
import { agoFrom, shortDateTime } from '@/lib/format';
import { getGuest } from '@/lib/guests';
import { store } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function AdminGuestPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const guest = getGuest(slug);
  if (!guest) notFound();

  const [rsvp, visits, code] = await Promise.all([
    store().getRsvp(slug).catch(() => null),
    store().listVisits(slug, 25).catch(() => []),
    guest.accessCode ? Promise.resolve(guest.accessCode) : guestCode(slug),
  ]);

  /** Turns a stored option id back into the label this guest actually saw. */
  function labelFor(courseId: string, optionId: string | undefined): string {
    if (!optionId) return '—';
    const course = guest!.menu?.courses.find((c) => c.id === courseId);
    return course?.options.find((o) => o.id === optionId)?.label ?? optionId;
  }

  return (
    <>
      <Link href="/admin" className="text-sm text-ink-soft hover:text-ink">
        &larr; All guests
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl">{guest.displayName}</h1>
          <p className="mt-1 flex items-center gap-3 text-sm text-ink-soft">
            <code>content/guests/{guest.slug}.json</code>
            <StatusPill status={guest.status} />
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/g/${guest.slug}?preview=1`} className="btn-ghost">
            Preview their page
          </Link>
          <CopyButton value={personalLink(guest.slug, code)} label="Copy personal link" />
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-line bg-card px-4 py-3 text-sm">
        <span className="text-ink-soft">Personal link: </span>
        <code className="break-all">{personalLink(guest.slug, code)}</code>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <section className="panel p-6">
          <h2 className="font-display text-xl">RSVP</h2>
          {rsvp ? (
            <>
              <p className="mt-1 text-sm text-ink-soft">
                Sent {shortDateTime(rsvp.submittedAt)} · last changed {agoFrom(rsvp.updatedAt)}
              </p>
              <div className="mt-5 space-y-5">
                {rsvp.members.map((member) => (
                  <div key={member.memberId} className="border-t border-line pt-4 first:border-t-0 first:pt-0">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="font-medium">{member.name}</h3>
                      <span className={member.attending ? 'text-forest' : 'text-ink-soft'}>
                        {member.attending ? 'Coming' : "Can't make it"}
                      </span>
                    </div>
                    {member.attending && guest.menu ? (
                      <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-3">
                        {guest.menu.courses.map((course) => (
                          <div key={course.id}>
                            <dt className="text-xs uppercase tracking-[0.12em] text-ink-soft">
                              {course.title}
                            </dt>
                            <dd>{labelFor(course.id, member.choices[course.id])}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    {member.dietary ? (
                      <p className="mt-2 rounded-md bg-brass-soft px-3 py-2 text-sm text-brass-dark">
                        Kitchen: {member.dietary}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>

              {Object.keys(rsvp.extras).length > 0 ? (
                <p className="mt-5 text-sm text-ink-soft">
                  Extras:{' '}
                  {Object.entries(rsvp.extras)
                    .map(([key, value]) => `${key}: ${value ? 'yes' : 'no'}`)
                    .join(' · ')}
                </p>
              ) : null}

              {rsvp.message ? (
                <blockquote className="mt-5 border-l-2 border-brass pl-4 text-sm italic leading-relaxed">
                  {rsvp.message}
                </blockquote>
              ) : null}
            </>
          ) : (
            <p className="mt-3 text-sm text-ink-soft">
              Nothing yet.{' '}
              {guest.status === 'draft'
                ? 'This page is still a draft, so they cannot reply.'
                : 'Their page is live and waiting.'}
            </p>
          )}
        </section>

        <div className="space-y-6">
          <section className="panel p-6">
            <h2 className="font-display text-xl">Notes for us</h2>
            {guest.privateNotes ? (
              <p className="mt-3 text-sm leading-relaxed text-ink-soft">{guest.privateNotes}</p>
            ) : (
              <p className="mt-3 text-sm text-ink-soft">None.</p>
            )}
            {Object.keys(guest.adminMeta).length > 0 ? (
              <dl className="mt-4 divide-y divide-line text-sm">
                {Object.entries(guest.adminMeta).map(([key, value]) => (
                  <div key={key} className="py-2">
                    <dt className="text-xs uppercase tracking-[0.12em] text-ink-soft">{key}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </section>

          <section className="panel p-6">
            <h2 className="font-display text-xl">Visits</h2>
            {visits.length === 0 ? (
              <p className="mt-3 text-sm text-ink-soft">They have not opened it yet.</p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {visits.map((visit, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span className="truncate text-ink-soft">{visit.path}</span>
                    <span className="shrink-0">{agoFrom(visit.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel p-6">
            <h2 className="font-display text-xl">Their menu</h2>
            {guest.menu ? (
              <div className="mt-3 space-y-4 text-sm">
                {guest.menu.courses.map((course) => (
                  <div key={course.id}>
                    <h3 className="text-xs uppercase tracking-[0.12em] text-ink-soft">
                      {course.title}
                    </h3>
                    <ul className="mt-1 space-y-1">
                      {course.options.map((option) => (
                        <li key={option.id}>
                          {option.label}
                          {option.tongueInCheek ? (
                            <span className="ml-2 rounded bg-brass-soft px-1.5 py-0.5 text-xs text-brass-dark">
                              joke
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-ink-soft">No menu on this page.</p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
