/**
 * Matter reconciliation — the cross-document "is my file right?" grid.
 *
 * Conveyancing is a reconciliation job: the contract, title, searches, mortgage
 * offer and SDLT must agree, and nothing material may be missing. This assembles
 * the matter's already-reviewed documents (reusing the cached reviews — joined to
 * each document by its content hash, so there's no re-reading) and asks the model
 * to build a fact-by-fact table flagging every mismatch and gap. One synthesis call.
 */
import { query, queryOne } from './db';
import { reconcileMatterDocuments, type ReconRow } from './ai';
import type { SessionUser } from './types';

export interface Reconciliation {
  rows: ReconRow[];
  issues: string[];
  documents: string[]; // documents that carried readable content (went into the grid)
  skipped: string[]; // documents on the matter we haven't read (no content to reconcile)
}

export async function buildMatterReconciliation(user: SessionUser, matterId: string): Promise<Reconciliation> {
  const summary = await queryOne<{ facts: Record<string, unknown> }>(
    `select facts from matter_summary where matter_id = $1 and tenant_id = $2`,
    [matterId, user.tenantId]
  );
  const matterFacts = summary?.facts ?? {};

  // Reuse the cached document reviews — join each document to its review by content
  // hash (document.hash_sha256 ↔ doc_review_cache.content_hash).
  const docs = await query<{ file_name: string; review: any }>(
    `select d.file_name, c.review
       from document d
       left join doc_review_cache c
         on c.tenant_id = d.tenant_id and c.matter_id = d.matter_id and c.content_hash = d.hash_sha256
      where d.tenant_id = $1 and d.matter_id = $2
      order by d.created_at`,
    [user.tenantId, matterId]
  );

  const documents = docs
    .filter((d) => d.review && (d.review.summary || (d.review.keyDetails?.length ?? 0)))
    .map((d) => ({
      name: d.file_name,
      summary: String(d.review?.summary ?? ''),
      keyDetails: Array.isArray(d.review?.keyDetails) ? (d.review.keyDetails as Array<{ label: string; value: string }>) : [],
    }));
  const skipped = docs.filter((d) => !documents.some((x) => x.name === d.file_name)).map((d) => d.file_name);

  if (!documents.length) {
    return { rows: [], issues: [], documents: [], skipped };
  }

  const { rows, issues } = await reconcileMatterDocuments({
    userId: user.userId,
    tenantId: user.tenantId,
    matterId,
    matterFacts,
    documents,
  });
  return { rows, issues, documents: documents.map((d) => d.name), skipped };
}
