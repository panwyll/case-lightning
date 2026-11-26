/** Email CONVEYi sent from someone's mailbox is not filed or read again as theirs (mail/origin.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conveyiWrote } from '../../../lib/server/mail/origin';
import { CONVEYI_ORIGIN } from '../../../lib/server/graph';

const stamped = (value: string) => ({ singleValueExtendedProperties: [{ id: CONVEYI_ORIGIN, value }] });

test('the stamp says who wrote it: CONVEYi sent it, CONVEYi drafted it, or the person wrote it', async () => {
  assert.equal(await conveyiWrote('t', stamped('sent')), 'sent');
  assert.equal(await conveyiWrote('t', stamped('draft')), 'draft');
  assert.equal(await conveyiWrote('t', { subject: 'Re: 1 Test St' }), null, 'no stamp and no message id: the person wrote it');
});
