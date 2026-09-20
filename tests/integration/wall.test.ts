/**
 * Integration test for the ethical wall between internally-linked matters (migration
 * 068) — runs against a REAL Postgres, as a role WITHOUT bypassrls, because the point is
 * that the database itself refuses the read. Skipped when DATABASE_URL is unset.
 *
 *   DATABASE_URL=postgres://app_rls@127.0.0.1:54329/engine_test \
 *     node --import tsx --test tests/integration/wall.test.ts
 *
 * Expects migrations through 068 applied (and, for the notes column, 036).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const url = process.env.DATABASE_URL;

test('ethical wall + handler-conflict rules hold at the database layer', { skip: !url ? 'DATABASE_URL not set' : false }, async () => {
  const { query, queryOne, pool, runAsUser, runAsSystem } = await import('../../lib/server/db');
  const { setCounterparty, resolveCounterparty, assertCanAssign, wallEnforced, ConflictOfInterestError } = await import('../../lib/server/engine/counterparty');
  const { PgEventStore } = await import('../../lib/server/engine/store');
  const { EngineService } = await import('../../lib/server/engine/service');
  const { mockPorts } = await import('../../lib/server/engine/mocks');
  const { PgDocumentRepository } = await import('../../lib/server/engine/adapters');

  assert.equal(await wallEnforced(), true, 'role can be walled and the policy exists');
  const suffix = crypto.randomUUID().slice(0, 8);
  const t = (await queryOne<{ id: string }>(`insert into tenant (name) values ($1) returning id`, [`Wall Firm ${suffix}`]))!.id;
  const mk = async (email: string) => (await queryOne<{ id: string }>(`insert into app_user (tenant_id, entra_object_id, email, role, display_name) values ($1,$2,$3,'CONVEYANCER',$4) returning id`, [t, `oid-${suffix}-${email}`, `${suffix}-${email}`, email.split('@')[0]]))!.id;
  const A = await mk('alice@firm.law');
  const B = await mk('bob@firm.law');
  const C = await mk('carol@firm.law');
  const mkMatter = async (ref: string, handler: string) => (await queryOne<{ id: string }>(`insert into matter (tenant_id, matter_ref, property_address, created_by, assigned_to, notes) values ($1,$2,'9 Chain Road',$3,$3,'CONFIDENTIAL instructions for '||$2) returning id`, [t, `${ref}-${suffix}`, handler]))!.id;
  const MA = await mkMatter('BUY-1', A);
  const MB = await mkMatter('SELL-1', B);
  const MX = await mkMatter('OTHER-1', C);

  // Requirement 5: same handler both sides → refused by the app and by the DB trigger.
  const MA2 = await mkMatter('BUY-2', A);
  await assert.rejects(setCounterparty(t, MA, { kind: 'internal', matterId: MA2 }, A), ConflictOfInterestError);
  await assert.rejects(query(`insert into matter_link (tenant_id, matter_a, matter_b) values ($1,$2,$3)`, [t, ...[MA, MA2].sort()]), /conflict of interest/);

  // Different handlers → linked; the resolver returns contact details only.
  await setCounterparty(t, MA, { kind: 'internal', matterId: MB }, A, 'CHAIN-42');
  const cp = await resolveCounterparty(t, MA);
  assert.deepEqual(cp, { type: 'internal', name: 'bob', email: `${suffix}-bob@firm.law`, firm: `Wall Firm ${suffix}`, matterId: MB });
  assert.equal((await resolveCounterparty(t, MB))?.matterId, MA);

  // Reassigning the seller's matter to Alice → refused (app + trigger).
  await assert.rejects(assertCanAssign(t, MB, A), ConflictOfInterestError);
  await assert.rejects(query(`update matter set assigned_to = $1 where id = $2`, [A, MB]), /conflict of interest/);

  // Give Bob's matter confidential rows in each walled table (RLS `using` runs per row, so an
  // empty table can't demonstrate the wall): enrol it in the engine as the system, add a
  // document and a summary.
  const ports = { ...mockPorts(), documents: new PgDocumentRepository(), now: () => new Date(), newId: () => crypto.randomUUID() };
  const delivered: string[] = [];
  ports.linked = { name: 'test', enquiryRaised: async (i) => { delivered.push(i.enquiryId); } };
  const svc = new EngineService(new PgEventStore(), ports);
  await runAsSystem(async () => {
    await svc.run(t, MB, { type: 'enrol', actor: B, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'], counterpartyType: 'internal' });
    await query(`insert into document (tenant_id, matter_id, source_type, storage_path, file_name) values ($1,$2,'UPLOAD','x','seller-instructions.pdf')`, [t, MB]);
    await query(`insert into matter_summary (matter_id, tenant_id, facts) values ($1,$2,'{"secret":"seller will accept less"}'::jsonb)`, [MB, t]);
  });
  const bobEventsBefore = (await query(`select 1 from matter_event where matter_id = $1`, [MB])).length;
  assert.ok(bobEventsBefore > 0);

  // Requirement 2: Alice cannot read Bob's matter — a DB error (42501), not an empty result.
  await runAsUser(A, async () => {
    assert.match((await queryOne<{ notes: string }>(`select notes from matter where id = $1`, [MA]))!.notes, /BUY-1/);
    // Targeted access: the explicit check raises (this is what assertMatterAccess calls).
    await assert.rejects(query(`select engine_wall_check($1)`, [MB]), (e: Error & { code?: string }) => e.code === '42501' && /ethical wall/.test(e.message));
    // Row-level: the other side's rows are simply not there for Alice — reads are empty, writes fail.
    assert.equal((await query(`select notes from matter where id = $1`, [MB])).length, 0);
    assert.equal((await query(`select * from matter_event where matter_id = $1`, [MB])).length, 0);
    assert.equal((await query(`select * from matter_summary where matter_id = $1`, [MB])).length, 0);
    assert.equal((await query(`select * from document where matter_id = $1`, [MB])).length, 0);
    await assert.rejects(query(`insert into matter_task (tenant_id, matter_id, ref, detail) values ($1,$2,'T-0001','sneaky')`, [t, MB]), /row-level security/);
    // A tenant-wide list works and silently excludes Bob's matter.
    const all = await query<{ id: string }>(`select id from matter where tenant_id = $1`, [t]);
    assert.ok(all.some((r) => r.id === MA) && all.some((r) => r.id === MX) && !all.some((r) => r.id === MB));
    assert.ok(await queryOne(`select id from matter where id = $1`, [MX]));
  });
  await runAsUser(B, async () => {
    await assert.rejects(query(`select engine_wall_check($1)`, [MA]), /ethical wall/);
    assert.equal((await query(`select notes from matter where id = $1`, [MA])).length, 0);
    assert.ok(await queryOne(`select id from matter where id = $1`, [MB]));
  });
  await runAsUser(C, async () => assert.equal((await query(`select id from matter where id = any($1::uuid[])`, [[MA, MB]])).length, 2));
  assert.equal((await runAsSystem(() => query(`select id from matter where id = any($1::uuid[])`, [[MA, MB]]))).length, 2);

  // Requirements 3 + 4 through the real store: the enquiry is stamped internal, delivered via
  // the port, and leaves no engine state on Bob's matter.
  await svc.run(t, MA, { type: 'enrol', actor: A, requireProofOfFunds: false, requireExchangeAuthority: false, hasLender: false, requiredSearches: ['CON29'], counterpartyType: 'internal' });
  await svc.requestIdCheck(t, MA, A);
  const idDoc = (await queryOne<{ id: string }>(`insert into document (tenant_id, matter_id, source_type, storage_path, file_name, extracted_facts, extraction_confidence) values ($1,$2,'UPLOAD','x','id.pdf',$3::jsonb,0.99) returning id`, [t, MA, JSON.stringify({ provider: 'p', outcome: 'clear', flags: [], confidence: 0.99 })]))!.id;
  await svc.idCheckResultReceived(t, MA, idDoc);
  await svc.run(t, MA, { type: 'raise_enquiry', actor: A, enquiryId: 'E1', subject: 'Boundary' });
  assert.deepEqual(delivered, ['E1']);
  assert.equal((await query<{ n: string }>(`select count(*)::text as n from matter_event where matter_id = $1 and payload->>'counterpartyType' = 'internal'`, [MA]))[0].n, '2');
  assert.equal((await query(`select 1 from matter_event where matter_id = $1`, [MB])).length, bobEventsBefore, "Bob's log is untouched by Alice's enquiry");
  await runAsUser(B, async () => assert.equal((await query(`select 1 from matter_event where matter_id = $1`, [MA])).length, 0));
  await pool().end();
});
