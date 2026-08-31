import { PageShell } from '@/components/PageShell';
import { wedding } from '@/content/wedding';
import { currentSessions } from '@/lib/session';
import { getGuest } from '@/lib/guests';

export const metadata = { title: 'Travel & stay' };

export default async function TravelPage() {
  const { guestSlug } = await currentSessions();
  const guest = guestSlug ? getGuest(guestSlug) : null;

  return (
    <PageShell
      kicker={wedding.venue.name}
      title="Getting there, and staying"
      intro={wedding.travel.intro}
      guestName={guest?.displayName}
      guestSlug={guestSlug}
      path="/travel"
    >
      <div className="panel p-6">
        <h2 className="text-xl">{wedding.venue.name}</h2>
        <address className="mt-2 not-italic leading-relaxed text-ink-soft">
          {wedding.venue.addressLines.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </address>
        <a
          className="mt-4 inline-block text-sm text-brass hover:text-brass-dark"
          href={wedding.venue.mapsUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          Open in Maps &rarr;
        </a>
        {wedding.venue.what3words ? (
          <p className="mt-2 text-sm text-ink-soft">what3words: {wedding.venue.what3words}</p>
        ) : null}
      </div>

      <div className="mt-8 grid gap-6 sm:grid-cols-3">
        {wedding.travel.options.map((option) => (
          <div key={option.title} className="panel p-6">
            <h3 className="text-lg">{option.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">{option.body}</p>
          </div>
        ))}
      </div>
    </PageShell>
  );
}
