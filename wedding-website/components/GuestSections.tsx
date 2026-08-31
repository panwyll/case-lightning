import type { GuestSection } from '@/lib/guest-schema';

/** Renders the freeform blocks from a guest's JSON file, in order. */
export function GuestSections({ sections }: { sections: GuestSection[] }) {
  if (sections.length === 0) return null;

  return (
    <div className="mt-12 space-y-8">
      {sections.map((section, index) => (
        <Section key={index} section={section} />
      ))}
    </div>
  );
}

function Section({ section }: { section: GuestSection }) {
  switch (section.type) {
    case 'note':
      return (
        <div className="panel p-6 sm:p-8">
          <h2 className="font-display text-2xl">{section.title}</h2>
          <p className="mt-3 leading-relaxed text-ink-soft">{section.body}</p>
        </div>
      );

    case 'list':
      return (
        <div className="panel p-6 sm:p-8">
          <h2 className="font-display text-2xl">{section.title}</h2>
          {section.intro ? <p className="mt-3 text-ink-soft">{section.intro}</p> : null}
          <ul className="mt-4 space-y-2">
            {section.items.map((item, i) => (
              <li key={i} className="flex gap-3 leading-relaxed text-ink-soft">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brass" aria-hidden />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      );

    case 'quote':
      return (
        <blockquote className="border-l-2 border-brass pl-6">
          <p className="font-display text-2xl leading-snug">&ldquo;{section.body}&rdquo;</p>
          {section.attribution ? (
            <footer className="mt-3 text-sm text-ink-soft">— {section.attribution}</footer>
          ) : null}
        </blockquote>
      );

    case 'facts':
      return (
        <div className="panel p-6 sm:p-8">
          <h2 className="font-display text-2xl">{section.title}</h2>
          <dl className="mt-4 divide-y divide-line">
            {section.facts.map((fact) => (
              <div key={fact.label} className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr]">
                <dt className="text-sm uppercase tracking-[0.12em] text-ink-soft">{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      );

    case 'image':
      return (
        <figure>
          {/* Plain <img>: these are a handful of static files, and next/image
              would only add config for no gain here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={section.src}
            alt={section.alt}
            className="w-full rounded-xl2 border border-line object-cover"
          />
          {section.caption ? (
            <figcaption className="mt-2 text-sm text-ink-soft">{section.caption}</figcaption>
          ) : null}
        </figure>
      );
  }
}
