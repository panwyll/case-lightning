import { NextRequest, after } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { findFacts } from '@/lib/server/engine/file-index';
import { askFile } from '@/lib/server/engine/file-ask';
import { catchUpFileIndex, ocrCatchUp } from '@/lib/server/engine/file-backfill';
import { documentBytesLoader, PgDocumentFactsWriter, PgDocumentRepository } from '@/lib/server/engine/adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Room for the OCR catch-up that runs after the response.
export const maxDuration = 60;

/** Ask the file: `q` is answered from the facts and passages (document, page) it finds, every sentence cited (file-ask.ts); `key` lists the register by key prefix. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const q = z.object({ q: z.string().max(400).optional(), key: z.string().max(120).optional() }).parse({ q: req.nextUrl.searchParams.get('q') ?? undefined, key: req.nextUrl.searchParams.get('key') ?? undefined });
    if (q.key && !q.q) return ok({ facts: await findFacts(user.tenantId, matterId, { key: q.key, limit: 100 }), passages: [] });
    if (!q.q?.trim()) return ok({ facts: [], passages: [] });
    // Documents filed before the index covered them are caught up first (bounded; the rest on the next question).
    const repo = new PgDocumentRepository();
    const writer = new PgDocumentFactsWriter();
    const deps = { get: (id: string) => repo.get(user.tenantId, id), load: (doc: Parameters<ReturnType<typeof documentBytesLoader>['load']>[0]) => documentBytesLoader().load(doc), writeReview: writer.writeReview.bind(writer) };
    await catchUpFileIndex(user.tenantId, matterId, deps).catch(() => null);
    // Scanned pages a long document's OCR did not reach are read after the answer goes back, not before.
    after(async () => { await ocrCatchUp(user.tenantId, matterId, deps, 40_000).catch(() => null); });
    return ok(await askFile(user.tenantId, matterId, q.q.trim(), { userId: user.userId }));
  } catch (error) {
    return fail(error);
  }
}
