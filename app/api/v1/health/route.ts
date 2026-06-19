import { missingFor } from '@/lib/server/config';
import { ok } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return ok({
    ok: true,
    features: {
      db: missingFor('db').length === 0,
      auth: missingFor('auth').length === 0,
      graph: missingFor('graph').length === 0,
      ai: missingFor('ai').length === 0,
      billing: missingFor('billing').length === 0,
    },
  });
}
