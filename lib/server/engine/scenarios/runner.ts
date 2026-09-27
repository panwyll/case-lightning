/**
 * Runs a scenario onto a fresh sandbox matter through the real engine, stopping where asked.
 * The matter is created directly (no OneDrive folder, no tracker, no matching identifiers,
 * no CRM), flagged sandbox before the first event so every port guard sees it that way.
 */
import crypto from 'node:crypto';
import { query, queryOne } from '../../db';
import { engine } from '../adapters';
import { rememberSandbox } from '../sandbox';
import type { DecisionKind, DecisionOption } from '../types';
import { blockingDecisions } from '../types';
import { SANDBOX_MARK } from './fixtures';
import { scenarioById, stepsFor, type ScenarioContext } from './library';

export interface RunInput { tenantId: string; userId: string; scenarioId: string; stopAt?: string | null; flagged?: boolean; shapes?: string[] }
export interface RunResult { matterId: string; matterRef: string; steps: Array<{ id: string; label: string; ok: boolean; error?: string }>; stoppedAt: string | null }

const ADDRESSES = ['12 Example Street, Sampletown, SB1 2CD', 'Flat 3, 7 Specimen Court, Sampletown, SB2 4EF', '41 Placeholder Road, Sampletown, SB3 6GH', '9 Fixture Lane, Sampletown, SB4 8JK'];

export async function runScenario(input: RunInput): Promise<RunResult> {
  const scenario = scenarioById(input.scenarioId);
  if (!scenario) throw Object.assign(new Error(`Unknown scenario "${input.scenarioId}".`), { status: 400 });
  const flagged = !!input.flagged;
  const steps = stepsFor(scenario, flagged);
  if (input.stopAt && !steps.some((s) => s.id === input.stopAt)) throw Object.assign(new Error(`Unknown step "${input.stopAt}".`), { status: 400 });

  // The sandbox matter: a real row, plainly labelled, quarantined before it exists.
  const n = await queryOne<{ n: string }>(`select count(*)::text as n from matter where tenant_id = $1 and sandbox`, [input.tenantId]);
  const matterRef = `SANDBOX-${String(Number(n?.n ?? '0') + 1).padStart(3, '0')}`;
  const address = ADDRESSES[Number(n?.n ?? '0') % ADDRESSES.length];
  const side = scenario.transactionType.endsWith('sale') ? 'seller' : scenario.transactionType === 'transfer_of_equity' ? 'owner' : 'buyer';
  const buyers = side === 'buyer' ? ['Sandbox Buyer'] : side === 'owner' ? ['Sandbox Owner A', 'Sandbox Owner B'] : [];
  const sellers = side === 'seller' ? ['Sandbox Seller'] : [];
  const row = await queryOne<{ id: string }>(
    `insert into matter (tenant_id, matter_ref, property_address, buyer_names, seller_names, created_by, folder_path, transaction_type, sandbox, sandbox_scenario, assigned_to, lender)
     values ($1, $2, $3, $4, $5, $6, '', $7, true, $8, $6, $9) returning id`,
    [input.tenantId, matterRef, address, buyers, sellers, input.userId, scenario.transactionType, `${scenario.id}${flagged ? ':flagged' : ''}`, scenario.hasLender ? 'Mock Building Society' : null]
  );
  const matterId = row!.id;
  rememberSandbox(input.tenantId, matterId);
  const svc = engine();

  const ctx: ScenarioContext = {
    svc, tenantId: input.tenantId, matterId, userId: input.userId, flagged,
    async doc({ docType, fileName, facts, body }) {
      const text = body.includes(SANDBOX_MARK) ? body : `${SANDBOX_MARK}\n\n${body}`;
      const bytes = Buffer.from(text, 'utf8');
      const d = await queryOne<{ id: string }>(
        `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, hash_sha256, doc_type, extracted_facts, extraction_confidence, created_by)
         values ($1, $2, 'SANDBOX', $3, $4, 'text/plain', $5, $6, $7, $8::jsonb, 1, $9) returning id`,
        [input.tenantId, matterId, `sandbox://${matterId}/${fileName}`, fileName, bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'), docType, JSON.stringify(facts), input.userId]
      );
      await query(`insert into document_blob (document_id, tenant_id, bytes) values ($1, $2, $3) on conflict (document_id) do nothing`, [d!.id, input.tenantId, bytes]).catch(() => {});
      return d!.id;
    },
    async resolve(kind: DecisionKind, option: DecisionOption, note?: string) {
      const state = await svc.getState(input.tenantId, matterId);
      const d = blockingDecisions(state).find((x) => x.kind === kind);
      if (!d) throw new Error(`No pending ${kind} decision to resolve.`);
      await svc.openDecisionSource(input.tenantId, matterId, d.eventId, input.userId);
      await svc.resolveDecision(input.tenantId, matterId, d.eventId, input.userId, option, note);
    },
    async verifiedDetails(payeeKind, account, name) {
      const source = await ctx.doc({ docType: 'BANK_LETTER', fileName: `${payeeKind}-bank-details.txt`, facts: { content: `${name} bank details letter` }, body: `${name}\nSort code 20-00-00\nAccount ${account}` });
      const r = await svc.recordBankDetails(input.tenantId, matterId, { actor: input.userId, payeeKind, payeeRef: name, details: { sortCode: '200000', accountNumber: account, accountName: name, firmName: name }, sourceChannel: 'letter', sourceDocumentId: source });
      const d = Object.values(r.state.decisions).find((x) => x.kind === 'bank_details' && x.status === 'pending');
      if (d) {
        await svc.openDecisionSource(input.tenantId, matterId, d.eventId, input.userId);
        await svc.resolveDecision(input.tenantId, matterId, d.eventId, input.userId, 'verify', 'Sandbox: verified by call-back on the number on file.', { method: 'phone_callback_known_number' });
      }
      return (r.events[0].payload as { bankDetailsId: string }).bankDetailsId;
    },
    async run(cmd) { await svc.run(input.tenantId, matterId, { actor: input.userId, ...cmd } as never); },
    async settle() {
      // At Propose the engine proposes its own clears and orders; the script stands in for the person who approves them.
      for (let i = 0; i < 12; i++) {
        const state = await svc.getState(input.tenantId, matterId);
        const d = Object.values(state.decisions).find((x) => x.status === 'pending' && (x.kind === 'auto_clear' || x.kind === 'proposal'));
        if (!d) return;
        await svc.openDecisionSource(input.tenantId, matterId, d.eventId, input.userId);
        await svc.resolveDecision(input.tenantId, matterId, d.eventId, input.userId, 'approve', 'Sandbox scenario: approved by the script.');
      }
    },
  };

  const done: RunResult['steps'] = [];
  let stoppedAt: string | null = null;
  for (const s of steps) {
    try {
      await s.run(ctx);
      if (input.stopAt !== s.id) await ctx.settle();
      done.push({ id: s.id, label: s.label, ok: true });
    } catch (err) {
      done.push({ id: s.id, label: s.label, ok: false, error: err instanceof Error ? err.message : String(err) });
      stoppedAt = s.id;
      break;
    }
    if (input.stopAt === s.id) { stoppedAt = s.id; break; }
  }
  const last = done[done.length - 1];
  await query(`update matter set sandbox_step = $3 where id = $1 and tenant_id = $2`, [matterId, input.tenantId, last ? `${last.label}${last.ok ? '' : ' (failed)'}` : null]).catch(() => {});
  return { matterId, matterRef, steps: done, stoppedAt };
}
