/**
 * Migration 079 — critical changes are a person's, and the database is what says so.
 *
 * Every critical change is attempted from the AUTOMATION role (what the engine's timers,
 * webhooks, syncs and AI-driven effects run as) and, where it applies, from the person
 * pathway with a non-person actor. Each must be refused by the database itself. Positive
 * controls show the same changes made the right way go through — a gate, not a wall.
 *
 *   DATABASE_URL=postgres://app_rls@127.0.0.1:54329/conveyi \
 *     node --import tsx --test tests/integration/critical-changes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const url = process.env.DATABASE_URL;

test('the automation can never verify bank details, exchange, complete, decide for a client, or rewrite contact details', { skip: !url ? 'DATABASE_URL not set' : false }, async () => {
  const { query, queryOne, pool, runAsAutomation, transaction } = await import('../../lib/server/db');

  const suffix = crypto.randomUUID().slice(0, 8);
  const t = (await queryOne<{ id: string }>(`insert into tenant (name) values ($1) returning id`, [`Critical Firm ${suffix}`]))!.id;
  const HUMAN = (await queryOne<{ id: string }>(`insert into app_user (tenant_id, entra_object_id, email, role, display_name) values ($1,$2,$3,'CONVEYANCER','Alice') returning id`, [t, `oid-${suffix}`, `${suffix}-alice@firm.law`]))!.id;
  const M = (await queryOne<{ id: string }>(`insert into matter (tenant_id, matter_ref, property_address, created_by, assigned_to) values ($1,$2,'9 Arthur Road',$3,$3) returning id`, [t, `CRIT-${suffix}`, HUMAN]))!.id;

  const nextSeq = async () => Number((await queryOne<{ n: string }>(`select coalesce(max(seq),0)::text as n from matter_event where matter_id = $1`, [M]))!.n) + 1;
  const event = (type: string, actor: string, payload: Record<string, unknown> = {}) =>
    (async () => {
      const id = crypto.randomUUID();
      await query(
        `insert into matter_event (id, tenant_id, matter_id, seq, type, actor, payload, created_at, prev_hash, hash) values ($1,$2,$3,$4,$5,$6,$7::jsonb,now(),'','')`,
        [id, t, M, await nextSeq(), type, actor, JSON.stringify(payload)]
      );
      return id;
    })();
  const refused = (e: Error & { code?: string }) => e.code === '42501' && /migration 079/.test(e.message);

  // ── 1. human-only events ──
  for (const type of ['bank_details_verified', 'bank_details_verification_failed', 'contracts_exchanged', 'completion_confirmed', 'client_decision_recorded']) {
    await assert.rejects(event(type, 'system'), refused, `${type} by "system" is refused on the person pathway`);
    await assert.rejects(event(type, 'ai'), refused, `${type} by "ai" is refused`);
  }
  for (const type of ['bank_details_verified', 'bank_details_verification_failed', 'contracts_exchanged', 'completion_confirmed']) {
    await assert.rejects(runAsAutomation(() => event(type, HUMAN)), refused, `${type} from automation is refused even under a person's name`);
  }
  await assert.rejects(runAsAutomation(() => event('client_decision_recorded', HUMAN, { subject: 'exchange_authority', decision: 'authorised' })), refused, 'a client decision from automation with no approval cited');
  await assert.rejects(runAsAutomation(() => event('client_decision_recorded', HUMAN, { subject: 'exchange_authority', decision: 'authorised', approvedEventId: crypto.randomUUID() })), refused, 'citing an approval that does not exist');

  // ── 2. money moves only to verified details ──
  await query(`insert into payee_bank_details (id, tenant_id, matter_id, payee_kind, sort_code, account_number, account_name, source_channel, status, recorded_by) values ($1,$2,$3,'seller_solicitor','000000','00000001','From an email','email','unverified','ai')`, [`bd-unv-${suffix}`, t, M]);
  await assert.rejects(event('payment_authorised', HUMAN, { payeeKind: 'seller_solicitor', bankDetailsId: `bd-unv-${suffix}`, purpose: 'completion_monies', approvedBy: HUMAN }), refused, 'payment to unverified details');
  await assert.rejects(event('funds_requested', HUMAN, { fromRole: 'client', bankDetailsId: 'bd-does-not-exist', approvedBy: HUMAN }), refused, 'funds to details that do not exist');

  // ── 3. bank details are never verified by automation ──
  await assert.rejects(
    runAsAutomation(() => query(`insert into payee_bank_details (id, tenant_id, matter_id, payee_kind, sort_code, account_number, account_name, source_channel, status, recorded_by, verified_by, verification_method) values ($1,$2,$3,'seller_solicitor','000000','00000002','X','email','verified','ai','ai','phone_callback_known_number')`, [`bd-auto-${suffix}`, t, M])),
    refused,
    'automation recording details as already verified'
  );
  await assert.rejects(
    runAsAutomation(() => query(`update payee_bank_details set status = 'verified', verified_by = 'ai', verification_method = 'phone_callback_known_number', verified_at = now() where id = $1`, [`bd-unv-${suffix}`])),
    refused,
    'automation verifying details'
  );
  await runAsAutomation(() => query(`insert into payee_bank_details (id, tenant_id, matter_id, payee_kind, sort_code, account_number, account_name, source_channel, status, recorded_by) values ($1,$2,$3,'seller_solicitor','000000','00000003','From an email','email','unverified','ai')`, [`bd-ok-${suffix}`, t, M]));

  // ── 4. contact details ──
  await query(`insert into matter_contact (tenant_id, matter_id, email, name, role, source, phone) values ($1,$2,'sarah@bartlett-law.co.uk','Sarah Bartlett','OTHER_SIDE','MANUAL','0118 000 0000')`, [t, M]);
  await query(`insert into matter_contact (tenant_id, matter_id, email, name, role, source, phone) values ($1,$2,'client@example.com','Priya Shah','CLIENT','LEAP','0118 111 1111')`, [t, M]);
  const contact = (sql: string) => runAsAutomation(() => query(sql, [M]));
  await assert.rejects(contact(`update matter_contact set phone = '07000 000000' where matter_id = $1 and email = 'sarah@bartlett-law.co.uk'`), refused, 'changing a phone number a person entered');
  await assert.rejects(contact(`update matter_contact set role = 'CLIENT' where matter_id = $1 and email = 'sarah@bartlett-law.co.uk'`), refused, 'changing a role a person set');
  await assert.rejects(contact(`update matter_contact set email = 'sarah@bart1ett-law.co.uk' where matter_id = $1 and email = 'sarah@bartlett-law.co.uk'`), refused, 'changing an email');
  await assert.rejects(contact(`delete from matter_contact where matter_id = $1`), refused, 'deleting contacts');
  await assert.rejects(contact(`insert into matter_contact (tenant_id, matter_id, email, role, source) select tenant_id, id, 'fake@gmail.com', 'CLIENT', 'EMAIL_FROM' from matter where id = $1`), refused, 'adding someone from an email as the client');
  // Allowed: seen on email (no role), a refresh, and LEAP updating its own record.
  await contact(`insert into matter_contact (tenant_id, matter_id, email, source) select tenant_id, id, 'new.person@example.com', 'EMAIL_FROM' from matter where id = $1`);
  await contact(`update matter_contact set last_seen_at = now() where matter_id = $1 and email = 'sarah@bartlett-law.co.uk'`);
  await contact(`update matter_contact set phone = '0118 222 2222' where matter_id = $1 and email = 'client@example.com'`);

  // ── positive controls: a person, the right way ──
  await assert.rejects(
    transaction(async (c) => {
      const seq = await nextSeq();
      await c.query(`insert into matter_event (id, tenant_id, matter_id, seq, type, actor, payload, created_at, prev_hash, hash) values ($1,$2,$3,$4,'bank_details_verified',$5,'{}'::jsonb,now(),'','')`, [crypto.randomUUID(), t, M, seq, HUMAN]);
      await c.query(`insert into matter_event (id, tenant_id, matter_id, seq, type, actor, payload, created_at, prev_hash, hash) values ($1,$2,$3,$4,'contracts_exchanged',$5,'{}'::jsonb,now(),'','')`, [crypto.randomUUID(), t, M, seq + 1, HUMAN]);
      await c.query(`insert into payee_bank_details (id, tenant_id, matter_id, payee_kind, sort_code, account_number, account_name, source_channel, status, recorded_by, verified_at, verified_by, verification_method) values ($1,$2,$3,'seller_solicitor','000000','00000004','Verified','letter','verified',$4,now(),$4,'lawyer_checker_match')`, [`bd-ver-${suffix}`, t, M, HUMAN]);
      await c.query(`insert into matter_event (id, tenant_id, matter_id, seq, type, actor, payload, created_at, prev_hash, hash) values ($1,$2,$3,$4,'payment_authorised',$5,$6::jsonb,now(),'','')`, [crypto.randomUUID(), t, M, seq + 2, HUMAN, JSON.stringify({ payeeKind: 'seller_solicitor', bankDetailsId: `bd-ver-${suffix}`, purpose: 'completion_monies', approvedBy: HUMAN })]);
      throw new Error('ROLLBACK_OK');
    }),
    /ROLLBACK_OK/,
    'a person verifying, exchanging and paying to verified details is accepted (rolled back on purpose)'
  );
  // A client decision from an approved note, citing that approval, is accepted from automation.
  const approval = await event('note_actions_applied', HUMAN, { noteId: 'n1', applied: ['a1'] });
  await runAsAutomation(() => event('client_decision_recorded', HUMAN, { subject: 'exchange_authority', decision: 'authorised', approvedEventId: approval }));

  // Nothing refused ever landed.
  const landed = await query<{ type: string }>(`select type from matter_event where matter_id = $1 and type in ('bank_details_verified','contracts_exchanged','completion_confirmed','payment_authorised','funds_requested')`, [M]);
  assert.deepEqual(landed, []);
  const verified = await query<{ id: string }>(`select id from payee_bank_details where matter_id = $1 and status = 'verified'`, [M]);
  assert.deepEqual(verified, []);
  await pool().end();
});
