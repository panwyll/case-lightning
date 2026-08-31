import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getGuest } from '@/lib/guests';
import { currentSessions } from '@/lib/session';
import { store } from '@/lib/store';
import type { MemberResponse } from '@/lib/store';

export const runtime = 'nodejs';

const Payload = z.object({
  slug: z.string(),
  members: z.array(
    z.object({
      memberId: z.string(),
      attending: z.boolean(),
      choices: z.record(z.string()).default({}),
      dietary: z.string().max(500).optional(),
    }),
  ),
  extras: z.record(z.boolean()).default({}),
  message: z.string().max(2000).optional(),
});

export async function POST(request: Request) {
  const parsed = Payload.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'That form did not arrive intact.' }, { status: 400 });
  }
  const input = parsed.data;

  const { admin, guestSlug } = await currentSessions();
  if (!admin && guestSlug !== input.slug) {
    return NextResponse.json({ error: 'This is not your invitation.' }, { status: 403 });
  }

  const guest = getGuest(input.slug);
  if (!guest || guest.status === 'closed') {
    return NextResponse.json({ error: 'RSVPs for this page are closed.' }, { status: 404 });
  }
  if (guest.status === 'draft' && !admin) {
    return NextResponse.json({ error: 'Not yet.' }, { status: 404 });
  }

  // Only accept people and menu options that exist on this guest's own page.
  const members: MemberResponse[] = [];
  for (const member of guest.party) {
    const submitted = input.members.find((m) => m.memberId === member.id);
    if (!submitted) continue;

    const choices: Record<string, string> = {};
    if (guest.menu && !member.skipMenu && submitted.attending) {
      for (const course of guest.menu.courses) {
        const chosen = submitted.choices[course.id];
        if (chosen && course.options.some((o) => o.id === chosen)) {
          choices[course.id] = chosen;
        }
      }
    }

    members.push({
      memberId: member.id,
      name: member.name,
      attending: submitted.attending,
      choices,
      dietary: submitted.dietary?.trim() || undefined,
    });
  }

  if (members.length === 0) {
    return NextResponse.json({ error: 'Nobody was selected.' }, { status: 400 });
  }

  const extras: Record<string, boolean> = {};
  for (const key of guest.invitedTo) {
    if (key in input.extras) extras[key] = Boolean(input.extras[key]);
  }

  const now = new Date().toISOString();
  try {
    await store().saveRsvp({
      slug: guest.slug,
      members,
      extras,
      message: input.message?.trim() || undefined,
      submittedAt: now,
      updatedAt: now,
    });
  } catch (error) {
    console.error('[rsvp] save failed', error);
    return NextResponse.json({ error: 'We could not save that. Please try again.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
