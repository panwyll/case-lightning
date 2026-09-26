import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { createMatter } from '@/lib/server/matter';
import { query } from '@/lib/server/db';
import { caseCards } from '@/lib/server/mail/case-cards';
import { ok, fail } from '@/lib/server/http';
import { visibleMatterIds } from '@/lib/server/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Search the firm's matters by reference, address, or party name so a user can
// link an email to an existing matter the auto-matcher didn't surface. An empty
// query returns the most recent matters, so the picker is useful before typing.
export async function GET(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const sp = new URL(req.url).searchParams;
    const q = (sp.get('q') ?? '').trim();
    const like = `%${q}%`;
    // status: open (default for pickers that pass it) | closed | all. limit: up to 100.
    const status = z.enum(['open', 'closed', 'all']).catch('all').parse(sp.get('status') ?? 'all');
    const limit = z.coerce.number().int().min(1).max(100).catch(20).parse(sp.get('limit') ?? 20);
    const offset = z.coerce.number().int().min(0).max(100_000).catch(0).parse(sp.get('offset') ?? 0);
    const where = `tenant_id = $1
          and ($2 = ''
               or matter_ref ilike $3
               or property_address ilike $3
               or array_to_string(buyer_names, ' ') ilike $3
               or array_to_string(seller_names, ' ') ilike $3)
          and ($4 = 'all' or ($4 = 'closed') = (status = 'CLOSED'))`;
    const [rows, totalRow] = await Promise.all([
      query<{ id: string; matter_ref: string; property_address: string; status: string }>(
        `select id, matter_ref, property_address, status from matter where ${where} order by created_at desc limit $5 offset $6`,
        [user.tenantId, q, like, status, limit, offset]
      ),
      query<{ n: number }>(`select count(*)::int as n from matter where ${where}`, [user.tenantId, q, like, status]),
    ]);
    const visible = await visibleMatterIds(user);
    const seen = visible ? rows.filter((m) => visible.has(m.id)) : rows;
    const total = visible ? seen.length : (totalRow[0]?.n ?? rows.length);
    // With each, the case as a person recognises it (client, type, stage, handler).
    const cards = await caseCards(user.tenantId, seen.map((m) => m.id)).catch(() => new Map());
    return ok({
      matters: seen.map((m) => ({ id: m.id, matterRef: m.matter_ref, propertyAddress: m.property_address, status: m.status, case: cards.get(m.id) ?? null })),
      total,
    });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const body = z
      .object({
        matterRef: z.string().min(1),
        propertyAddress: z.string().min(1),
        buyerNames: z.array(z.string()).default([]),
        sellerNames: z.array(z.string()).default([]),
        counterpartySolicitor: z.string().optional(),
        counterpartyAgent: z.string().optional(),
        exchangeTargetDate: z.string().optional(),
        completionTargetDate: z.string().optional(),
        lender: z.string().optional(),
        chainPosition: z.string().optional(),
      })
      .parse(await req.json());

    const created = await createMatter(user, body);
    return ok({
      id: created.id,
      folderPath: created.folderPath,
      folderWebUrl: created.folderWebUrl,
    });
  } catch (error) {
    return fail(error);
  }
}
