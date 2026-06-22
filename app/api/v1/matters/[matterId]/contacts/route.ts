import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ matterId: string }> };

const ROLES = ['CLIENT', 'OTHER_SIDE', 'AGENT', 'LENDER', 'OUR_FIRM', 'OTHER', 'UNKNOWN'] as const;

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    await assertMatterAccess(user, matterId);
    const contacts = await query<Record<string, unknown>>(
      `select id, email, name, role, source, last_seen_at
       from matter_contact where matter_id = $1 and tenant_id = $2
       order by role <> 'UNKNOWN' desc, last_seen_at desc`,
      [matterId, user.tenantId]
    );
    return ok({ contacts });
  } catch (error) {
    return fail(error);
  }
}

// Add a contact manually or update an existing one's role/name. Idempotent on
// (matter, email) — set the role/name on whatever address you pass.
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const body = z
      .object({
        email: z.string().email(),
        name: z.string().optional(),
        role: z.enum(ROLES).optional(),
      })
      .parse(await req.json());
    await assertMatterAccess(user, matterId);

    const email = body.email.trim().toLowerCase();
    const row = await query<{ id: string }>(
      `insert into matter_contact (tenant_id, matter_id, email, name, role, source, last_seen_at)
       values ($1, $2, $3, $4, $5, 'MANUAL', now())
       on conflict (matter_id, email) do update
         set name = coalesce($4, matter_contact.name),
             role = coalesce($5, matter_contact.role)
       returning id`,
      [user.tenantId, matterId, email, body.name ?? null, body.role ?? null]
    );
    return ok({ id: row[0]?.id });
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId } = z.object({ matterId: z.string().uuid() }).parse(await params);
    const id = z.string().uuid().parse(new URL(req.url).searchParams.get('id'));
    await assertMatterAccess(user, matterId);
    await query(`delete from matter_contact where id = $1 and matter_id = $2 and tenant_id = $3`, [
      id,
      matterId,
      user.tenantId,
    ]);
    return ok({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
