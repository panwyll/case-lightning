import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole, requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { query, queryOne } from '@/lib/server/db';
import { engine } from '@/lib/server/engine/adapters';
import { rulebook } from '@/lib/server/engine/rulebook';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SignoffRow = { version: string; rule_hashes: Record<string, string>; signed_at: string; note: string | null; name: string | null };

async function current(tenantId: string) {
  const levels = await engine().eventStore.loadLevels(tenantId).catch(() => null);
  const book = rulebook(levels);
  const last = await queryOne<SignoffRow>(
    `select s.version, s.rule_hashes, s.signed_at::text, s.note, coalesce(u.display_name, u.email) as name
       from rulebook_signoff s left join app_user u on u.id = s.signed_by where s.tenant_id = $1 order by s.signed_at desc limit 1`,
    [tenantId]
  ).catch(() => null);
  // Each rule against the last sign-off: signed as it reads now, changed since, or new since.
  const rules = book.rules.map((r) => ({ ...r, status: !last ? 'unsigned' : !last.rule_hashes[r.id] ? 'new' : last.rule_hashes[r.id] === r.hash ? 'signed' : 'changed' }));
  return { version: book.version, rules, signoff: last ? { version: last.version, at: last.signed_at, by: last.name, note: last.note, current: last.version === book.version } : null };
}

/** The firm's rulebook, and where its sign-off stands. Everyone may read it; an admin signs it. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    return ok(await current(user.tenantId));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN']);
    const { note } = z.object({ note: z.string().max(1000).nullish() }).parse(await req.json().catch(() => ({})));
    const levels = await engine().eventStore.loadLevels(user.tenantId).catch(() => null);
    const book = rulebook(levels);
    await query(`insert into rulebook_signoff (tenant_id, version, rule_hashes, signed_by, note) values ($1, $2, $3, $4, $5)`, [user.tenantId, book.version, JSON.stringify(Object.fromEntries(book.rules.map((r) => [r.id, r.hash]))), user.userId, note?.trim() || null])
      .catch((e) => { throw Object.assign(new Error(`Could not record the sign-off (has migration 106 been run?): ${(e as Error).message}`), { status: 500 }); });
    await writeAudit({ tenantId: user.tenantId, matterId: null, actorUserId: user.userId, actionType: 'RULEBOOK_SIGNED_OFF', actionStatus: 'SUCCESS', payload: { version: book.version, rules: book.rules.length } }).catch(() => {});
    return ok(await current(user.tenantId));
  } catch (error) {
    return fail(error);
  }
}
