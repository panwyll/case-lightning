import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeEach } from '../../../lib/server/engine/sandbox';

class Live {
  name = 'live';
  sent: string[] = [];
  async sendChase(i: { tenantId: string; matterId: string }) { this.sent.push(`chase:${i.matterId}`); return 'live'; }
  async sendRequest(i: { tenantId: string; matterId: string }) { this.sent.push(`request:${i.matterId}`); return 'live'; }
  async sendEnquiries(i: { tenantId: string; matterId: string }) { this.sent.push(`enquiries:${i.matterId}`); return 'live'; }
}
class Outbox {
  name = 'outbox';
  async sendChase() { return 'outbox'; }
  async sendRequest() { return 'outbox'; }
}

const pick = async <X>(_t: string, matterId: string, real: X, mock: X): Promise<X> => (matterId === 'sandbox' ? mock : real);

test('sandbox guard: every sender on the live port survives, including optional ones added later', async () => {
  const live = new Live();
  const port = routeEach(live, new Outbox() as unknown as Live, pick);
  for (const k of ['sendChase', 'sendRequest', 'sendEnquiries']) assert.equal(typeof (port as unknown as Record<string, unknown>)[k], 'function', `${k} dropped`);
  assert.equal(await port.sendRequest({ tenantId: 't', matterId: 'real' }), 'live');
  assert.equal(await port.sendEnquiries({ tenantId: 't', matterId: 'real' }), 'live');
  assert.deepEqual(live.sent, ['request:real', 'enquiries:real']);
});

test('sandbox guard: a sandbox case goes to the outbox, and never falls through to the live sender', async () => {
  const live = new Live();
  const port = routeEach(live, new Outbox() as unknown as Live, pick);
  assert.equal(await port.sendChase({ tenantId: 't', matterId: 'sandbox' }), 'outbox');
  await assert.rejects(() => port.sendEnquiries({ tenantId: 't', matterId: 'sandbox' }), /not available on a sandbox/);
  assert.deepEqual(live.sent, []);
});
