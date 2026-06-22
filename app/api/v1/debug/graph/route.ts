import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { ensureAccessToken, graphClientForUser } from '@/lib/server/graph';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Best-effort decode of the `scp` claim. Work/school tokens are JWTs; personal
// (MSA) tokens can be opaque/encrypted and won't decode — in that case the live
// masterCategories call below is the real test of whether the scope works.
function decodeScopes(token: string): string[] | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { scp?: string };
    return claims.scp ? claims.scp.split(' ') : null;
  } catch {
    return null;
  }
}

/**
 * Diagnostic: shows what the signed-in user's live Graph token can actually do
 * with Outlook categories. Tells us (a) whether MailboxSettings.ReadWrite is in
 * the token, and (b) what colour Microsoft has each master category set to —
 * which is the source of truth behind the grey-vs-coloured tags in the inbox.
 */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const token = await ensureAccessToken(user.userId);
    const scopes = decodeScopes(token);

    let masterCategories: Array<{ displayName: string; color: string }> | null = null;
    let masterCategoriesError: string | null = null;
    try {
      const client = await graphClientForUser(user.userId);
      const res = await client.api('/me/outlook/masterCategories').get();
      masterCategories = (res.value ?? []).map((c: { displayName: string; color: string }) => ({
        displayName: c.displayName,
        color: c.color,
      }));
    } catch (e) {
      masterCategoriesError = e instanceof Error ? e.message : String(e);
    }

    return ok({
      scopesFromToken: scopes, // null if the token is opaque (personal accounts)
      hasMailboxSettingsScope: scopes ? scopes.includes('MailboxSettings.ReadWrite') : 'unknown (opaque token)',
      masterCategories,
      masterCategoriesError,
    });
  } catch (error) {
    return fail(error);
  }
}
