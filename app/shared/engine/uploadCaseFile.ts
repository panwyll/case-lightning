/**
 * Upload a file onto a case. Small files go in the request; anything over ~3 MB goes straight to
 * storage (the web server refuses a request over 4.5 MB, and a file travels as base64, a third
 * larger), then the server reads and routes it the same way.
 */
import type { Api } from './types';

const DIRECT_OVER = 3 * 1024 * 1024;

const b64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export async function uploadCaseFile<T = { documentId: string }>(api: Api, matterId: string, file: File, routing: Record<string, unknown> = {}): Promise<T> {
  if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} is over 25 MB.`);
  const meta = { fileName: file.name, mimeType: file.type || 'application/octet-stream', ...routing };
  if (file.size > DIRECT_OVER) {
    const start = await api<{ documentId: string | null; uploadUrl: string | null }>(`/matters/${matterId}/engine/upload/start`, { method: 'POST', body: JSON.stringify({ ...meta, size: file.size }) });
    if (start.documentId && start.uploadUrl) {
      const put = await fetch(start.uploadUrl, { method: 'PUT', headers: { 'content-type': meta.mimeType, 'x-upsert': 'true' }, body: file });
      if (!put.ok) throw new Error(`The upload to storage failed (${put.status}).`);
      return api<T>(`/matters/${matterId}/engine/upload/finish`, { method: 'POST', body: JSON.stringify({ ...meta, documentId: start.documentId }) });
    }
  }
  return api<T>(`/matters/${matterId}/engine/upload`, { method: 'POST', body: JSON.stringify({ ...meta, base64: await b64(file) }) });
}
