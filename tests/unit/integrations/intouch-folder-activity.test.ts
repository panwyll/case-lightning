/** The measurement's InTouch read: what was filed on a matter since a date, newest first, or unsorted where InTouch will not sort. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InTouchHttpClient, type HttpTransport } from '../../../lib/server/integrations/intouch/client';

const TENANT = '11111111-1111-4111-8111-111111111111';
const item = (day: number, name: string, type = 'Document') => ({ guid: `g${day}`, type, createdOn: `2026-10-${String(day).padStart(2, '0')}T10:00:00Z`, fields: { fileName: name, uploadedBy: 'Firm User' } });
const respond = (body: unknown, status = 200) => ({ status, headers: {}, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) });

test('newest first: it stops at the first page reaching before the window', async () => {
  const seen: string[] = [];
  const transport: HttpTransport = async (url) => {
    seen.push(url);
    return respond({ success: true, data: { items: [item(10, 'Report on title'), item(5, 'TR1'), item(1, 'Old contract')] } });
  };
  const client = new InTouchHttpClient({ apiBaseUrl: 'https://intouch.test', apiToken: 'k', backoffMs: 1 }, TENANT, transport);
  const items = await client.folderActivity('m1', '2026-10-04T00:00:00Z');
  assert.deepEqual(items.map((i) => i.name), ['Report on title', 'TR1']);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /orderBy=createdOn/);
});

test('where InTouch will not sort the folder, it reads unsorted and keeps what falls in the window', async () => {
  const seen: string[] = [];
  const transport: HttpTransport = async (url) => {
    seen.push(url);
    if (/orderBy/.test(url)) return respond({ success: false, message: 'Bad orderBy' }, 400);
    return respond({ success: true, data: { items: [item(1, 'Old contract'), item(10, 'Report on title')] } });
  };
  const client = new InTouchHttpClient({ apiBaseUrl: 'https://intouch.test', apiToken: 'k', backoffMs: 1 }, TENANT, transport);
  const items = await client.folderActivity('m1', '2026-10-04T00:00:00Z');
  assert.deepEqual(items.map((i) => i.name), ['Report on title']);
  assert.equal(seen.filter((u) => !/orderBy/.test(u)).length, 1);
});
