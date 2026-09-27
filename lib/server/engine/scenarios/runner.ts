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

export interface RunInput { tenantId: string; userId: string; scenarioId: string; stopAt?: string | null; flagged?: boolean; shapes?: string[]; /** step: create the case and run only the first step; every later step is Next Step on the case, and every decision is the person's */ mode?: 'run' | 'step' }
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
  if (input.mode === 'step') {
    await query(`update matter set sandbox_step = $3 where id = $1 and tenant_id = $2`, [matterId, input.tenantId, `0/${steps.length} · not started`]);
    const first = await stepScenario({ tenantId: input.tenantId, userId: input.userId, matterId });
    return { matterId, matterRef, steps: first.ran ? [{ id: first.ran.id, label: first.ran.label, ok: true }] : [], stoppedAt: first.ran?.id ?? null };
  }
  const ctx = contextFor(input.tenantId, input.userId, matterId, flagged);
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

/** The scenario context over a sandbox matter: fixture documents, the person's decisions taken by the script, verified bank details, commands. */
function contextFor(tenantId: string, userId: string, matterId: string, flagged: boolean): ScenarioContext {
  const svc = engine();
  const ctx: ScenarioContext = {
    svc, tenantId, matterId, userId, flagged,
    async doc({ docType, fileName, facts, body }) {
      const text = body.includes(SANDBOX_MARK) ? body : `${SANDBOX_MARK}\n\n${body}`;
      const bytes = Buffer.from(text, 'utf8');
      const d = await queryOne<{ id: string }>(
        `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, hash_sha256, doc_type, extracted_facts, extraction_confidence, created_by)
         values ($1, $2, 'SANDBOX', $3, $4, 'text/plain', $5, $6, $7, $8::jsonb, 1, $9) returning id`,
        [tenantId, matterId, `sandbox://${matterId}/${fileName}`, fileName, bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'), docType, JSON.stringify(facts), userId]
      );
      await query(`insert into document_blob (document_id, tenant_id, bytes) values ($1, $2, $3) on conflict (document_id) do nothing`, [d!.id, tenantId, bytes]).catch(() => {});
      return d!.id;
    },
    async resolve(kind: DecisionKind, option: DecisionOption, note?: string) {
      const state = await svc.getState(tenantId, matterId);
      const d = blockingDecisions(state).find((x) => x.kind === kind);
      if (!d) throw new Error(`No pending ${kind} decision to resolve.`);
      await svc.openDecisionSource(tenantId, matterId, d.eventId, userId);
      await svc.resolveDecision(tenantId, matterId, d.eventId, userId, option, note);
    },
    async verifiedDetails(payeeKind, account, name) {
      const source = await ctx.doc({ docType: 'BANK_LETTER', fileName: `${payeeKind}-bank-details.txt`, facts: { content: `${name} bank details letter` }, body: `${name}\nSort code 20-00-00\nAccount ${account}` });
      const r = await svc.recordBankDetails(tenantId, matterId, { actor: userId, payeeKind, payeeRef: name, details: { sortCode: '200000', accountNumber: account, accountName: name, firmName: name }, sourceChannel: 'letter', sourceDocumentId: source });
      const d = Object.values(r.state.decisions).find((x) => x.kind === 'bank_details' && x.status === 'pending');
      if (d) {
        await svc.openDecisionSource(tenantId, matterId, d.eventId, userId);
        await svc.resolveDecision(tenantId, matterId, d.eventId, userId, 'verify', 'Sandbox: verified by call-back on the number on file.', { method: 'phone_callback_known_number' });
      }
      return (r.events[0].payload as { bankDetailsId: string }).bankDetailsId;
    },
    async run(cmd) { await svc.run(tenantId, matterId, { actor: userId, ...cmd } as never); },
    async settle() {
      for (let i = 0; i < 12; i++) {
        const state = await svc.getState(tenantId, matterId);
        const d = Object.values(state.decisions).find((x) => x.status === 'pending' && (x.kind === 'auto_clear' || x.kind === 'proposal'));
        if (!d) return;
        await svc.openDecisionSource(tenantId, matterId, d.eventId, userId);
        await svc.resolveDecision(tenantId, matterId, d.eventId, userId, 'approve', 'Sandbox scenario: approved by the script.');
      }
    },
  };
  return ctx;
}

export interface StepResult { done: boolean; index: number; total: number; ran?: { id: string; label: string }; next?: string | null; blocked?: string | null; error?: string | null }

/**
 * Next Step on a stepping sandbox: runs the next scripted step, unless the engine is waiting on
 * a person — a pending proposal or decision under Tasks — in which case it says so and does
 * nothing. A step that is a person's decision is never taken by the script here: once the
 * person has decided it under Tasks, the step is marked done and the next one runs.
 */
export async function stepScenario(input: { tenantId: string; userId: string; matterId: string }): Promise<StepResult> {
  const m = await queryOne<{ sandbox: boolean; sandbox_scenario: string | null; sandbox_step: string | null }>(`select sandbox, sandbox_scenario, sandbox_step from matter where id = $1 and tenant_id = $2`, [input.matterId, input.tenantId]);
  if (!m?.sandbox || !m.sandbox_scenario) throw Object.assign(new Error('Not a sandbox case.'), { status: 409 });
  const [scenarioId, variant] = m.sandbox_scenario.split(':');
  const scenario = scenarioById(scenarioId);
  if (!scenario) throw Object.assign(new Error(`Unknown scenario "${scenarioId}".`), { status: 400 });
  const flagged = variant === 'flagged';
  const steps = stepsFor(scenario, flagged);
  const prog = m.sandbox_step?.match(/^(\d+)\/(\d+)/);
  if (!prog) throw Object.assign(new Error('This sandbox was run in one go; start a stepping case from the library to walk it.'), { status: 409 });
  let index = Number(prog[1]);
  const total = steps.length;
  const svc = engine();
  const record = async (i: number, label: string) => { index = i; await query(`update matter set sandbox_step = $3 where id = $1 and tenant_id = $2`, [input.matterId, input.tenantId, `${i}/${total} · ${label}`]); };
  const ctx = contextFor(input.tenantId, input.userId, input.matterId, flagged);
  for (let guard = 0; guard < steps.length + 1; guard++) {
    if (index >= total) return { done: true, index, total, next: null };
    const step = steps[index];
    const state = await svc.getState(input.tenantId, input.matterId);
    const pending = blockingDecisions(state);
    if (step.decision) {
      // The person's step: wait for them, then move on once it is decided.
      if (pending.some((d) => d.kind === step.decision)) return { done: false, index, total, next: step.label, blocked: `Your turn: "${step.label}" is waiting under Tasks.` };
      await record(index + 1, step.label);
      continue;
    }
    // The engine's own asks (a proposal, a clear held for approval) stop the script: the person answers them first. A document-backed decision does not — the world keeps arriving while a person reviews.
    const asks = pending.filter((d) => d.kind === 'proposal' || d.kind === 'auto_clear');
    if (asks.length) return { done: false, index, total, next: step.label, blocked: `The engine is waiting on you: ${asks.length} ${asks.length === 1 ? 'proposal' : 'proposals'} under Tasks (${[...new Set(asks.map((d) => (d.kind === 'auto_clear' ? 'approve the clear' : `${String(d.subject ?? '').split(':')[0].replace(/_/g, ' ')}`)))].join(', ')}). Decide, then Next Step.` };
    try {
      await step.run(ctx);
    } catch (err) {
      return { done: false, index, total, next: step.label, error: err instanceof Error ? err.message : String(err) };
    }
    await record(index + 1, step.label);
    return { done: index >= total, index, total, ran: { id: step.id, label: step.label }, next: steps[index]?.label ?? null };
  }
  return { done: index >= total, index, total, next: steps[index]?.label ?? null };
}
