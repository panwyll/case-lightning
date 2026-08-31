'use client';

import { useState } from 'react';
import type { PublicGuest } from '@/lib/guest-schema';

type MemberState = {
  attending: boolean | null;
  choices: Record<string, string>;
  dietary: string;
};

export type ExistingRsvp = {
  members: { memberId: string; attending: boolean; choices: Record<string, string>; dietary?: string }[];
  extras: Record<string, boolean>;
  message?: string;
  updatedAt: string;
} | null;

export function RsvpForm({
  guest,
  existing,
  optionalEvents,
  deadlineLabel,
}: {
  guest: PublicGuest;
  existing: ExistingRsvp;
  optionalEvents: { key: string; label: string; detail?: string }[];
  deadlineLabel: string;
}) {
  const [members, setMembers] = useState<Record<string, MemberState>>(() =>
    Object.fromEntries(
      guest.party.map((person) => {
        const prior = existing?.members.find((m) => m.memberId === person.id);
        return [
          person.id,
          {
            attending: prior ? prior.attending : null,
            choices: prior?.choices ?? {},
            dietary: prior?.dietary ?? '',
          } satisfies MemberState,
        ];
      }),
    ),
  );
  const [extras, setExtras] = useState<Record<string, boolean>>(existing?.extras ?? {});
  const [message, setMessage] = useState(existing?.message ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>(existing ? 'saved' : 'idle');
  const [error, setError] = useState<string | null>(null);

  const relevantExtras = optionalEvents.filter((event) => guest.invitedTo.includes(event.key));
  const unanswered = guest.party.filter((p) => members[p.id]?.attending === null);

  function update(id: string, patch: Partial<MemberState>) {
    setMembers((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    setState('idle');
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (unanswered.length > 0) {
      setError(`Still need a yes or no for ${unanswered.map((p) => p.name).join(', ')}.`);
      return;
    }

    setState('saving');
    const payload = {
      slug: guest.slug,
      members: guest.party.map((person) => ({
        memberId: person.id,
        attending: members[person.id].attending === true,
        choices: members[person.id].choices,
        dietary: members[person.id].dietary,
      })),
      extras,
      message,
    };

    try {
      const res = await fetch('/api/rsvp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? 'That did not save.');
        setState('idle');
        return;
      }
      setState('saved');
    } catch {
      setError('Could not reach the server. Your answers are still on screen — try again.');
      setState('idle');
    }
  }

  return (
    <form onSubmit={onSubmit} className="panel p-6 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-2xl">RSVP</h2>
        <p className="text-sm text-ink-soft">Please reply by {deadlineLabel}</p>
      </div>

      {guest.menu?.intro ? (
        <p className="mt-4 leading-relaxed text-ink-soft">{guest.menu.intro}</p>
      ) : null}

      <div className="mt-8 space-y-8">
        {guest.party.map((person) => {
          const state = members[person.id];
          const showMenu = guest.menu && !person.skipMenu && state.attending === true;

          return (
            <div key={person.id} className="border-t border-line pt-6 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg">
                  {person.name}
                  {person.tag ? (
                    <span className="ml-2 rounded-full bg-brass-soft px-2 py-0.5 text-xs text-brass-dark">
                      {person.tag}
                    </span>
                  ) : null}
                </h3>
                <fieldset className="flex gap-2">
                  <legend className="sr-only">Is {person.name} coming?</legend>
                  <Choice
                    name={`attending-${person.id}`}
                    checked={state.attending === true}
                    onChange={() => update(person.id, { attending: true })}
                    label="Coming"
                  />
                  <Choice
                    name={`attending-${person.id}`}
                    checked={state.attending === false}
                    onChange={() => update(person.id, { attending: false })}
                    label="Can't make it"
                  />
                </fieldset>
              </div>

              {showMenu && guest.menu ? (
                <div className="mt-5 grid gap-4 sm:grid-cols-3">
                  {guest.menu.courses.map((course) => (
                    <div key={course.id}>
                      <label className="label" htmlFor={`${person.id}-${course.id}`}>
                        {course.title}
                      </label>
                      <select
                        id={`${person.id}-${course.id}`}
                        className="field mt-2"
                        value={state.choices[course.id] ?? ''}
                        onChange={(e) =>
                          update(person.id, {
                            choices: { ...state.choices, [course.id]: e.target.value },
                          })
                        }
                      >
                        <option value="">Choose…</option>
                        {course.options.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      {course.note ? (
                        <p className="mt-2 text-xs text-ink-soft">{course.note}</p>
                      ) : null}
                      <Descriptions courseId={course.id} chosen={state.choices[course.id]} guest={guest} />
                    </div>
                  ))}
                </div>
              ) : null}

              {state.attending === true ? (
                <div className="mt-5">
                  <label className="label" htmlFor={`dietary-${person.id}`}>
                    Allergies or anything the kitchen should know
                  </label>
                  <input
                    id={`dietary-${person.id}`}
                    className="field mt-2"
                    value={state.dietary}
                    onChange={(e) => update(person.id, { dietary: e.target.value })}
                    placeholder="Optional"
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {relevantExtras.length > 0 ? (
        <div className="mt-8 border-t border-line pt-6">
          {relevantExtras.map((event) => (
            <label key={event.key} className="flex items-start gap-3 py-2">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-forest"
                checked={Boolean(extras[event.key])}
                onChange={(e) => {
                  setExtras((prev) => ({ ...prev, [event.key]: e.target.checked }));
                  setState('idle');
                }}
              />
              <span>
                <span className="block text-sm font-medium">{event.label}</span>
                {event.detail ? (
                  <span className="block text-sm text-ink-soft">{event.detail}</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      ) : null}

      <div className="mt-8 border-t border-line pt-6">
        <label className="label" htmlFor="message">
          Anything you want to tell us
        </label>
        <textarea
          id="message"
          className="field mt-2 min-h-24"
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            setState('idle');
          }}
        />
      </div>

      {error ? (
        <p role="alert" className="mt-5 text-sm text-brass-dark">
          {error}
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <button type="submit" className="btn-primary" disabled={state === 'saving'}>
          {state === 'saving' ? 'Saving…' : existing ? 'Update our answers' : 'Send our answers'}
        </button>
        {state === 'saved' ? (
          <p role="status" className="text-sm text-forest">
            Saved. You can change any of it until {deadlineLabel}.
          </p>
        ) : null}
      </div>
    </form>
  );
}

/** Shows the blurb for whichever option is currently selected. */
function Descriptions({
  courseId,
  chosen,
  guest,
}: {
  courseId: string;
  chosen: string | undefined;
  guest: PublicGuest;
}) {
  if (!chosen || !guest.menu) return null;
  const course = guest.menu.courses.find((c) => c.id === courseId);
  const option = course?.options.find((o) => o.id === chosen);
  if (!option?.description) return null;
  return <p className="mt-2 text-xs italic leading-relaxed text-ink-soft">{option.description}</p>;
}

function Choice({
  name,
  checked,
  onChange,
  label,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label
      className={`cursor-pointer rounded-full border px-4 py-1.5 text-sm transition-colors ${
        checked ? 'border-forest bg-forest text-paper' : 'border-line bg-card text-ink-soft hover:border-brass'
      }`}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} className="sr-only" />
      {label}
    </label>
  );
}
