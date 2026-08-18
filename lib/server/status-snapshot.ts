/**
 * The deterministic "where does this matter stand" snapshot.
 *
 * A status request ("any update on my purchase?") is the case where the incoming
 * email carries almost nothing to work from, so a draft built only from the thread
 * and a semantic search comes out fluent and frequently wrong. Everything a good
 * status answer needs already exists in the data — it just was never assembled and
 * handed to the draft:
 *
 *   • macro stage, and how long we've been in it
 *   • the last few things that actually happened (chronological, not semantic)
 *   • what WE still have to do            (matter_summary.outstanding_items)
 *   • what we're WAITING ON others for    (matter_summary.awaiting)
 *
 * Assembled with plain SQL, no LLM — so it's fast, cheap and can't hallucinate.
 * Rendered to a compact block the draft prompt can lean on.
 */
import { query, queryOne } from './db';

export interface StatusSnapshot {
  stage: string | null;
  stageLabel: string;
  daysInStage: number | null;
  lastActions: Array<{ when: string | null; title: string }>;
  outstanding: string[];
  awaiting: string[];
}

/** INSTRUCTION → "Instruction", CONTRACT_PACK → "Contract pack". */
function humanizeStage(code: string | null): string {
  if (!code) return 'In progress';
  return code
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

export async function getStatusSnapshot(tenantId: string, matterId: string): Promise<StatusSnapshot | null> {
  const m = await queryOne<{ stage: string | null; stage_entered_at: string | null }>(
    `select stage, stage_entered_at from matter where id = $1 and tenant_id = $2`,
    [matterId, tenantId]
  ).catch(() => null);
  if (!m) return null;

  const daysInStage = m.stage_entered_at
    ? Math.max(0, Math.floor((Date.now() - new Date(m.stage_entered_at).getTime()) / 86_400_000))
    : null;

  const events = await query<{ event_at: string | null; created_at: string; title: string }>(
    `select event_at, created_at, title
       from matter_timeline_event
      where tenant_id = $1 and matter_id = $2
      order by coalesce(event_at, created_at) desc
      limit 5`,
    [tenantId, matterId]
  ).catch(() => []);

  // outstanding + awaiting live on the summary; awaiting is guarded (pre-062).
  let outstanding: string[] = [];
  let awaiting: string[] = [];
  try {
    const s = await queryOne<{ outstanding_items: string[] | null; awaiting: string[] | null }>(
      `select outstanding_items, awaiting from matter_summary where matter_id = $1 and tenant_id = $2`,
      [matterId, tenantId]
    );
    outstanding = s?.outstanding_items ?? [];
    awaiting = s?.awaiting ?? [];
  } catch {
    const s = await queryOne<{ outstanding_items: string[] | null }>(
      `select outstanding_items from matter_summary where matter_id = $1 and tenant_id = $2`,
      [matterId, tenantId]
    ).catch(() => null);
    outstanding = s?.outstanding_items ?? [];
  }

  return {
    stage: m.stage,
    stageLabel: humanizeStage(m.stage),
    daysInStage,
    lastActions: events.map((e) => {
      // pg returns timestamptz as Date objects, so coerce before slicing (a raw
      // Date has no .slice — this silently killed the whole snapshot until caught).
      const raw = e.event_at ?? e.created_at;
      return { when: raw ? new Date(raw).toISOString().slice(0, 10) : null, title: e.title };
    }),
    outstanding,
    awaiting,
  };
}

/** Compact text block for a draft prompt. Empty string if there's nothing to say. */
export function renderStatusSnapshot(s: StatusSnapshot | null): string {
  if (!s) return '';
  const lines: string[] = [];
  lines.push(`Stage: ${s.stageLabel}${s.daysInStage != null ? ` (for ${s.daysInStage} day${s.daysInStage === 1 ? '' : 's'})` : ''}`);
  if (s.lastActions.length) {
    lines.push('Recent activity (newest first):');
    for (const a of s.lastActions) lines.push(`  - ${a.when ? `${a.when}: ` : ''}${a.title}`);
  }
  if (s.awaiting.length) {
    lines.push('Waiting on others:');
    for (const a of s.awaiting) lines.push(`  - ${a}`);
  }
  if (s.outstanding.length) {
    lines.push('Our own next actions:');
    for (const a of s.outstanding) lines.push(`  - ${a}`);
  }
  return lines.join('\n');
}
