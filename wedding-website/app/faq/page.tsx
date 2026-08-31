import { PageShell } from '@/components/PageShell';
import { wedding } from '@/content/wedding';
import { currentSessions } from '@/lib/session';
import { getGuest } from '@/lib/guests';

export const metadata = { title: 'Questions' };

export default async function FaqPage() {
  const { guestSlug } = await currentSessions();
  const guest = guestSlug ? getGuest(guestSlug) : null;

  return (
    <PageShell
      kicker="Things people keep asking"
      title="Questions"
      guestName={guest?.displayName}
      guestSlug={guestSlug}
      path="/faq"
    >
      {guest && guest.faq.length > 0 ? (
        <div className="mb-10">
          <h2 className="mb-4 text-sm uppercase tracking-[0.16em] text-brass">
            Specifically for {guest.displayName}
          </h2>
          <dl className="divide-y divide-line border-y border-line">
            {guest.faq.map((item) => (
              <Item key={item.q} q={item.q} a={item.a} />
            ))}
          </dl>
        </div>
      ) : null}

      <dl className="divide-y divide-line border-y border-line">
        {wedding.faq.map((item) => (
          <Item key={item.q} q={item.q} a={item.a} />
        ))}
      </dl>

      <p className="mt-10 text-sm text-ink-soft">
        {wedding.contact.note}{' '}
        <a className="text-brass hover:text-brass-dark" href={`mailto:${wedding.contact.email}`}>
          {wedding.contact.email}
        </a>
      </p>
    </PageShell>
  );
}

function Item({ q, a }: { q: string; a: string }) {
  return (
    <div className="py-5">
      <dt className="font-display text-lg">{q}</dt>
      <dd className="mt-1 leading-relaxed text-ink-soft">{a}</dd>
    </div>
  );
}
