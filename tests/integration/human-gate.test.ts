/**
 * Addendum 3 §1 / success criterion 2.8 — enforcement, not instruction.
 *
 * Every code path that could write a payment-triggering event (funds_requested,
 * payment_authorised) or an outbound-AI-content event (report_on_title_sent) is tried
 * WITHOUT a human approver, and every attempt must be refused — by the machine where
 * the path goes through it, and by the DATABASE where it does not:
 *
 *   1. the machine, with a system / AI actor;
 *   2. raw SQL straight into matter_event with a null, non-uuid, unknown or
 *      other-tenant approvedBy;
 *   3. raw SQL for report_on_title_sent that cites no / a foreign approval event;
 *   4. raw SQL from the AUTOMATION role with a perfectly valid human approvedBy;
 *   5. the engine service itself running inside an automation context.
 *
 * And the positive control: the same row with a real human approver, from the human
 * pathway, is accepted (rolled back) — so the gate is a gate, not a wall.
 *
 * Runs against a real Postgres as a role WITHOUT bypassrls that is a member of
 * conveyi_automation. Skipped when DATABASE_URL is unset.
 *
 *   DATABASE_URL=postgres://app_rls@127.0.0.1:54329/conveyi \
 *     node --import tsx --test tests/integration/human-gate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const url = process.env.DATABASE_URL;

test('no code path can write a payment or send event without a human approver', { skip: !url ? 'DATABASE_URL not set' : false }, async () => {
  const { query, queryOne, pool, runAsSystem, runAsAutomation, transaction } = await import('../../lib/server/db');
  const { PgEventStore } = await import('../../lib/server/engine/store');
  const { EngineService } = await import('../../lib/server/engine/service');
  const { mockPorts } = await import('../../lib/server/engine/mocks');
  const { PgDocumentRepository } = await import('../../lib/server/engine/adapters');

  const suffix = crypto.randomUUID().slice(0, 8);
  const t = (await queryOne<{ id: string }>(`insert into tenant (name) values ($1) returning id`, [`Gate Firm ${suffix}`]))!.id;
  const t2 = (await queryOne<{ id: string }>(`insert into tenant (name) values ($1) returning id`, [`Other Firm ${suffix}`]))!.id;
  const mk = async (tenant: string, email: string) => (await queryOne<{ id: string }>(`insert into app_user (tenant_id, entra_object_id, email, role, display_name) values ($1,$2,$3,'CONVEYANCER',$4) returning id`, [tenant, `oid-${suffix}-${email}`, `${suffix}-${email}`, email.split('@')[0]]))!.id;
  const HUMAN = await mk(t, 'alice@firm.law');
  const STRANGER = await mk(t2, 'mallory@other.law');
  const M = (await queryOne<{ id: string }>(`insert into matter (tenant_id, matter_ref, property_address, created_by, assigned_to) values ($1,$2,'12 Gate Street',$3,$3) returning id`, [t, `GATE-${suffix}`, HUMAN]))!.id;

  const ports = { ...mockPorts(), documents: new PgDocumentRepository(), now: () => new Date(), newId: () => crypto.randomUUID(), asAutomation: runAsAutomation };
  const svc = new EngineService(new PgEventStore(), ports);
  await runAsSystem(() => svc.run(t, M, { type: 'enrol', actor: HUMAN, requireProofOfFunds: false, hasLender: true, requiredSearches: ['CON29'] }));

  // ── 1. through the machine, as automation actors ──
  for (const actor of ['system', 'ai'] as const) {
    await assert.rejects(runAsSystem(() => svc.run(t, M, { type: 'funds_requested', actor, fromRole: 'client', bankDetailsId: 'bd-none' })), /person|people|automation|stage/i, `funds_requested by ${actor}`);
    await assert.rejects(runAsSystem(() => svc.run(t, M, { type: 'payment_authorised', actor, payeeKind: 'seller_solicitor', bankDetailsId: 'bd-none', purpose: 'completion_monies' })), /person|people|automation|stage/i, `payment_authorised by ${actor}`);
    await assert.rejects(runAsSystem(() => svc.run(t, M, { type: 'record_report_on_title_sent', actor, draftId: 'rot-none', channel: 'email' })), /approved|approval|stage|draft/i, `report_on_title_sent by ${actor}`);
  }

  // ── 2/3/4. straight into the table, bypassing the machine entirely ──
  const nextSeq = async () => Number((await queryOne<{ n: string }>(`select coalesce(max(seq),0)::text as n from matter_event where matter_id = $1`, [M]))!.n) + 1;
  const rawInsert = (type: string, actor: string, payload: Record<string, unknown>) =>
    (async () =>
      query(
        `insert into matter_event (id, tenant_id, matter_id, seq, type, actor, payload, created_at, prev_hash, hash)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,now(),'','')`,
        [crypto.randomUUID(), t, M, await nextSeq(), type, actor, JSON.stringify(payload)]
      ))();
  const isGateError = (e: Error & { code?: string }) => e.code === '23514' && /approvedBy|human user|report_on_title_approved/.test(e.message);
  const isRoleError = (e: Error & { code?: string }) => e.code === '42501';

  const badApprovers: Array<[string, unknown]> = [
    ['null', null],
    ['missing', undefined],
    ['the literal word system', 'system'],
    ['the literal word ai', 'ai'],
    ['a made-up uuid', crypto.randomUUID()],
    ['a user of another firm', STRANGER],
  ];
  for (const [label, approvedBy] of badApprovers) {
    for (const type of ['funds_requested', 'payment_authorised', 'report_on_title_sent']) {
      const payload: Record<string, unknown> = { fromRole: 'client', payeeKind: 'seller_solicitor', bankDetailsId: 'bd-x', purpose: 'completion_monies', draftId: 'rot-x', channel: 'email', approvedEventId: crypto.randomUUID() };
      if (approvedBy !== undefined) payload.approvedBy = approvedBy;
      await assert.rejects(rawInsert(type, 'system', payload), isGateError, `${type} with approvedBy = ${label} must be refused by the database`);
      await assert.rejects(rawInsert(type, HUMAN, payload), isGateError, `${type} with approvedBy = ${label} (human actor column, but no valid approver) must be refused by the database`);
    }
  }
  // report_on_title_sent with a REAL human approver but no matching approval event → refused.
  await assert.rejects(rawInsert('report_on_title_sent', HUMAN, { draftId: 'rot-x', channel: 'email', approvedBy: HUMAN, approvedEventId: null }), isGateError, 'send without an approval event');
  await assert.rejects(rawInsert('report_on_title_sent', HUMAN, { draftId: 'rot-x', channel: 'email', approvedBy: HUMAN, approvedEventId: crypto.randomUUID() }), isGateError, 'send citing a non-existent approval event');
  // …and citing an approval event written by SOMEONE ELSE → refused. (Write a stand-in approval as the stranger's id.)
  const otherApproval = crypto.randomUUID();
  await query(
    `insert into matter_event (id, tenant_id, matter_id, seq, type, actor, payload, created_at, prev_hash, hash) values ($1,$2,$3,$4,'report_on_title_approved',$5,'{"draftId":"rot-x"}'::jsonb,now(),'','')`,
    [otherApproval, t, M, await nextSeq(), STRANGER]
  );
  await assert.rejects(rawInsert('report_on_title_sent', HUMAN, { draftId: 'rot-x', channel: 'email', approvedBy: HUMAN, approvedEventId: otherApproval }), isGateError, 'send citing an approval by a different user');

  // ── 4. the automation role, even with a perfectly valid human approver ──
  const isMember = (await queryOne<{ ok: boolean }>(`select pg_has_role(current_user, 'conveyi_automation', 'member') as ok`))!.ok;
  assert.equal(isMember, true, 'the app role can step down into conveyi_automation');
  await assert.rejects(
    runAsAutomation(() => rawInsert('funds_requested', HUMAN, { fromRole: 'client', bankDetailsId: 'bd-x', approvedBy: HUMAN })),
    isRoleError,
    'automation role: funds_requested refused by the restrictive policy even with a valid approver'
  );
  await assert.rejects(
    runAsAutomation(() => rawInsert('payment_authorised', HUMAN, { payeeKind: 'seller_solicitor', bankDetailsId: 'bd-x', purpose: 'completion_monies', approvedBy: HUMAN })),
    isRoleError,
    'automation role: payment_authorised refused'
  );
  // Non-gated events are still fine from automation (the role is least-privilege, not read-only).
  await runAsAutomation(() => rawInsert('client_update_sent', 'system', { template: 'x', channel: 'mock', messageId: null, triggeredByEventId: null }));

  // ── 5. the engine's own write path (store.withMatterLock → append, hash-chained) inside an
  //       automation context, with a valid human approver: the database still refuses ──
  const store = new PgEventStore();
  for (const [type, payload] of [
    ['funds_requested', { fromRole: 'client', bankDetailsId: 'bd-x', approvedBy: HUMAN }],
    ['payment_authorised', { payeeKind: 'seller_solicitor', bankDetailsId: 'bd-x', purpose: 'completion_monies', approvedBy: HUMAN }],
  ] as const) {
    await assert.rejects(
      runAsAutomation(() =>
        store.withMatterLock(t, M, async (tx) => {
          const log = await tx.load();
          return tx.append([{ type, actor: HUMAN, payload } as never], log.length ? log[log.length - 1].seq : 0, new Date(), () => crypto.randomUUID());
        })
      ),
      isRoleError,
      `store append of ${type} from the automation context is refused by the database`
    );
  }
  // The same append from the human pathway (no automation context) passes the role policy and reaches
  // the gate, which accepts a valid approver — proven under the positive control below.

  // ── positive control: the human pathway with a real approver is accepted (and rolled back) ──
  const ownApproval = crypto.randomUUID();
  await assert.rejects(
    transaction(async (c) => {
      const seq = await nextSeq();
      await c.query(`insert into matter_event (id, tenant_id, matter_id, seq, type, actor, payload, created_at, prev_hash, hash) values ($1,$2,$3,$4,'report_on_title_approved',$5,'{"draftId":"rot-x"}'::jsonb,now(),'','')`, [ownApproval, t, M, seq, HUMAN]);
      await c.query(`insert into matter_event (id, tenant_id, matter_id, seq, type, actor, payload, created_at, prev_hash, hash) values ($1,$2,$3,$4,'report_on_title_sent',$5,$6::jsonb,now(),'','')`, [crypto.randomUUID(), t, M, seq + 1, HUMAN, JSON.stringify({ draftId: 'rot-x', channel: 'email', approvedBy: HUMAN, approvedEventId: ownApproval })]);
      await c.query(`insert into matter_event (id, tenant_id, matter_id, seq, type, actor, payload, created_at, prev_hash, hash) values ($1,$2,$3,$4,'funds_requested',$5,$6::jsonb,now(),'','')`, [crypto.randomUUID(), t, M, seq + 2, HUMAN, JSON.stringify({ fromRole: 'client', bankDetailsId: 'bd-x', approvedBy: HUMAN })]);
      throw new Error('ROLLBACK_OK');
    }),
    /ROLLBACK_OK/,
    'a human-approved row is accepted by the gate (transaction rolled back on purpose)'
  );

  // Nothing gated ever landed.
  const landed = await query<{ type: string }>(`select type from matter_event where matter_id = $1 and type in ('funds_requested','payment_authorised','report_on_title_sent')`, [M]);
  assert.deepEqual(landed, []);
  await pool().end();
});
