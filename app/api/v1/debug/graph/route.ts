import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { graphClientForUser } from '@/lib/server/graph';
import { query } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Pre-RAG single-word status tags, now orphaned by the "<Action> · <Urgency>"
// rename. These were only ever applied by us, so stripping them is safe.
const OLD_STATUS_TAGS = ['Reply', 'Action', 'Delegate', 'Ignore'];
const MATTER_COLOR = 'preset7'; // blue — keep in sync with lib/server/triage.ts

interface MasterCategory {
  id: string;
  displayName: string;
  color: string | null;
}

/**
 * One-off cleanup (run from a browser, then this route is removed):
 *  1. Strip the orphaned old single-word status tags off recent messages.
 *  2. Delete those now-dead master categories.
 *  3. Recolour any matter-ref category that has drifted off blue.
 */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const client = await graphClientForUser(user.userId);

    // 1. Strip old status tags from recent messages (bounded sweep).
    let strippedMessages = 0;
    let url: string | null = '/me/messages?$select=id,categories&$top=100';
    for (let page = 0; url && page < 6; page += 1) {
      const res: { value?: Array<{ id: string; categories?: string[] }>; '@odata.nextLink'?: string } =
        await client.api(url).get();
      for (const msg of res.value ?? []) {
        const cats = msg.categories ?? [];
        if (!cats.some((c) => OLD_STATUS_TAGS.includes(c))) continue;
        const kept = cats.filter((c) => !OLD_STATUS_TAGS.includes(c));
        await client.api(`/me/messages/${msg.id}`).patch({ categories: kept });
        strippedMessages += 1;
      }
      const next = res['@odata.nextLink'];
      url = next ? next.replace('https://graph.microsoft.com/v1.0', '') : null;
    }

    // Pull the master list once for the deletes + recolours below.
    const master: MasterCategory[] = [];
    let mUrl: string | null = '/me/outlook/masterCategories?$top=100';
    while (mUrl) {
      const res: { value?: MasterCategory[]; '@odata.nextLink'?: string } = await client.api(mUrl).get();
      for (const c of res.value ?? []) master.push(c);
      const next = res['@odata.nextLink'];
      mUrl = next ? next.replace('https://graph.microsoft.com/v1.0', '') : null;
    }

    // 2. Delete the orphaned old status master categories.
    const deletedMasters: string[] = [];
    for (const cat of master.filter((c) => OLD_STATUS_TAGS.includes(c.displayName))) {
      await client.api(`/me/outlook/masterCategories/${cat.id}`).delete();
      deletedMasters.push(cat.displayName);
    }

    // 3. Recolour drifted matter-ref categories to blue.
    const matters = await query<{ matter_ref: string }>('select matter_ref from matter where tenant_id = $1', [
      user.tenantId,
    ]);
    const refs = new Set(matters.map((m) => m.matter_ref));
    const recolouredMatters: string[] = [];
    for (const cat of master) {
      if (refs.has(cat.displayName) && cat.color !== MATTER_COLOR) {
        await client.api(`/me/outlook/masterCategories/${cat.id}`).patch({ color: MATTER_COLOR });
        recolouredMatters.push(cat.displayName);
      }
    }

    return ok({ strippedMessages, deletedMasters, recolouredMatters });
  } catch (error) {
    return fail(error);
  }
}
