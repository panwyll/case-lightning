/**
 * Opening a zip that arrives on a case: each file inside is filed and read like an attachment
 * in its own right. Bounded, so a hostile archive cannot exhaust the server: at most MAX_FILES
 * files and MAX_TOTAL bytes unpacked, one nested level, and system clutter (__MACOSX, dotfiles,
 * folders) skipped. An encrypted archive cannot be opened here and says so.
 */
import JSZip from 'jszip';

export const MAX_FILES = 100;
export const MAX_TOTAL = 150 * 1024 * 1024;
export const MAX_ENTRY = 50 * 1024 * 1024;

const MIME: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', txt: 'text/plain', rtf: 'application/rtf', msg: 'application/vnd.ms-outlook', eml: 'message/rfc822', zip: 'application/zip', csv: 'text/csv',
};
export const mimeFor = (name: string): string => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

export const isZip = (name: string | null | undefined, contentType: string | null | undefined, bytes: Buffer): boolean =>
  /\.zip$/i.test(name ?? '') || /zip/i.test(contentType ?? '') || (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04);

export interface ZipEntry { name: string; bytes: Buffer; contentType: string }
export interface ZipResult { entries: ZipEntry[]; skipped: Array<{ name: string; reason: string }>; error: string | null }

export async function expandZip(bytes: Buffer, depth = 0): Promise<ZipResult> {
  const out: ZipResult = { entries: [], skipped: [], error: null };
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (e) {
    const msg = (e as Error).message ?? '';
    out.error = /encrypt/i.test(msg) ? 'the archive is password-protected, which cannot be opened here; ask for the files unzipped or an unencrypted archive' : `the archive could not be opened (${msg.slice(0, 80) || 'unreadable'})`;
    return out;
  }
  let total = 0;
  for (const f of Object.values(zip.files)) {
    const base = f.name.split('/').pop() ?? f.name;
    if (f.dir || !base || f.name.startsWith('__MACOSX/') || base.startsWith('.') || /^(thumbs\.db|desktop\.ini)$/i.test(base)) continue;
    if (out.entries.length >= MAX_FILES) { out.skipped.push({ name: base, reason: `the archive has more than ${MAX_FILES} files` }); continue; }
    let data: Buffer;
    try { data = await f.async('nodebuffer'); } catch (e) {
      const msg = (e as Error).message ?? '';
      out.skipped.push({ name: base, reason: /encrypt/i.test(msg) ? 'password-protected inside the archive' : 'it could not be unpacked' });
      continue;
    }
    if (data.length > MAX_ENTRY) { out.skipped.push({ name: base, reason: 'larger than 50 MB once unpacked' }); continue; }
    if (total + data.length > MAX_TOTAL) { out.skipped.push({ name: base, reason: 'the archive unpacks to more than 150 MB' }); continue; }
    total += data.length;
    if (isZip(base, null, data)) {
      if (depth >= 1) { out.skipped.push({ name: base, reason: 'an archive inside an archive inside an archive' }); continue; }
      const inner = await expandZip(data, depth + 1);
      if (inner.error) out.skipped.push({ name: base, reason: inner.error });
      out.entries.push(...inner.entries.slice(0, Math.max(0, MAX_FILES - out.entries.length)));
      out.skipped.push(...inner.skipped);
      continue;
    }
    out.entries.push({ name: base, bytes: data, contentType: mimeFor(base) });
  }
  return out;
}
