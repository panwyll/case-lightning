export type GuestStatus = 'draft' | 'live' | 'closed';

const STYLES: Record<GuestStatus, string> = {
  draft: 'border-line bg-paper-deep text-ink-soft',
  live: 'border-forest/30 bg-forest/10 text-forest',
  closed: 'border-brass/40 bg-brass-soft text-brass-dark',
};

export function StatusPill({ status }: { status: GuestStatus }) {
  return <span className={`rounded-full border px-2.5 py-0.5 text-xs ${STYLES[status]}`}>{status}</span>;
}
