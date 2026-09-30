import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/server/http';
import { devPofConnections, isDevPof } from '@/lib/server/dev-pof';
import { runAsSystem } from '@/lib/server/db';
import { openRequestByToken } from '@/lib/server/engine/pof-store';
import { connectionsFor } from '@/lib/server/open-banking/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The banks connected from this form: which source each is for, and the accounts it brought (as attachable files). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    if (isDevPof(token)) return ok(devPofConnections());
    const rows = await runAsSystem(async () => {
      const pof = await openRequestByToken(token);
      if (!pof || pof.status !== 'requested') throw Object.assign(new Error('This link is not valid or has already been used.'), { status: 404 });
      return connectionsFor(pof.id);
    });
    return ok({ connections: rows.map((r) => ({ id: r.id, sourceIndex: r.source_index, party: r.party, status: r.status, bank: r.institution_name, error: r.error, files: r.files })) });
  } catch (error) {
    return fail(error);
  }
}
