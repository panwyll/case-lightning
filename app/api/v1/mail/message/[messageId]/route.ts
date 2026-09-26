import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { getMessage, listMessageAttachmentsMeta } from '@/lib/server/graph';
import { ok, fail } from '@/lib/server/http';
import { resolveMailbox } from '@/lib/server/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One email in full, from the signed-in person's own mailbox, so they can read it before
 * deciding which case it belongs to. Read-only; nothing is marked read or moved.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ messageId: string }> }) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const { messageId } = z.object({ messageId: z.string().min(8).max(400) }).parse(await params);
    const owner = await resolveMailbox(user, req.nextUrl.searchParams.get('mailbox'));
    const [m, attachments] = await Promise.all([
      getMessage(owner.userId, messageId),
      listMessageAttachmentsMeta(owner.userId, messageId).catch(() => []),
    ]);
    const addr = (r: { emailAddress?: { name?: string; address?: string } }) => ({ name: r.emailAddress?.name ?? null, address: r.emailAddress?.address ?? null });
    return ok({
      message: {
        id: m.id,
        subject: m.subject ?? '',
        from: m.from ? addr(m.from) : null,
        to: (m.toRecipients ?? []).map(addr),
        cc: (m.ccRecipients ?? []).map(addr),
        receivedDateTime: m.receivedDateTime ?? m.sentDateTime ?? null,
        body: { contentType: m.body?.contentType === 'html' ? 'html' : 'text', content: String(m.body?.content ?? '') },
        attachments: attachments.map((a: { id: string; name: string; size: number }) => ({ id: a.id, name: a.name, size: a.size })),
      },
    });
  } catch (error) {
    return fail(error);
  }
}
