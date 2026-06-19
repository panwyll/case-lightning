import { NextRequest } from 'next/server';
import { z } from 'zod';
import { assertFeature } from '@/lib/server/config';
import { requireUser } from '@/lib/server/session';
import { query, queryOne } from '@/lib/server/db';
import { assertMatterAccess } from '@/lib/server/guard';
import {
  getMessage,
  listMessageAttachments,
  uploadToMatterFolder,
  appendTrackerRow,
} from '@/lib/server/graph';
import { upsertChunks } from '@/lib/server/ai';
import { stripHtml } from '@/lib/server/text';
import { writeAudit } from '@/lib/server/audit';
import { ok, fail } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ graphThreadId: string }> }) {
  try {
    assertFeature('auth');
    assertFeature('graph');
    const user = await requireUser();
    const { graphThreadId } = await params;
    const body = z
      .object({ matterId: z.string().uuid(), messageId: z.string(), includeAttachments: z.boolean().default(true) })
      .parse(await req.json());

    await assertMatterAccess(user, body.matterId);
    const matter = await queryOne<{ folder_path: string | null; tracker_item_id: string | null }>(
      `select folder_path, tracker_item_id from matter where id = $1 and tenant_id = $2`,
      [body.matterId, user.tenantId]
    );
    if (!matter?.folder_path) return fail(new Error('Matter folder not provisioned'));

    const message = await getMessage(user.userId, body.messageId);
    const attachments = body.includeAttachments ? await listMessageAttachments(user.userId, body.messageId) : [];

    const emailText = [
      `Subject: ${message.subject ?? ''}`,
      `From: ${message.from?.emailAddress?.address ?? ''}`,
      `To: ${(message.toRecipients ?? []).map((r: any) => r.emailAddress?.address).filter(Boolean).join(', ')}`,
      `Cc: ${(message.ccRecipients ?? []).map((r: any) => r.emailAddress?.address).filter(Boolean).join(', ')}`,
      `Sent: ${message.sentDateTime ?? ''}`,
      '',
      stripHtml(message.body?.content),
    ].join('\n');

    const emailFileName = `${(message.subject ?? 'email').replace(/[^a-z0-9\-_. ]/gi, '').slice(0, 80) || 'email'}.txt`;
    const emailUploaded = await uploadToMatterFolder(
      user.userId,
      matter.folder_path,
      emailFileName,
      Buffer.from(emailText, 'utf8')
    );

    await query(
      `insert into document
        (tenant_id, matter_id, source_type, drive_id, graph_item_id, storage_path, web_url, file_name, mime_type, size_bytes, doc_type, created_by)
       values ($1,$2,'EMAIL_BODY',$3,$4,$5,$6,$7,'text/plain',$8,'EMAIL_BODY',$9)`,
      [
        user.tenantId,
        body.matterId,
        emailUploaded.parentReference?.driveId ?? null,
        emailUploaded.id,
        `${matter.folder_path}/${emailFileName}`,
        emailUploaded.webUrl ?? null,
        emailFileName,
        Buffer.byteLength(emailText, 'utf8'),
        user.userId,
      ]
    );
    await upsertChunks({
      tenantId: user.tenantId,
      matterId: body.matterId,
      sourceKind: 'EMAIL',
      text: emailText,
      metadata: { fileName: emailFileName, graphMessageId: body.messageId, graphThreadId, source: 'EMAIL_BODY' },
    });

    const savedDocs: Array<{ fileName: string; webUrl: string | null; itemId: string }> = [
      { fileName: emailFileName, webUrl: emailUploaded.webUrl ?? null, itemId: emailUploaded.id },
    ];

    for (const attachment of attachments) {
      if (!attachment.contentBytes || !attachment.name) continue;
      const buffer = Buffer.from(attachment.contentBytes, 'base64');
      const uploaded = await uploadToMatterFolder(user.userId, matter.folder_path, attachment.name, buffer);
      const doc = await queryOne<{ id: string }>(
        `insert into document
          (tenant_id, matter_id, source_type, drive_id, graph_item_id, storage_path, web_url, file_name, mime_type, size_bytes, doc_type, created_by)
         values ($1,$2,'EMAIL_ATTACHMENT',$3,$4,$5,$6,$7,$8,$9,'EMAIL_ATTACHMENT',$10) returning id`,
        [
          user.tenantId,
          body.matterId,
          uploaded.parentReference?.driveId ?? null,
          uploaded.id,
          `${matter.folder_path}/${attachment.name}`,
          uploaded.webUrl ?? null,
          attachment.name,
          attachment.contentType ?? null,
          attachment.size ?? null,
          user.userId,
        ]
      );
      await upsertChunks({
        tenantId: user.tenantId,
        matterId: body.matterId,
        sourceKind: 'DOCUMENT',
        sourceId: doc!.id,
        text: `${attachment.name}\n${attachment.contentType ?? ''}`,
        metadata: { fileName: attachment.name, graphItemId: uploaded.id, source: 'EMAIL_ATTACHMENT', graphThreadId },
      });
      savedDocs.push({ fileName: attachment.name, webUrl: uploaded.webUrl ?? null, itemId: uploaded.id });
    }

    if (matter.tracker_item_id) {
      await appendTrackerRow(user.userId, matter.tracker_item_id, {
        date: new Date().toISOString().slice(0, 10),
        type: 'DOC_SAVED',
        detail: `Saved ${savedDocs.length} file(s) from email: ${message.subject ?? ''}`.slice(0, 250),
        owner: user.displayName ?? user.email,
        due: '',
        status: 'DONE',
      }).catch(() => {});
    }

    await writeAudit({
      tenantId: user.tenantId,
      matterId: body.matterId,
      actorUserId: user.userId,
      actionType: 'EMAIL_SAVED_TO_MATTER',
      actionStatus: 'SUCCESS',
      payload: { graphThreadId, messageId: body.messageId, count: savedDocs.length },
    });

    return ok({ savedDocs });
  } catch (error) {
    return fail(error);
  }
}
