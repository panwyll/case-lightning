import { PageShell } from '@/components/PageShell';
import { wedding } from '@/content/wedding';
import { currentSessions } from '@/lib/session';
import { getGuest } from '@/lib/guests';

export const metadata = { title: 'Gifts' };

/**
 * Registries are run by people who do this professionally. We link out and
 * touch nothing — no payment handling, no gift state, nothing to break.
 */
export default async function RegistryPage() {
  const { guestSlug } = await currentSessions();
  const guest = guestSlug ? getGuest(guestSlug) : null;

  return (
    <PageShell
      kicker="Entirely optional"
      title="Gifts"
      intro={wedding.registry.intro}
      guestName={guest?.displayName}
      guestSlug={guestSlug}
      path="/registry"
    >
      <div className="grid gap-6 sm:grid-cols-2">
        {wedding.registry.links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noreferrer noopener"
            className="panel group flex flex-col p-6 transition-colors hover:border-brass"
          >
            <h2 className="text-xl group-hover:text-brass-dark">{link.name}</h2>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-soft">{link.blurb}</p>
            <span className="mt-5 text-sm text-brass">Open the list &rarr;</span>
          </a>
        ))}
      </div>
    </PageShell>
  );
}
