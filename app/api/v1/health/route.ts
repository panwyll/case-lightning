import { missingFor } from '@/lib/server/config';
import { ok } from '@/lib/server/http';
import { wallEnforced } from '@/lib/server/engine/counterparty';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  // The ethical wall (migration 068) is row-level security; a role with BYPASSRLS or
  // superuser would silently skip it. Report it so ops can see the wall is real.
  const wall = missingFor('db').length === 0 ? await wallEnforced().catch(() => null) : null;
  return ok({
    ok: true,
    wallEnforced: wall,
    features: {
      db: missingFor('db').length === 0,
      auth: missingFor('auth').length === 0,
      graph: missingFor('graph').length === 0,
      ai: missingFor('ai').length === 0,
      billing: missingFor('billing').length === 0,
      leap: missingFor('leap').length === 0,
    },
  });
}
