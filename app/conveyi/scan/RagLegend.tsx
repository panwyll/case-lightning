/**
 * What red, amber and green mean, as a grid rather than a sentence: does the work need a conveyancer, and does it move
 * the case on. Colours as the charts draw them (app/shared/epa/TimeView.tsx).
 */
const C = { green: '#1E8E4E', amber: '#E39A2D', red: '#D64A3A' } as const;

function Cell({ c, label }: { c: keyof typeof C; label: string }) {
  return (
    <div className="flex h-11 items-center justify-center rounded-lg text-sm font-semibold" style={{ background: C[c], color: c === 'amber' ? '#3b2405' : '#fff' }}>
      {label}
    </div>
  );
}

export function RagLegend({ className = '' }: { className?: string }) {
  return (
    <figure className={`inline-grid grid-cols-[5.5rem_auto_5.5rem_5.5rem] items-center gap-1.5 text-sm text-ink-soft ${className}`} aria-label="Green: needs a conveyancer and moves the case on. Amber: one of the two. Red: neither.">
      <span />
      <span />
      <span className="col-span-2 pb-1 text-center font-semibold text-ink">Moves the case on?</span>
      <span />
      <span />
      <span className="text-center">Yes</span>
      <span className="text-center">No</span>
      <span className="row-span-2 pr-2 text-right font-semibold leading-snug text-ink">Needs a conveyancer?</span>
      <span className="pr-1 text-right">Yes</span>
      <Cell c="green" label="Green" />
      <Cell c="amber" label="Amber" />
      <span className="pr-1 text-right">No</span>
      <Cell c="amber" label="Amber" />
      <Cell c="red" label="Red" />
    </figure>
  );
}
