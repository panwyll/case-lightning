/**
 * Protecting files we send. Any file (a .docx letter, a PDF) goes inside one AES-256
 * password-protected zip; the password travels separately — WhatsApp where the client has
 * opted in, otherwise its own message — and both are on the case's log. The password is
 * generated per send, said once, and not kept.
 */
import { generatePassword } from './pdf-lock';
import { clientComms } from './comms/adapters';

export interface ProtectedBundle { fileName: string; buffer: Buffer; contentType: string; password: string; inside: string[] }

export async function protectFiles(files: Array<{ fileName: string; buffer: Buffer }>, bundleName = 'documents.zip'): Promise<ProtectedBundle> {
  const zip = await import('@zip.js/zip.js');
  const password = generatePassword();
  const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter(), { password, encryptionStrength: 3 });
  for (const f of files) await writer.add(f.fileName, new zip.Uint8ArrayReader(new Uint8Array(f.buffer)));
  const bytes = await writer.close();
  return { fileName: bundleName, buffer: Buffer.from(bytes), contentType: 'application/zip', password, inside: files.map((f) => f.fileName) };
}

/** Tell the client the password, on a different channel from the file. Throws when there is no channel; the caller holds the send. */
export async function sendFilePassword(tenantId: string, matterId: string, bundle: ProtectedBundle): Promise<{ channel: string; messageId: string | null }> {
  return clientComms().sendStatusUpdate({ tenantId, matterId, template: 'file_password', context: { fileName: bundle.fileName, password: bundle.password, inside: bundle.inside.join(', ') } });
}
