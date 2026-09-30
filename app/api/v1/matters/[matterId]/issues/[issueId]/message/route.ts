import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { assertMatterAccess } from '@/lib/server/guard';
import { assertEntitled } from '@/lib/server/plan';
import { ok, fail } from '@/lib/server/http';
import { engine } from '@/lib/server/engine/adapters';
import { requireWriter } from '@/lib/server/engine/http';
import { MESSAGE_PARTIES } from '@/lib/server/engine/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

type Ctx = { params: Promise<{ matterId: string; issueId: string }> };
const Params = z.object({ matterId: z.string().uuid(), issueId: z.string().min(1).max(60) });

/** The draft for one of the issue's message steps (?step=), from the case. Nothing is sent. */
export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    const { matterId, issueId } = Params.parse(await params);
    await assertMatterAccess(user, matterId);
    const step = z.string().min(1).max(200).parse(req.nextUrl.searchParams.get('step'));
    return ok(await engine().draftIssueMessage(user.tenantId, matterId, issueId, step));
  } catch (error) {
    return fail(error);
  }
}

/** Send the message as written, and log it on the issue. */
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    assertFeature('auth');
    const user = await requireUser();
    await assertEntitled(user.tenantId);
    requireWriter(user);
    const { matterId, issueId } = Params.parse(await params);
    await assertMatterAccess(user, matterId);
    const body = z.object({ to: z.enum(MESSAGE_PARTIES), subject: z.string().min(1).max(300), body: z.string().min(1).max(20000) }).parse(await req.json());
    const res = await engine().sendIssueMessage(user.tenantId, matterId, issueId, { actor: user.userId, ...body });
    return ok({ events: res.events.length });
  } catch (error) {
    return fail(error);
  }
}
