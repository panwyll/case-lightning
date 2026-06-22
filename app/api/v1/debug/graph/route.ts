import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { graphClientForUser } from '@/lib/server/graph';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Diagnostic: dumps the full Outlook master category list (every page) with each
 * category's colour, so we can see exactly which tags are colourless server-side
 * and whether the list is large enough to be paginated.
 */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const client = await graphClientForUser(user.userId);

    const categories: Array<{ displayName: string; color: string | null }> = [];
    let url: string | null = '/me/outlook/masterCategories?$top=100';
    let pages = 0;
    while (url) {
      const res: { value?: Array<{ displayName: string; color: string | null }>; '@odata.nextLink'?: string } =
        await client.api(url).get();
      for (const c of res.value ?? []) categories.push({ displayName: c.displayName, color: c.color });
      pages += 1;
      const next = res['@odata.nextLink'];
      url = next ? next.replace('https://graph.microsoft.com/v1.0', '') : null;
    }

    return ok({
      count: categories.length,
      pages,
      colourless: categories.filter((c) => !c.color || c.color === 'none').map((c) => c.displayName),
      categories,
    });
  } catch (error) {
    return fail(error);
  }
}
