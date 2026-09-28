/**
 * The rulebook: every rule the engine applies, in plain words, for a firm to read and sign off.
 *
 * Built from the machine's own spec (spec.ts, itself checked against the machine by tests), so
 * what is signed is what runs. Each rule has a stable id and a hash of its words: a sign-off
 * records the hashes, and a rule whose words change afterwards shows as changed until the
 * firm signs again. The firm's own settings (trust levels) are rules too, and are included.
 *
 * Issues are not the rules: an issue is a problem on one case. The kinds of issue, and what
 * each holds by default, are one section of the rules.
 */
import crypto from 'node:crypto';
import { machineSpec } from './spec';
import { ENGINE_ACTIONS, ENGINE_ACTION_LABEL, ENGINE_ACTION_SUBJECTS, levelFor, type LevelConfig } from './types';
import { WAIT_LABEL } from './messages';

export interface Rule { id: string; section: string; title: string; rule: string; hash: string }
export const RULE_SECTIONS = [
  'Controls',
  'Stage Gates',
  'Automatic Clearance',
  'Chasing',
  'Deadlines',
  'Issue Types',
  'Automation Levels',
] as const;

/** The invariants in a firm's words; an id not here (replay, the log's mechanics) is not shown. */
const HARD_STOP_WORDS: Record<string, { title: string; rule: string }> = {
  cites_source: { title: 'Decisions cite their source', rule: 'No decision is presented without the source document, a summary and the available options.' },
  source_before_verdict: { title: 'Source reviewed before decision', rule: 'A decision cannot be recorded until the decision-maker has opened and reviewed the source document.' },
  reason_required: { title: 'Reasons recorded', rule: 'Any outcome other than approval (rejection, escalation, acceptance of risk) requires a written reason, retained on the file.' },
  human_gate: { title: 'Payments and report on title require approval', rule: 'Requests for funds, payment authorisations and the report on title always require approval by a fee earner. No automation setting overrides this.' },
  bank_details_hard_stop: { title: 'Bank details verified out of band', rule: 'New or amended bank details must be verified through an independent channel before any payment. Payments are refused while a change is unverified.' },
  walled: { title: 'Information barrier', rule: 'Where the firm acts on both sides, each matter is segregated; enquiries pass between them as between separate firms.' },
  abandoned_is_final: { title: 'Abandonment is final', rule: 'An abandoned matter is closed to further steps: timers stop and no new actions are accepted.' },
  issues_hold: { title: 'Issues hold their gate', rule: 'An open issue gated on exchange or completion prevents that step; other work continues. Releasing a hold requires a recorded reason.' },
  facts_not_judgements: { title: 'Judgements reserved to people', rule: 'Facts are extracted from documents automatically. Whether title, enquiries and AML are satisfactory is for the fee earner; whether to proceed, accept a risk or exchange is for the client.' },
  sof_scrutinised: { title: 'Source of funds reviewed', rule: 'Bank statements are reviewed line by line; unexplained credits are raised as queries. Sign-off is refused while any query is open.' },
  lender_told: { title: 'Lender notification', rule: 'On a mortgaged purchase, a price change, indemnity policy or retention holds exchange until the lender confirms.' },
};

const h = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const RECIPIENT: Record<string, string> = { seller_solicitor: "the other side's solicitor", search_provider: 'the search provider', lender: 'the lender', client: 'the client', id_provider: 'the ID provider', hmlr: 'HM Land Registry' };
const LEVEL_WORDS = { propose: 'requires approval each time', assist: 'sent automatically when routine; otherwise requires approval', auto: 'sent automatically' } as const;
const days = (n: number) => `${n} working day${n === 1 ? '' : 's'}`;

export function rulebook(levels?: LevelConfig | null): { version: string; rules: Rule[] } {
  const spec = machineSpec();
  const out: Array<Omit<Rule, 'hash'>> = [];
  const add = (id: string, section: (typeof RULE_SECTIONS)[number], title: string, rule: string) => out.push({ id, section, title, rule });

  // The machine's invariants, as a firm reads them. The purely technical ones (the log, replay) are the system's, not the firm's.
  for (const i of spec.invariants) {
    const plain = HARD_STOP_WORDS[i.id];
    if (plain) add(`invariant:${i.id}`, 'Controls', plain.title, plain.rule);
  }
  add('hard:email_cannot_clear', 'Controls', 'No clearance by email', 'Correspondence may report progress but cannot clear ID/AML, source of funds or searches; these clear only on the result or by a fee earner. Client decisions are recorded only on the client\'s own instruction; a third party\'s report is put to the client for confirmation.');
  add('hard:message_guard', 'Controls', 'Outbound message check', 'Every outbound message is checked before sending. A message with a missing value, placeholder text or a failed extraction is withheld and referred to a fee earner.');

  for (const t of spec.transactionTypes) {
    for (const st of t.stages) {
      const gates = t.stageGates[st] ?? spec.stages.find((x) => x.id === st)?.gates ?? [];
      if (!gates.length) continue;
      add(`gate:${t.type}:${st}`, 'Stage Gates', `${t.label} · ${t.stageLabels[st] ?? spec.stages.find((x) => x.id === st)?.label ?? st} exit`, `Requires: ${gates.join('; ')}.`);
    }
  }

  for (const sf of spec.subflows) add(`clear:${sf.id}`, 'Automatic Clearance', sf.label, sf.rule);
  add('clear:confidence', 'Automatic Clearance', 'Extraction confidence', `Documents extracted below ${Math.round(spec.thresholds.extractionConfidence * 100)}% confidence are never cleared automatically and are referred to a fee earner. Documents classified below ${Math.round(spec.thresholds.classificationConfidence * 100)}% confidence are not filed under that type.`);

  for (const w of spec.timers.waits) {
    const who = RECIPIENT[w.recipientRole] ?? w.recipientRole.replace(/_/g, ' ');
    const what = (WAIT_LABEL as Record<string, string>)[w.waitKey] ?? w.waitKey.replace(/_/g, ' ');
    add(`chase:${w.waitKey}`, 'Chasing', what, `Chased (${who}) at ${days(w.chaseAfter)}${w.chaseEvery ? `, then every ${days(w.chaseEvery)}` : ', once'}; each chase restates the original request. Escalated to the fee earner at ${days(w.escalateAfter)}, then every ${days(w.reEscalateAfter)}. Suspended while the recipient has notified absence.`);
  }

  for (const d of spec.timers.deadlines) add(`deadline:${d.kind}`, 'Deadlines', d.description.replace(/^./, (c) => c.toUpperCase()), `Fee earner alerted ${days(d.leadWorkingDays)} in advance.`);

  for (const k of spec.issues.kinds) {
    const holds = (k as { context?: boolean }).context ? 'Recorded as context: no hold, no task; reported in status updates.' : k.gate === 'none' ? 'Default hold: none.' : `Default hold: ${k.gate}; releasable with a recorded reason.`;
    add(`issue:${k.kind}`, 'Issue Types', k.label, `Typical source: ${k.arisesFrom}. ${holds}`);
  }

  for (const a of ENGINE_ACTIONS) {
    const subjects = ENGINE_ACTION_SUBJECTS[a];
    const lines = subjects.length
      ? subjects.map((s) => `${s.label}: ${LEVEL_WORDS[levelFor(levels, a, s.key)]}`).join('. ')
      : LEVEL_WORDS[levelFor(levels, a)];
    add(`level:${a}`, 'Automation Levels', ENGINE_ACTION_LABEL[a], `${lines.replace(/^./, (c) => c.toUpperCase())}.`);
  }

  const rules = out.map((r) => ({ ...r, hash: h(`${r.title}\n${r.rule}`) }));
  const version = h(rules.map((r) => `${r.id}:${r.hash}`).join('|')).slice(0, 12);
  return { version, rules };
}
