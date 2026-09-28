/**
 * The firm's review of the playbook: per rule, approved or a change proposed. Proposals are
 * exported as a Markdown brief for a developer; nothing here changes behaviour.
 */
import { query, queryOne } from './db';
import { PLAYBOOK, SOURCE_LABEL, ruleHash, stageOf, type PlaybookRule, type PlaybookStage } from './engine/playbook';

export type ReviewStatus = 'approved' | 'change_proposed' | 'changed_since' | 'not_reviewed';
export interface ReviewedRule extends PlaybookRule { stage: PlaybookStage; hash: string; status: ReviewStatus; proposal: string | null; reviewedBy: string | null; reviewedAt: string | null }

export async function reviewedPlaybook(tenantId: string): Promise<ReviewedRule[]> {
  const rows = await query<{ rule_id: string; rule_hash: string; status: 'approved' | 'change_proposed'; proposal: string | null; name: string | null; reviewed_at: string }>(
    `select distinct on (r.rule_id) r.rule_id, r.rule_hash, r.status, r.proposal, coalesce(u.display_name, u.email) as name, r.reviewed_at::text
       from rule_review r left join app_user u on u.id = r.reviewed_by
      where r.tenant_id = $1 order by r.rule_id, r.reviewed_at desc`,
    [tenantId]
  ).catch(() => []);
  const latest = new Map(rows.map((r) => [r.rule_id, r]));
  return PLAYBOOK.map((rule) => {
    const hash = ruleHash(rule);
    const r = latest.get(rule.id);
    const status: ReviewStatus = !r ? 'not_reviewed' : r.status === 'change_proposed' ? 'change_proposed' : r.rule_hash === hash ? 'approved' : 'changed_since';
    return { ...rule, stage: stageOf(rule.id), hash, status, proposal: r?.status === 'change_proposed' ? r.proposal : null, reviewedBy: r?.name ?? null, reviewedAt: r?.reviewed_at ?? null };
  });
}

export async function reviewRule(tenantId: string, userId: string, ruleId: string, status: 'approved' | 'change_proposed', proposal: string | null): Promise<void> {
  const rule = PLAYBOOK.find((r) => r.id === ruleId);
  if (!rule) throw Object.assign(new Error('No such rule.'), { status: 404 });
  if (status === 'change_proposed' && !proposal?.trim()) throw Object.assign(new Error('Say what should happen instead.'), { status: 400 });
  await query(`insert into rule_review (tenant_id, rule_id, rule_hash, status, proposal, reviewed_by) values ($1, $2, $3, $4, $5, $6)`, [tenantId, ruleId, ruleHash(rule), status, status === 'change_proposed' ? proposal!.trim() : null, userId])
    .catch((e) => { throw Object.assign(new Error(`Could not record the review (has migration 108 been run?): ${(e as Error).message}`), { status: 500 }); });
}

/** The proposed changes as a brief a developer can build from: current behaviour, the firm's proposal, and where the code lives. */
export function proposalsMarkdown(firm: string, rules: ReviewedRule[], now = new Date()): string {
  const changes = rules.filter((r) => r.status === 'change_proposed');
  const L: string[] = [`# Proposed playbook changes — ${firm}`, '', `Exported ${now.toISOString().slice(0, 10)}. ${changes.length} proposed change${changes.length === 1 ? '' : 's'} of ${rules.length} rules; ${rules.filter((r) => r.status === 'approved').length} approved as they stand.`, '', 'Each section is one rule: what the system does now, what the firm wants instead, and the code that implements it. Rule ids are stable (lib/server/engine/playbook.ts).', ''];
  for (const r of changes) {
    L.push(`## ${r.signal} \`${r.id}\``, '', `**Source:** ${SOURCE_LABEL[r.source]} · **Stage:** ${r.stage}`, '', '**Current behaviour**', '', `- Detects: ${r.detects}`);
    if (r.from) L.push(`- From: ${r.from}`);
    L.push(...r.actions.map((a, i) => `- Then (${i + 1}): ${a}`), `- Decides: ${r.decides}`);
    if (r.holds) L.push(`- Holds: ${r.holds}`);
    L.push('', `**Proposed by ${r.reviewedBy ?? 'the firm'}${r.reviewedAt ? ` on ${r.reviewedAt.slice(0, 10)}` : ''}**`, '', ...r.proposal!.split('\n').map((x) => `> ${x}`), '', `**Code:** ${r.code.map((c) => `\`${c}\``).join(', ')}`, '');
  }
  if (!changes.length) L.push('_No changes proposed._', '');
  return L.join('\n');
}

// ───────────── new rules the firm proposes ─────────────

export const NEW_RULE_SOURCES = { email_body: 'What an email says', attachment: 'A document (attached or uploaded)', provider: 'A provider or portal notification (InfoTrack, LEAP, InTouch, the lender)', call_note: 'A phone call or file note', date: 'A date passing or a time limit', case_event: 'Something else happening on the case' } as const;
export const NEW_RULE_SENDERS = { client: 'The client', other_side: "The other side's solicitor", agent: 'The estate agent', lender: 'The lender or broker', colleague: 'A colleague', third_party: 'Anyone else (freeholder, managing agent, surveyor…)', anyone: 'Anyone' } as const;
export const NEW_RULE_DECIDES = { fee_earner: 'The fee earner approves each time', client: 'The client decides', automatic: 'Automatic: no one needs to approve' } as const;
export const NEW_RULE_HOLDS = { nothing: 'Nothing', exchange: 'Exchange', completion: 'Completion' } as const;
export type NewRuleSource = keyof typeof NEW_RULE_SOURCES;
export type NewRuleSender = keyof typeof NEW_RULE_SENDERS;

export interface NewRuleProposal { id: string; signal: string; sources: NewRuleSource[]; senders: NewRuleSender[]; example: string | null; actions: string; decides: keyof typeof NEW_RULE_DECIDES; holds: keyof typeof NEW_RULE_HOLDS; proposedBy: string | null; proposedById: string | null; proposedAt: string }

export async function newRuleProposals(tenantId: string): Promise<NewRuleProposal[]> {
  const rows = await query<{ id: string; signal: string; sources: NewRuleSource[]; senders: NewRuleSender[]; example: string | null; actions: string; decides: keyof typeof NEW_RULE_DECIDES; holds: keyof typeof NEW_RULE_HOLDS; name: string | null; proposed_by: string | null; proposed_at: string }>(
    `select p.id, p.signal, p.sources, p.senders, p.example, p.actions, p.decides, p.holds, coalesce(u.display_name, u.email) as name, p.proposed_by, p.proposed_at::text
       from rule_proposal p left join app_user u on u.id = p.proposed_by where p.tenant_id = $1 and p.withdrawn_at is null order by p.proposed_at desc`,
    [tenantId]
  ).catch(() => []);
  return rows.map((r) => ({ id: r.id, signal: r.signal, sources: r.sources, senders: r.senders, example: r.example, actions: r.actions, decides: r.decides, holds: r.holds, proposedBy: r.name, proposedById: r.proposed_by, proposedAt: r.proposed_at }));
}

export async function proposeNewRule(tenantId: string, userId: string, p: Omit<NewRuleProposal, 'id' | 'proposedBy' | 'proposedById' | 'proposedAt'>): Promise<void> {
  await query(`insert into rule_proposal (tenant_id, signal, sources, senders, example, actions, decides, holds, proposed_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [tenantId, p.signal.trim(), p.sources, p.senders, p.example?.trim() || null, p.actions.trim(), p.decides, p.holds, userId])
    .catch((e) => { throw Object.assign(new Error(`Could not save the proposal (has migration 109 been run?): ${(e as Error).message}`), { status: 500 }); });
}

/** The author or an admin takes a proposal back. */
export async function withdrawNewRule(tenantId: string, user: { userId: string; role: string }, id: string): Promise<void> {
  const row = await queryOne<{ proposed_by: string | null }>(`select proposed_by from rule_proposal where id = $1 and tenant_id = $2 and withdrawn_at is null`, [id, tenantId]);
  if (!row) throw Object.assign(new Error('No such proposal.'), { status: 404 });
  if (user.role !== 'ADMIN' && row.proposed_by !== user.userId) throw Object.assign(new Error('Only whoever proposed it, or an admin, can remove it.'), { status: 403 });
  await query(`update rule_proposal set withdrawn_at = now() where id = $1 and tenant_id = $2`, [id, tenantId]);
}

export function newRulesMarkdown(items: NewRuleProposal[]): string {
  if (!items.length) return '';
  const L: string[] = ['# Proposed new rules', '', 'Situations the playbook does not cover yet. Each needs detection, the actions below, a playbook entry in lib/server/engine/playbook.ts and tests.', ''];
  for (const n of items) {
    L.push(`## ${n.signal}`, '', `- Comes from: ${n.sources.map((s) => NEW_RULE_SOURCES[s]).join('; ')}`);
    if (n.senders.length) L.push(`- Who can trigger it: ${n.senders.map((s) => NEW_RULE_SENDERS[s]).join('; ')}`);
    L.push(`- Decides: ${NEW_RULE_DECIDES[n.decides]}`, `- Holds: ${NEW_RULE_HOLDS[n.holds]}`, '', '**What should happen**', '', ...n.actions.split('\n').map((x) => `> ${x}`), '');
    if (n.example) L.push('**Example of what it looks like**', '', '```', n.example, '```', '');
    L.push(`_Proposed by ${n.proposedBy ?? 'the firm'} on ${n.proposedAt.slice(0, 10)}_`, '');
  }
  return L.join('\n');
}
