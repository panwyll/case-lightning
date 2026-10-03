import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';
import { findFacts } from '@/lib/server/engine/file-index';
import { askFile } from '@/lib/server/engine/file-ask';
import { catchUpFileIndex } from '@/lib/server/engine/file-backfill';
import { documentBytesLoader, PgDocumentFactsWriter, PgDocumentRepository } from '@/lib/server/engine/adapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    await catchUpFileIndex(user.tenantId, matterId, { get: (id) => repo.get(user.tenantId, id), load: (doc) => documentBytesLoader().load(doc), writeReview: (doc, review, extractor, texts) => writer.writeReview(doc, review, extractor, texts) }).catch(() => null);
    return ok(await askFile(user.tenantId, matterId, q.q.trim(), { userId: user.userId }));
  } catch (error) {
    return fail(error);
  }
}
