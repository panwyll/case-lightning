/** A case opened in CONVEYi, created in InTouch by the firm's own data markers; off until the required ones are set. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markersReady, matterData } from '../../../lib/server/integrations/intouch/case-system';

const c = { matterId: 'm', reference: 'CL-0042', propertyAddress: '14 Oak Street, Leeds LS1 2AB', postcode: 'LS1 2AB', side: 'purchase' as const, clientNames: ['Ann Smith', 'Ben Smith'], clientEmail: 'ann@example.test', feeEarnerName: 'Pat Lee', feeEarnerEmail: 'pat@firm.test' };

test('off until reference, client name and address markers are all filled in', () => {
  assert.equal(markersReady({}), false);
  assert.equal(markersReady({ reference: 'matter.reference', clientName: 'client.name' }), false);
  assert.equal(markersReady({ reference: 'matter.reference', clientName: 'client.name', address: '  ' }), false);
  assert.equal(markersReady({ reference: 'matter.reference', clientName: 'client.name', address: 'property.address' }), true);
});

test('InTouch is sent each filled-in marker with the case value, and the template where set', () => {
  const data = matterData(c, { reference: 'matter.firmReference', clientName: 'client.name', address: 'property.address', postcode: 'property.postcode', feeEarner: 'matter.feeEarner', template: { marker: 'matter.template', value: 'Residential Purchase' } });
  assert.deepEqual(data, {
    'matter.firmReference': 'CL-0042', 'client.name': 'Ann Smith & Ben Smith', 'property.address': '14 Oak Street, Leeds LS1 2AB', 'property.postcode': 'LS1 2AB', 'matter.feeEarner': 'pat@firm.test', 'matter.template': 'Residential Purchase',
  });
  // A field with no marker is not sent at all.
  assert.equal(Object.keys(matterData(c, { reference: 'r', clientName: 'n', address: 'a' })).length, 3);
});
