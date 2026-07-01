/**
 * Figure history — an append-only audit of changes to a matter's key figures (price,
 * deposit, exchange/completion dates, lender, parties…): who, when, why, and the email or
 * document it came from. Recorded at each write site; read back on the taskpane House tab.
 *
 * All writes are best-effort and guarded so a deploy that lands before migration 034 runs
 * can't break the underlying figure edits — the history simply starts once the table exists.
 */
import { query } from './db';

export type FigureSource = 'MANUAL' | 'AI_EMAIL' | 'AI_DOC' | 'IMPORT' | 'TRACKER';

export interface FigureChange {
  field: string;
  label: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface FigureRef {
  kind: 'EMAIL' | 'DOCUMENT';
  id?: string | null;
  label?: string | null;
  url?: string | null;
}

/** Empty/whitespace/undefined all read as "no value" so we don't log no-op "changes". */
const norm = (v: string | null | undefined): string => (v == null ? '' : String(v).trim());

/** Coerce any extracted fact value to a comparable/displayable string (or null). */
export const factToStr = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

/** "purchase_price" / "purchasePrice" → "Purchase price" — a readable label for a fact key. */
export const prettyLabel = (key: string): string => {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
};

/** Records one row per figure that actually changed. Silently ignores no-op diffs. */
export async function recordFigureChanges(input: {
  tenantId: string;
  matterId: string;
  actorUserId?: string | null;
  source: FigureSource;
  reason?: string | null;
  ref?: FigureRef | null;
  changes: FigureChange[];
}): Promise<void> {
  const real = input.changes.filter((c) => norm(c.oldValue) !== norm(c.newValue));
  if (real.length === 0) return;
  try {
    for (const c of real) {
      await query(
        `insert into matter_figure_change
           (tenant_id, matter_id, field, label, old_value, new_value, source,
            actor_user_id, reason, ref_kind, ref_id, ref_label, ref_url)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          input.tenantId,
          input.matterId,
          c.field,
          c.label,
          c.oldValue,
          c.newValue,
          input.source,
          input.actorUserId ?? null,
          input.reason ?? null,
          input.ref?.kind ?? null,
          input.ref?.id ?? null,
          input.ref?.label ?? null,
          input.ref?.url ?? null,
        ]
      );
    }
  } catch {
    /* matter_figure_change not migrated yet — history starts once 034 runs */
  }
}
