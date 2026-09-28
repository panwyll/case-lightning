/**
 * An email attached inside an email (Outlook's "forward as attachment", an .eml or .msg file, a
 * chain saved and sent on) is opened and the files inside it are filed like any attachment. An
 * attached email inside that one is opened too, to a few levels; its own words are left to the
 * email they came in.
 */
export interface ExpandedFile { name: string; contentType: string; bytes: Buffer; isInline: boolean }
export interface ExpandResult { subject: string | null; entries: ExpandedFile[]; error?: string }

export function isAttachedEmail(name: string | null | undefined, contentType: string | null | undefined): boolean {
  return /\.(eml|msg)$/i.test(name ?? '') || /^message\/rfc822$/i.test(contentType ?? '') || /vnd\.ms-outlook/i.test(contentType ?? '');
}

const isMsg = (name: string, contentType: string, bytes: Buffer) =>
  /\.msg$/i.test(name) || /vnd\.ms-outlook/i.test(contentType) || bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));

const clean = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'attached email';

export async function expandAttachedEmail(bytes: Buffer, name: string, contentType = ''): Promise<ExpandResult> {
  try {
    if (isMsg(name, contentType, bytes)) {
      const MsgReader = (await import('@kenjiuno/msgreader')).default;
      const reader = new MsgReader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      const info = reader.getFileData();
      const entries: ExpandedFile[] = [];
      for (const a of info.attachments ?? []) {
        if (a.attachmentHidden) continue;
        const got = reader.getAttachment(a);
        const file = a.innerMsgContent ? `${clean(a.name ?? got.fileName ?? 'attached email')}.msg` : got.fileName || a.fileName || 'attachment';
        entries.push({ name: file, contentType: a.innerMsgContent ? 'application/vnd.ms-outlook' : a.attachMimeTag ?? '', bytes: Buffer.from(got.content), isInline: false });
      }
      return { subject: info.subject ?? null, entries };
    }
    const PostalMime = (await import('postal-mime')).default;
    const mail = await PostalMime.parse(bytes, { attachmentEncoding: 'arraybuffer' });
    const entries: ExpandedFile[] = (mail.attachments ?? []).map((a) => {
      const inner = /^message\/rfc822$/i.test(a.mimeType);
      const file = a.filename || (inner ? `${clean(String((a as { subject?: string }).subject ?? 'attached email'))}.eml` : 'attachment');
      const content = a.content as ArrayBuffer | Uint8Array | string;
      const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content instanceof Uint8Array ? content : new Uint8Array(content));
      return { name: inner && !/\.eml$/i.test(file) ? `${file}.eml` : file, contentType: a.mimeType, bytes: buf, isInline: a.disposition === 'inline' };
    });
    return { subject: mail.subject ?? null, entries };
  } catch (err) {
    return { subject: null, entries: [], error: `the attached email could not be opened (${(err as Error).message.slice(0, 100)})` };
  }
}
