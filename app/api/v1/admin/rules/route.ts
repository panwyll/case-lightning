import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireRole, requireUser } from '@/lib/server/session';
import { ok, fail } from '@/lib/server/http';
import { NEW_RULE_DECIDES, NEW_RULE_HOLDS, NEW_RULE_SENDERS, NEW_RULE_SOURCES, newRuleProposals, proposeNewRule, reviewedPlaybook, reviewRule, withdrawNewRule } from '@/lib/server/playbook-review';
import { writeAudit } from '@/lib/server/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const payload = async (tenantId: string) => ({
  rules: await reviewedPlaybook(tenantId),
  proposals: await newRuleProposals(tenantId),
  options: { sources: NEW_RULE_SOURCES, senders: NEW_RULE_SENDERS, decides: NEW_RULE_DECIDES, holds: NEW_RULE_HOLDS },
});

/** The playbook with this firm's review of each rule. Everyone may read; admins and conveyancers review. */
export async function GET() {
  try {
    assertFeature('auth');
    const user = await requireUser();
    return ok(await payload(user.tenantId));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN', 'CONVEYANCER']);
    const b = z.object({ ruleId: z.string().min(3).max(120), status: z.enum(['approved', 'change_proposed']), proposal: z.string().max(5000).nullish() }).parse(await req.json());
    if (b.status === 'approved' && user.role !== 'ADMIN') throw Object.assign(new Error('An admin approves a rule; you can propose a change.'), { status: 403 });
    await reviewRule(user.tenantId, user.userId, b.ruleId, b.status, b.proposal ?? null);
    await writeAudit({ tenantId: user.tenantId, matterId: null, actorUserId: user.userId, actionType: 'PLAYBOOK_RULE_REVIEWED', actionStatus: 'SUCCESS', payload: { ruleId: b.ruleId, status: b.status } }).catch(() => {});
    return ok(await payload(user.tenantId));
  } catch (error) {
    return fail(error);
  }
}

/** Propose a new rule, or take one back (?id=…). */
export async function PUT(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN', 'CONVEYANCER']);
    const b = z.object({
      signal: z.string().trim().min(5).max(300),
      sources: z.array(z.enum(Object.keys(NEW_RULE_SOURCES) as [keyof typeof NEW_RULE_SOURCES])).min(1),
      senders: z.array(z.enum(Object.keys(NEW_RULE_SENDERS) as [keyof typeof NEW_RULE_SENDERS])).default([]),
      example: z.string().max(5000).nullish(),
      actions: z.string().trim().min(5).max(5000),
      decides: z.enum(Object.keys(NEW_RULE_DECIDES) as [keyof typeof NEW_RULE_DECIDES]),
      holds: z.enum(Object.keys(NEW_RULE_HOLDS) as [keyof typeof NEW_RULE_HOLDS]),
    }).parse(await req.json());
    await proposeNewRule(user.tenantId, user.userId, { ...b, example: b.example ?? null });
    await writeAudit({ tenantId: user.tenantId, matterId: null, actorUserId: user.userId, actionType: 'PLAYBOOK_RULE_PROPOSED', actionStatus: 'SUCCESS', payload: { signal: b.signal } }).catch(() => {});
    return ok(await payload(user.tenantId));
  } catch (error) {
    return fail(error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    assertFeature('auth');
    const user = await requireRole(['ADMIN', 'CONVEYANCER']);
    const id = z.string().uuid().parse(req.nextUrl.searchParams.get('id'));
    await withdrawNewRule(user.tenantId, user, id);
    return ok(await payload(user.tenantId));
  } catch (error) {
    return fail(error);
  }
}
