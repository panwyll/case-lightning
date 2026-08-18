/**
 * Which user's OneDrive a matter's files live in.
 *
 * Graph's /me/drive is always the CALLING user's drive, so with several colleagues
 * on one case the documents fragmented: the folder was created in whoever made the
 * matter, and a colleague filing an attachment created the same path in their own
 * drive. One case, three copies of the folder, and only one of them reachable from
 * the stored web URL.
 *
 * Every drive operation for a matter therefore runs as the matter's OWNER — the user
 * who created it — using the delegated token we already hold for them. No new Graph
 * permission: this is about being consistent as to whose token performs the call,
 * not about gaining access to anyone else's data. The owner's colleagues reach the
 * files through the app, and the owner shares the folder in OneDrive if they want to
 * browse it directly.
 *
 * Falls back to the caller when there's no owner recorded (matters created before
 * migration 060) or when the owner's token can't be used — better to file into the
 * caller's drive, as it always did, than to lose the document.
 */
import { queryOne } from './db';

/** Cheap per-request memo: a single save touches the drive several times. */
const cache = new Map<string, string>();

export async function driveUserFor(
  tenantId: string,
  matterId: string,
  fallbackUserId: string
): Promise<string> {
  const key = `${tenantId}:${matterId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const row = await queryOne<{ drive_owner_user_id: string | null }>(
      `select drive_owner_user_id from matter where id = $1 and tenant_id = $2`,
      [matterId, tenantId]
    );
    const owner = row?.drive_owner_user_id ?? null;
    if (owner) {
      cache.set(key, owner);
      return owner;
    }
  } catch {
    /* column not migrated yet — fall through */
  }
  return fallbackUserId;
}

/** Forget a matter's owner (after a merge, or when the owner is reassigned). */
export function forgetDriveUser(tenantId: string, matterId: string): void {
  cache.delete(`${tenantId}:${matterId}`);
}
