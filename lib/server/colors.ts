/**
 * Stable per-matter Outlook category colour. Kept in its own tiny module so both
 * triage.ts and the automations engine can use it without an import cycle.
 *
 * Each matter gets its own stable pill colour, cycling through this palette
 * (matter N+1 loops back to the start). Deliberately excludes the RAG status
 * colours (red preset0 / amber preset1 / green preset4) and the grey/steel/black
 * presets, so a matter pill never reads as urgency or as "uncoloured".
 */
const MATTER_PALETTE = [
  'preset7', 'preset8', 'preset5', 'preset3', 'preset9', 'preset6', 'preset2',
  'preset16', 'preset18', 'preset19', 'preset20', 'preset22', 'preset15', 'preset23',
];

function hashRef(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Stable per-matter pill colour (same matter ref → same colour, always). */
export function matterColor(matterRef: string): string {
  return MATTER_PALETTE[hashRef(matterRef) % MATTER_PALETTE.length];
}
