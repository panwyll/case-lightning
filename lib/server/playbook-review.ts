/**
 * The firm's review of the playbook: per rule, approved or a change proposed. Proposals are
 * exported as a Markdown brief for a developer; nothing here changes behaviour.
 */
import { query } from './db';
import { PLAYBOOK, SOURCE_LABEL, ruleHash, type PlaybookRule } from './engine/playbook';

export type ReviewStatus = 'approved' | 'change_proposed' | 'changed_since' | 'not_reviewed';
export interface ReviewedRule extends PlaybookRule { hash: string; status: ReviewStatus; proposal: string | null; reviewedBy: string | null; reviewedAt: string | null }

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
    return { ...rule, hash, status, proposal: r?.status === 'change_proposed' ? r.proposal : null, reviewedBy: r?.name ?? null, reviewedAt: r?.reviewed_at ?? null };
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
    L.push(`## ${r.signal} \`${r.id}\``, '', `**Source:** ${SOURCE_LABEL[r.source]}`, '', '**Current behaviour**', '', `- Detects: ${r.detects}`);
    if (r.from) L.push(`- From: ${r.from}`);
    L.push(...r.actions.map((a, i) => `- Then (${i + 1}): ${a}`), `- Decides: ${r.decides}`);
    if (r.holds) L.push(`- Holds: ${r.holds}`);
    L.push('', `**Proposed by ${r.reviewedBy ?? 'the firm'}${r.reviewedAt ? ` on ${r.reviewedAt.slice(0, 10)}` : ''}**`, '', ...r.proposal!.split('\n').map((x) => `> ${x}`), '', `**Code:** ${r.code.map((c) => `\`${c}\``).join(', ')}`, '');
  }
  if (!changes.length) L.push('_No changes proposed._', '');
  return L.join('\n');
}
