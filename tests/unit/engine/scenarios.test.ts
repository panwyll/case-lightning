import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, stepsFor, type ScenarioContext } from '../../../lib/server/engine/scenarios/library';
import { blockingDecisions } from '../../../lib/server/engine/types';
import { harness, TENANT, MATTER, USER } from './helpers';

/** The scripts over the in-memory harness: the same steps the runner performs on a sandbox matter, without a database. */
function context(h: ReturnType<typeof harness>, flagged: boolean): ScenarioContext {
  const ctx: ScenarioContext = {
    svc: h.svc, tenantId: TENANT, matterId: MATTER, userId: USER, flagged,
    async doc({ docType, facts }) { return h.doc(facts, docType); },
    async resolve(kind, option, note) {
      const s = await h.svc.getState(TENANT, MATTER);
      const d = blockingDecisions(s).find((x) => x.kind === kind);
      if (!d) throw new Error(`No pending ${kind} decision`);
      await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
      await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, option, note);
    },
    async verifiedDetails(payeeKind, account, name) {
      const r = await h.svc.recordBankDetails(TENANT, MATTER, { actor: USER, payeeKind, payeeRef: name, details: { sortCode: '200000', accountNumber: account, accountName: name, firmName: name }, sourceChannel: 'letter', sourceDocumentId: h.doc({ content: `${name} letter` }) });
      const d = Object.values(r.state.decisions).find((x) => x.kind === 'bank_details' && x.status === 'pending');
      if (d) {
        await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
        await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'verify', 'called back', { method: 'phone_callback_known_number' });
      }
      return (r.events[0].payload as { bankDetailsId: string }).bankDetailsId;
    },
    async run(cmd) { await h.svc.run(TENANT, MATTER, { actor: USER, ...cmd } as never); },
    async settle() {
      for (let i = 0; i < 12; i++) {
        const s = await h.svc.getState(TENANT, MATTER);
        const d = Object.values(s.decisions).find((x) => x.status === 'pending' && (x.kind === 'auto_clear' || x.kind === 'proposal'));
        if (!d) return;
        await h.svc.openDecisionSource(TENANT, MATTER, d.eventId, USER);
        await h.svc.resolveDecision(TENANT, MATTER, d.eventId, USER, 'approve', 'settled');
      }
    },
  };
  return ctx;
}

for (const scenario of SCENARIOS) {
  for (const flagged of [false, true]) {
    test(`scenario ${scenario.id}${flagged ? ' (flagged)' : ''} runs every step to a closed matter`, async () => {
      const h = harness();
      const ctx = context(h, flagged);
      for (const step of stepsFor(scenario, flagged)) {
        try {
          await step.run(ctx);
          await ctx.settle();
        } catch (err) {
          const s = await h.svc.getState(TENANT, MATTER);
          throw new Error(`${scenario.id}${flagged ? ' flagged' : ''} · step "${step.label}" failed at stage ${s.stage}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const s = await h.svc.getState(TENANT, MATTER);
      assert.ok(s.closedAt, `${scenario.id}: the matter closes`);
      assert.equal(blockingDecisions(s).length, 0, 'nothing is left for a person');
    });
  }
}
