import { NextRequest } from 'next/server';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { listThreadMessages } from '@/lib/server/graph';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ graphThreadId: string }> }) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const { graphThreadId } = await params;
    const conversationId = req.nextUrl.searchParams.get('conversationId') ?? graphThreadId;
    const messages = await listThreadMessages(user.userId, conversationId);
    return ok({ messages });
  } catch (error) {
    return fail(error);
  }
}
