/**
 * Merge two matters that are really one case.
 *
 * Moves every matter-scoped record from the "merge-away" matter onto the
 * "keep" (survivor) matter in a single transaction, de-duplicating the rows that
 * have uniqueness constraints (identifiers, contacts). The merged-away matter is
 * NOT deleted — it's marked status='MERGED' with merged_into pointing at the
 * survivor, so audit history and its OneDrive folder stay reachable. Files are
 * left in place (v1); a timeline event + tracker note on the survivor record the
 * merge and link to the old folder.
 */
import { transaction, queryOne } from './db';
import { appendTrackerRow } from './graph';
import { writeAudit } from './audit';
import type { SessionUser } from './types';

// Tables whose `matter_id` simply moves to the survivor (no uniqueness to resolve).
const STRAIGHT_MOVE_TABLES = [
  'matter_task',
  'matter_timeline_event',
  'document',
  'document_review',
  'email_thread',
  'email_message',
  'kb_chunk',
  'usage_event',
] as const;

interface MatterLite {
  id: string;
  matter_ref: string;
  folder_web_url: string | null;
  tracker_item_id: string | null;
}

export interface MergeResult {
  keepRef: string;
  mergedRef: string;
  mergedFolderUrl: string | null;
}

export async function mergeMatters(user: SessionUser, keepId: string, mergeId: string): Promise<MergeResult> {
  if (keepId === mergeId) throw new Error('Pick two different matters to merge.');

  const tenantId = user.tenantId;
  const keep = await queryOne<MatterLite>(
    `select id, matter_ref, folder_web_url, tracker_item_id from matter
     where id = $1 and tenant_id = $2 and status <> 'MERGED'`,
    [keepId, tenantId]
  );
  const merge = await queryOne<MatterLite>(
    `select id, matter_ref, folder_web_url, tracker_item_id from matter
     where id = $1 and tenant_id = $2 and status <> 'MERGED'`,
    [mergeId, tenantId]
  );
  if (!keep) throw new Error('The matter to keep was not found.');
  if (!merge) throw new Error('The matter to merge was not found (it may already be merged).');

  await transaction(async (c) => {
    // Identifiers — drop any on the merge matter that the survivor already has,
    // then move the rest (unique on tenant_id, matter_id, kind, value).
    await c.query(
      `delete from matter_identifier mi
        where mi.matter_id = $1
          and exists (select 1 from matter_identifier k
                       where k.matter_id = $2 and k.tenant_id = mi.tenant_id
                         and k.kind = mi.kind and k.value = mi.value)`,
      [mergeId, keepId]
    );
    await c.query(`update matter_identifier set matter_id = $1 where matter_id = $2`, [keepId, mergeId]);

    // Contacts — unique on (matter_id, email); de-dupe by email, then move.
    await c.query(
      `delete from matter_contact mc
        where mc.matter_id = $1
          and exists (select 1 from matter_contact k
                       where k.matter_id = $2 and lower(k.email) = lower(mc.email))`,
      [mergeId, keepId]
    );
    await c.query(`update matter_contact set matter_id = $1 where matter_id = $2`, [keepId, mergeId]);

    // Straight moves (table names are hardcoded constants — not user input).
    for (const tbl of STRAIGHT_MOVE_TABLES) {
      await c.query(`update ${tbl} set matter_id = $1 where matter_id = $2`, [keepId, mergeId]);
    }

    // Triage points via matched_matter_id; onboarding via matter_id.
    await c.query(`update email_triage set matched_matter_id = $1 where matched_matter_id = $2`, [keepId, mergeId]);
    await c.query(`update onboarding_case set matter_id = $1 where matter_id = $2`, [keepId, mergeId]);

    // matter_summary is one row per matter (matter_id is PK) — keep the survivor's,
    // discard the merged matter's.
    await c.query(`delete from matter_summary where matter_id = $1`, [mergeId]);

    // Record the merge on the survivor's timeline.
    await c.query(
      `insert into matter_timeline_event (tenant_id, matter_id, event_at, event_type, title, details, source_ref)
       values ($1, $2, now(), 'MATTER_MERGED', $3, $4, $5::jsonb)`,
      [
        tenantId,
        keepId,
        `Merged in ${merge.matter_ref}`,
        `${merge.matter_ref} was merged into this matter. Its previous folder: ${merge.folder_web_url ?? '(none)'}`,
        JSON.stringify({ mergedFrom: mergeId, mergedRef: merge.matter_ref, folderWebUrl: merge.folder_web_url }),
      ]
    );

    // Mark the merged matter as merged (drops off the OPEN board).
    await c.query(`update matter set status = 'MERGED', merged_into = $1, updated_at = now() where id = $2`, [keepId, mergeId]);
  });

  // Best-effort: note the merge on the survivor's Excel case log, and audit it.
  if (keep.tracker_item_id) {
    await appendTrackerRow(user.userId, keep.tracker_item_id, {
      date: new Date().toISOString().slice(0, 10),
      type: 'Merge',
      detail: `Merged in ${merge.matter_ref}${merge.folder_web_url ? ` — old folder: ${merge.folder_web_url}` : ''}`,
      owner: user.displayName ?? user.email ?? '',
      due: '',
      status: 'Done',
    }).catch(() => {});
  }
  await writeAudit({
    tenantId,
    matterId: keepId,
    actorUserId: user.userId,
    actionType: 'MATTER_MERGED',
    actionStatus: 'SUCCESS',
    payload: { keepId, keepRef: keep.matter_ref, mergeId, mergedRef: merge.matter_ref },
  }).catch(() => {});

  return { keepRef: keep.matter_ref, mergedRef: merge.matter_ref, mergedFolderUrl: merge.folder_web_url ?? null };
}
