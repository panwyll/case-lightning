import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { query } from '@/lib/server/db';
import { ok, fail } from '@/lib/server/http';
import { loadCrossChecks } from '@/lib/server/engine/crosscheck-run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Every document on the case, newest first — what a completion sheet picks from. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ matterId: string }> }) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const documents = await query<{ id: string; file_name: string | null; doc_type: string | null; web_url: string | null; created_at: string; checked: boolean; locked: boolean; head: string | null }>(
      `select id, file_name, doc_type, web_url, created_at, (draft_check is not null) as checked, coalesce((extracted_facts->>'locked')::boolean, false) as locked, case when doc_type = 'EMAIL' then substring(extracted_facts->>'content' from 1 for 600) end as head from document where tenant_id = $1 and matter_id = $2 and superseded_at is null order by created_at desc limit 300`,
      [user.tenantId, matterId]
    );
    const ids = documents.map((d) => d.id);
    const [pages, facts] = ids.length ? await Promise.all([
      query<{ document_id: string; pages: string; read: string; with_facts: string; unreadable: string; unattested: string }>(`select document_id, count(*)::text as pages, count(*) filter (where verdict <> 'unattested')::text as read, count(*) filter (where verdict = 'facts')::text as with_facts, count(*) filter (where verdict = 'unreadable')::text as unreadable, count(*) filter (where verdict = 'unattested')::text as unattested from document_page where tenant_id = $1 and document_id = any($2::uuid[]) group by document_id`, [user.tenantId, ids]).catch(() => []),
      query<{ document_id: string; facts: string; verified: string }>(`select document_id, count(*)::text as facts, count(*) filter (where verified)::text as verified from document_fact where tenant_id = $1 and document_id = any($2::uuid[]) group by document_id`, [user.tenantId, ids]).catch(() => []),
    ]) : [[], []];
    const pg = new Map(pages.map((p) => [p.document_id, p]));
    const fc = new Map(facts.map((f) => [f.document_id, f]));
    const crosschecks = await loadCrossChecks(user.tenantId, matterId);
    const messages = await query<{ id: string; created_at: string; direction: string; channel: string; address: string | null; template: string | null; subject: string | null; status: string | null; provider_ref: string | null }>(
      `select id, created_at, direction, channel, address, template, subject, status, provider_ref from client_message where tenant_id = $1 and matter_id = $2 order by created_at desc limit 50`,
      [user.tenantId, matterId]
    ).catch(() => []);
    return ok({ messages: messages.map((m) => ({ id: m.id, at: m.created_at, direction: m.direction, channel: m.channel, address: m.address, template: m.template, subject: m.subject, status: m.status, providerRef: m.provider_ref })), crosschecks, documents: documents.map((d) => {
      const p = pg.get(d.id); const f = fc.get(d.id);
      const review = p ? { pages: Number(p.pages), read: Number(p.read), withFacts: Number(p.with_facts), unreadable: Number(p.unreadable), unattested: Number(p.unattested), complete: Number(p.unattested) === 0, facts: Number(f?.facts ?? 0), verified: Number(f?.verified ?? 0) } : null;
      // An email reads as who sent it and its subject, not its file name.
      const line = (k: string) => d.head?.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
      const from = line('From')?.replace(/\s*<[^>]+>/, '') ?? null;
      return { id: d.id, fileName: d.file_name, docType: d.doc_type, webUrl: d.web_url, createdAt: d.created_at, review, checked: d.checked, locked: d.locked, emailFrom: from, emailFromAddress: line('From')?.match(/<([^>]+)>/)?.[1] ?? line('From'), emailSubject: line('Subject') };
    }) });
  } catch (error) {
    return fail(error);
  }
}
