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
        // The New Case form: who we act for (with a way to reach them), the other side, the agent, the property and the price.
        track: z.enum(['PURCHASE', 'SALE', 'REMORTGAGE']).optional(),
        addressParts: z.record(z.string()).optional(),
        purchasePricePennies: z.number().int().nonnegative().optional(),
        parties: z.array(z.object({ name: z.string().trim().min(1), email: z.string().trim().email(), phone: z.string().trim().optional() })).optional(),
        otherParties: z.array(z.string().trim().min(1)).optional(),
        otherSide: z.object({ firm: z.string().trim().min(1), contactName: z.string().trim().optional(), email: z.string().trim().email() }).nullable().optional(),
        agent: z.object({ name: z.string().trim().min(1), email: z.string().trim().email().optional() }).nullable().optional(),
        lenderContact: z.object({ name: z.string().trim().min(1), email: z.string().trim().email().optional() }).nullable().optional(),
      })
      .parse(await req.json());

    // Our clients are the buyers on a purchase and the sellers on a sale; the other side's clients are the rest.
    const ours = (body.parties ?? []).map((x) => x.name);
    const theirs = body.otherParties ?? [];
    const buyerNames = body.track === 'SALE' ? theirs : ours.length ? ours : body.buyerNames;
    const sellerNames = body.track === 'SALE' ? ours : theirs.length ? theirs : body.sellerNames;
    const created = await createMatter(user, {
      ...body,
      buyerNames,
      sellerNames,
      counterpartySolicitor: body.otherSide ? [body.otherSide.contactName, body.otherSide.firm].filter(Boolean).join(', ') : body.counterpartySolicitor,
      counterpartyAgent: body.agent?.name ?? body.counterpartyAgent,
      lender: body.lenderContact?.name ?? body.lender,
    });
    // Track, structured address and price sit on the row; every person is a contact with a role, so the case can reach them from day one.
    await query(
      `update matter set track = coalesce($3, track), address_parts = coalesce($4::jsonb, address_parts), purchase_price = coalesce($5, purchase_price) where id = $1 and tenant_id = $2`,
      [created.id, user.tenantId, body.track ?? null, body.addressParts ? JSON.stringify(body.addressParts) : null, body.purchasePricePennies != null ? String(body.purchasePricePennies / 100) : null]
    ).catch(() => {});
    const contacts: Array<{ email: string; name: string | null; role: string; phone: string | null }> = [
      ...(body.parties ?? []).map((x) => ({ email: x.email, name: x.name, role: 'CLIENT', phone: x.phone || null })),
      ...(body.otherSide ? [{ email: body.otherSide.email, name: [body.otherSide.contactName, body.otherSide.firm].filter(Boolean).join(', '), role: 'OTHER_SIDE', phone: null }] : []),
      ...(body.agent?.email ? [{ email: body.agent.email, name: body.agent.name, role: 'AGENT', phone: null }] : []),
      ...(body.lenderContact?.email ? [{ email: body.lenderContact.email, name: body.lenderContact.name, role: 'LENDER', phone: null }] : []),
    ];
    for (const c of contacts) {
      await query(
        `insert into matter_contact (tenant_id, matter_id, email, name, role, phone, source, last_seen_at) values ($1, $2, $3, $4, $5, $6, 'NEW_CASE', now())
         on conflict (matter_id, email) do update set name = excluded.name, role = excluded.role, phone = coalesce(excluded.phone, matter_contact.phone), last_seen_at = now()`,
        [user.tenantId, created.id, c.email.toLowerCase(), c.name, c.role, c.phone]
      ).catch(() => {});
    }
    return ok({
      id: created.id,
      folderPath: created.folderPath,
      folderWebUrl: created.folderWebUrl,
    });
  } catch (error) {
    return fail(error);
  }
}
