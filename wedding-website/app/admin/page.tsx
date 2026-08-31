import Link from 'next/link';
import { CopyButton } from '@/components/CopyButton';
import { StatusPill } from '@/components/StatusPill';
import { wedding } from '@/content/wedding';
import { guestCode, personalLink } from '@/lib/auth';
import { agoFrom } from '@/lib/format';
import { allGuests, seatCount } from '@/lib/guests';
import { store } from '@/lib/store';
import type { Rsvp, VisitSummary } from '@/lib/store';

export const dynamic = 'force-dynamic';

export default async function AdminHome() {
  const guests = allGuests();

  // A broken store must not take the dashboard down — that is when you need it.
  const [rsvps, visits, storeError] = await Promise.all([
    store().listRsvps().catch(() => [] as Rsvp[]),
    store().visitSummary().catch(() => ({}) as Record<string, VisitSummary>),
    store()
      .ready()
      .then(() => null)
      .catch((e: Error) => e.message),
  ]);

  const bySlug = new Map(rsvps.map((r) => [r.slug, r]));
  const rows = await Promise.all(
    guests.map(async (guest) => {
      const code = guest.accessCode ?? (await guestCode(guest.slug));
      return { guest, code, rsvp: bySlug.get(guest.slug) ?? null, visit: visits[guest.slug] ?? null };
    }),
  );

  const attending = rsvps.flatMap((r) => r.members).filter((m) => m.attending).length;
  const declined = rsvps.flatMap((r) => r.members).filter((m) => !m.attending).length;
  const awaiting = guests.filter((g) => g.status === 'live' && !bySlug.has(g.slug)).length;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl">Guests</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {wedding.dateLabel} · replies due {wedding.rsvpDeadlineLabel}
          </p>
        </div>
      </div>

      {storeError ? (
        <p className="mt-6 rounded-lg border border-brass bg-brass-soft px-4 py-3 text-sm text-brass-dark">
          The store is not reachable: {storeError}. Numbers below may be incomplete.
        </p>
      ) : null}

      <div className="mt-8 grid gap-4 sm:grid-cols-4">
        <Stat label="Seats offered" value={seatCount()} hint="across live pages" />
        <Stat label="Coming" value={attending} />
        <Stat label="Can't make it" value={declined} />
        <Stat label="Still to reply" value={awaiting} hint="live pages, no RSVP" />
      </div>

      <div className="mt-10 overflow-x-auto">
        <table className="w-full min-w-[54rem] border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-[0.12em] text-ink-soft">
              <Th>Guest</Th>
              <Th>Status</Th>
              <Th>Seats</Th>
              <Th>RSVP</Th>
              <Th>Opened</Th>
              <Th>Personal link</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ guest, code, rsvp, visit }) => (
              <tr key={guest.slug} className="border-t border-line align-top">
                <Td>
                  <Link className="font-medium hover:text-brass-dark" href={`/admin/g/${guest.slug}`}>
                    {guest.displayName}
                  </Link>
                  <div className="text-xs text-ink-soft">{guest.slug}</div>
                </Td>
                <Td>
                  <StatusPill status={guest.status} />
                </Td>
                <Td>{guest.party.length}</Td>
                <Td>
                  {rsvp ? (
                    <>
                      <span className="text-forest">
                        {rsvp.members.filter((m) => m.attending).length} coming
                      </span>
                      <div className="text-xs text-ink-soft">{agoFrom(rsvp.updatedAt)}</div>
                    </>
                  ) : (
                    <span className="text-ink-soft">—</span>
                  )}
                </Td>
                <Td>
                  {visit ? (
                    <>
                      {visit.count}×<div className="text-xs text-ink-soft">{agoFrom(visit.last)}</div>
                    </>
                  ) : (
                    <span className="text-ink-soft">never</span>
                  )}
                </Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <code className="rounded bg-paper-deep px-1.5 py-0.5 text-xs">{code}</code>
                    <CopyButton value={personalLink(guest.slug, code)} label="Copy link" />
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-8 text-sm text-ink-soft">
        Add a guest with <code className="rounded bg-paper-deep px-1.5 py-0.5">npm run guests:new</code>, or
        copy <code className="rounded bg-paper-deep px-1.5 py-0.5">content/guests/_template.json</code>.
      </p>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="panel p-5">
      <div className="text-xs uppercase tracking-[0.12em] text-ink-soft">{label}</div>
      <div className="mt-2 font-display text-3xl">{value}</div>
      {hint ? <div className="mt-1 text-xs text-ink-soft">{hint}</div> : null}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="pb-3 pr-4 font-medium">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="py-4 pr-4">{children}</td>;
}
