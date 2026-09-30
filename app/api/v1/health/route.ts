import { missingFor } from '@/lib/server/config';
import { ok } from '@/lib/server/http';
import { wallEnforced } from '@/lib/server/engine/counterparty';
import { productionPorts } from '@/lib/server/engine/adapters';
import { project } from '@/lib/server/engine/projection';
import { matterWork } from '@/lib/server/engine/work';
import { caseHealth } from '@/lib/server/engine/health';

/**
 * The engine as the production bundle builds it: its ports constructed and a case's task list
 * worked out, with no database. A module that fails only once bundled (an import cycle, a missing
 * export) fails here, not on the Tasks list. `npm run smoke` checks it after a build; call it after a deploy.
 */
function engineCheck(): string {
  try {
    productionPorts();
    const s = project('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000001', []);
    matterWork(s, new Date(), { matterRef: 'SMOKE', propertyAddress: null, assignedTo: null });
    caseHealth(s, new Date());
    return 'ok';
  } catch (e) {
    return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  // The ethical wall (migration 068) is row-level security; a role with BYPASSRLS or
  // superuser would silently skip it. Report it so ops can see the wall is real.
  const wall = missingFor('db').length === 0 ? await wallEnforced().catch(() => null) : null;
  const engine = engineCheck();
  return ok({
    ok: engine === 'ok',
    engine,
    wallEnforced: wall,
    features: {
      db: missingFor('db').length === 0,
      auth: missingFor('auth').length === 0,
      graph: missingFor('graph').length === 0,
      ai: missingFor('ai').length === 0,
      billing: missingFor('billing').length === 0,
      leap: missingFor('leap').length === 0,
    },
  }, { status: engine === 'ok' ? 200 : 503 });
}
