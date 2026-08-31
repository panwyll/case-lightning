import { PageShell } from '@/components/PageShell';
import { wedding } from '@/content/wedding';
import { getGuest } from '@/lib/guests';
import { currentSessions } from '@/lib/session';

export const metadata = { title: 'The day' };

export default async function SchedulePage() {
  const { guestSlug } = await currentSessions();
  const guest = guestSlug ? getGuest(guestSlug) : null;

  // A guest only sees the parts of the day they are actually invited to.
  const items = wedding.schedule.filter(
    (item) => !item.requires || !guest || guest.invitedTo.includes(item.requires),
  );

  return (
    <PageShell
      kicker={wedding.dateLabel}
      title="How the day runs"
      intro={wedding.timeLabel}
      guestName={guest?.displayName}
      guestSlug={guestSlug}
      path="/schedule"
    >
      <ol className="space-y-0">
        {items.map((item, index) => (
          <li
            key={`${item.time}-${item.title}`}
            className={`grid gap-2 py-6 sm:grid-cols-[8rem_1fr] ${index > 0 ? 'border-t border-line' : ''}`}
          >
            <div className="font-display text-xl text-brass">{item.time}</div>
            <div>
              <h2 className="text-lg">{item.title}</h2>
              {item.detail ? <p className="mt-1 text-ink-soft">{item.detail}</p> : null}
            </div>
          </li>
        ))}
      </ol>

      <p className="mt-10 rounded-xl2 border border-line bg-paper-deep/60 p-5 text-sm text-ink-soft">
        {wedding.dressCode.title}: {wedding.dressCode.body}
      </p>
    </PageShell>
  );
}
