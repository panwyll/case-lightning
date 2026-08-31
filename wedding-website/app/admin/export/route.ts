import { allGuests } from '@/lib/guests';
import { store } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One row per person. This is the file the caterer and the venue actually
 * want, so it resolves option ids back into the labels on the menu.
 * Gated by the /admin middleware rule.
 */
export async function GET() {
  const guests = allGuests();
  const rsvps = await store().listRsvps().catch(() => []);
  const bySlug = new Map(rsvps.map((r) => [r.slug, r]));

  const courseIds = [...new Set(guests.flatMap((g) => g.menu?.courses.map((c) => c.id) ?? []))];
  const header = [
    'guest_page',
    'display_name',
    'status',
    'person',
    'tag',
    'attending',
    ...courseIds,
    'dietary',
    'extras',
    'message',
    'replied_at',
  ];

  const rows: string[][] = [];
  for (const guest of guests) {
    const rsvp = bySlug.get(guest.slug);
    for (const person of guest.party) {
      const response = rsvp?.members.find((m) => m.memberId === person.id);
      const choices = courseIds.map((courseId) => {
        const optionId = response?.choices[courseId];
        if (!optionId) return '';
        const course = guest.menu?.courses.find((c) => c.id === courseId);
        return course?.options.find((o) => o.id === optionId)?.label ?? optionId;
      });

      rows.push([
        guest.slug,
        guest.displayName,
        guest.status,
        person.name,
        person.tag ?? '',
        response ? (response.attending ? 'yes' : 'no') : '',
        ...choices,
        response?.dietary ?? '',
        rsvp ? Object.entries(rsvp.extras).filter(([, v]) => v).map(([k]) => k).join(' ') : '',
        rsvp?.message ?? '',
        rsvp?.updatedAt ?? '',
      ]);
    }
  }

  const csv = [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
  const date = new Date().toISOString().slice(0, 10);

  return new Response(`﻿${csv}`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="rsvps-${date}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

/**
 * Quotes every field, and neutralises the leading characters spreadsheets
 * treat as the start of a formula.
 */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
