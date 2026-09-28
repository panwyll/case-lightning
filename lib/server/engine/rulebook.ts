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
  'Hard Stops',
  'What Holds Each Stage',
  'What Clears On Its Own',
  'Chasing And Checking In',
  'Deadlines',
  'Kinds Of Issue',
  'What The System Does Unasked',
] as const;

/** The invariants in a firm's words; an id not here (replay, the log's mechanics) is not shown. */
const HARD_STOP_WORDS: Record<string, { title: string; rule: string }> = {
  cites_source: { title: 'Every decision has its source', rule: 'Nothing is put to a person for a decision without the document it came from, a summary and the options.' },
  source_before_verdict: { title: 'Read before deciding', rule: 'A person cannot decide on a document they have not opened and read.' },
  reason_required: { title: 'A reason for anything but approval', rule: 'Rejecting, escalating or accepting a risk needs a written reason, kept on the file.' },
  human_gate: { title: 'No money moves and no report goes without a person', rule: 'Requesting funds, authorising a payment and sending the report on title always need a person\'s approval. The system cannot do them on its own, whatever the firm\'s settings.' },
  bank_details_hard_stop: { title: 'Bank details are verified out of band', rule: 'Every new or changed set of bank details must be verified by a separate channel (a call to a known number) before any payment. Payments are refused while a change is unverified.' },
  walled: { title: 'Both sides in the firm are walled', rule: 'When the firm acts for both buyer and seller, each side\'s case is kept apart; enquiries pass between them the same way they would between two firms.' },
  abandoned_is_final: { title: 'An abandoned case stays abandoned', rule: 'Once a case is abandoned nothing more happens on it: no chases, no timers, no new steps.' },
  issues_hold: { title: 'An open issue holds its gate', rule: 'An issue that holds exchange stops exchange, and one that holds completion stops completion; everything else carries on. Releasing a hold needs a written reason.' },
  facts_not_judgements: { title: 'Facts are automated; judgements are a person\'s', rule: 'The system records what documents say. Whether title, enquiries or AML are satisfactory is a conveyancer\'s decision, and whether to proceed, accept a risk or exchange is the client\'s.' },
  sof_scrutinised: { title: 'Source of funds is scrutinised', rule: 'Every bank statement is read line by line and every unusual credit becomes a query. Sign-off is refused while a query is open.' },
  lender_told: { title: 'The lender is told', rule: 'On a mortgage purchase, a price change, an indemnity policy or a retention holds exchange until the lender confirms.' },
};

const h = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const RECIPIENT: Record<string, string> = { seller_solicitor: "the other side's solicitor", search_provider: 'the search provider', lender: 'the lender', client: 'the client', id_provider: 'the ID provider', hmlr: 'HM Land Registry' };
const LEVEL_WORDS = { propose: 'is proposed to a person, who approves each one', assist: 'goes unasked when it is routine; anything unusual is proposed', auto: 'goes unasked' } as const;
const days = (n: number) => `${n} working day${n === 1 ? '' : 's'}`;

export function rulebook(levels?: LevelConfig | null): { version: string; rules: Rule[] } {
  const spec = machineSpec();
  const out: Array<Omit<Rule, 'hash'>> = [];
  const add = (id: string, section: (typeof RULE_SECTIONS)[number], title: string, rule: string) => out.push({ id, section, title, rule });

  // The machine's invariants, as a firm reads them. The purely technical ones (the log, replay) are the system's, not the firm's.
  for (const i of spec.invariants) {
    const plain = HARD_STOP_WORDS[i.id];
    if (plain) add(`invariant:${i.id}`, 'Hard Stops', plain.title, plain.rule);
  }
  add('hard:email_cannot_clear', 'Hard Stops', 'Nothing is cleared by email', 'An email can report that something is done, but ID and AML checks, proof of funds and searches are only cleared by the result itself or by a person. Only the client can make a client decision; when someone else reports one, the client is asked to confirm it.');
  add('hard:message_guard', 'Hard Stops', 'A broken message never goes out', 'Every message is checked before it is sent. One with a missing value, a placeholder or a failed reading becomes a task for a person instead of an email.');

  for (const t of spec.transactionTypes) {
    for (const st of t.stages) {
      const gates = t.stageGates[st] ?? spec.stages.find((x) => x.id === st)?.gates ?? [];
      if (!gates.length) continue;
      add(`gate:${t.type}:${st}`, 'What Holds Each Stage', `${t.label}: leaving ${t.stageLabels[st] ?? spec.stages.find((x) => x.id === st)?.label ?? st}`, `Needs ${gates.join('; ')}.`);
    }
  }

  for (const sf of spec.subflows) add(`clear:${sf.id}`, 'What Clears On Its Own', sf.label, sf.rule);
  add('clear:confidence', 'What Clears On Its Own', 'Reading confidence', `A document read with confidence below ${Math.round(spec.thresholds.extractionConfidence * 100)}% is never cleared on its own; it goes to a person. A document whose type is identified with confidence below ${Math.round(spec.thresholds.classificationConfidence * 100)}% is not filed as that type.`);

  for (const w of spec.timers.waits) {
    const who = RECIPIENT[w.recipientRole] ?? w.recipientRole.replace(/_/g, ' ');
    const what = (WAIT_LABEL as Record<string, string>)[w.waitKey] ?? w.waitKey.replace(/_/g, ' ');
    add(`chase:${w.waitKey}`, 'Chasing And Checking In', what, `${who.replace(/^./, (c) => c.toUpperCase())} is chased after ${days(w.chaseAfter)}${w.chaseEvery ? `, then every ${days(w.chaseEvery)}` : ' (once)'}, with what we asked for sent again. After ${days(w.escalateAfter)} it comes to a person, and again every ${days(w.reEscalateAfter)} while it is still outstanding. Nobody is chased while they have told us they are away.`);
  }

  for (const d of spec.timers.deadlines) add(`deadline:${d.kind}`, 'Deadlines', d.description.replace(/^./, (c) => c.toUpperCase()), `A person is told ${days(d.leadWorkingDays)} before: ${d.description}.`);

  for (const k of spec.issues.kinds) {
    const holds = (k as { context?: boolean }).context ? 'Context: holds nothing and makes no task; said when someone asks for an update.' : k.gate === 'none' ? 'Holds nothing by default.' : `Holds ${k.gate} by default; a person may release the hold with a reason.`;
    add(`issue:${k.kind}`, 'Kinds Of Issue', k.label, `Arises from ${k.arisesFrom}. ${holds}`);
  }

  for (const a of ENGINE_ACTIONS) {
    const subjects = ENGINE_ACTION_SUBJECTS[a];
    const lines = subjects.length
      ? subjects.map((s) => `${s.label}: ${LEVEL_WORDS[levelFor(levels, a, s.key)]}`).join('. ')
      : LEVEL_WORDS[levelFor(levels, a)];
    add(`level:${a}`, 'What The System Does Unasked', ENGINE_ACTION_LABEL[a], `${lines.replace(/^./, (c) => c.toUpperCase())}.`);
  }

  const rules = out.map((r) => ({ ...r, hash: h(`${r.title}\n${r.rule}`) }));
  const version = h(rules.map((r) => `${r.id}:${r.hash}`).join('|')).slice(0, 12);
  return { version, rules };
}
