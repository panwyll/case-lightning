/** The onboarding measurement (docs/epa-categories.md): a typical week from the scans, worked by hand on one day. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMeasurement, type PersonScan, type ScanEmail } from '../../../lib/server/epa/measure';
import { DEFAULT_LEVELS } from '../../../lib/server/engine/types';

const T0 = Date.parse('2026-10-06T08:00:00Z'); // Tuesday 09:00 BST
const at = (min: number) => T0 + min * 60_000;
let id = 0;
const mail = (min: number, category: string, roles: string[], draftedMin: number | null = null): ScanEmail => ({ id: `e${++id}`, at: at(min), draftedAt: draftedMin == null ? null : at(draftedMin), category, roles });

const day = (): PersonScan => ({
  weeks: 1,
  sent: [
    mail(10, 'chaser', ['lender']), // 09:10, red: 10 minutes since the start of the day
    mail(70, 'legal_work', ['other_solicitor']), // 10:10, green: the hour before it
    mail(120, 'update_reply', ['client']), // 11:00, red: 50 minutes since, capped at 15
    mail(130, 'internal', ['colleague']), // to a colleague: not counted
  ],
  received: [
    mail(90, 'update_request', ['client']), // 10:30, read for a minute: nothing else covers 10:30-10:31
  ],
  // The report on title the firm filed at 14:30: green, three hours back in clock time (11:30), less lunch: 90 + 30.
  intouch: { live: 60, openedInWindow: 4, items: [{ at: new Date(at(330)).toISOString(), kind: 'report_on_title' }] },
});

test('green is measured from the time before legal actions; what nothing accounts for is Not Seen, never green', () => {
  const m = buildMeasurement({ people: [day()], contractedHours: 37.5, levels: DEFAULT_LEVELS })!;
  // Red: 10 (chaser) + 15 (reply) + 1 (reading the request) = 26 min. Green: 60 + 120 = 180 min.
  assert.equal(m.hours.red, 0.4);
  assert.equal(m.hours.amber, 0);
  assert.equal(m.hours.green, 3);
  // The other 2,250 - 206 minutes of the week: Not Seen.
  assert.equal(m.hours.unseen, 34.1);
  assert.equal(Math.round(m.efficiencySeen! * 1000), Math.round((180 / 206) * 1000));
  assert.deepEqual(m.lines.map((l) => [l.kind, l.times, l.avgMinutes]), [['client_any_news', 1, 16], ['lender_chasers', 1, 10]]);
  assert.deepEqual(m.received, { clientStatusRequests: 1, agentStatusRequests: 0, otherSideStatusRequests: 0, chasersReceived: 0 });
  assert.deepEqual(m.cases, { live: 60, perConveyancer: 60, openedPerWeek: 4 });
  assert.equal(m.sentPerPersonWeek, 3, 'the colleague email is not case email');
});

test("Outlook's own timing is writing; an empty firm gives nothing", () => {
  const p: PersonScan = { weeks: 1, sent: [mail(200, 'status_update', ['client'], 188)], received: [], intouch: null };
  const m = buildMeasurement({ people: [p], contractedHours: 37.5, levels: DEFAULT_LEVELS })!;
  // Drafted 12:08, sent 12:20: 12 minutes written, inside the 21-minute cap for a client update.
  assert.equal(m.lines[0].kind, 'client_updates');
  assert.equal(m.lines[0].avgMinutes, 21, 'the gap back to the start of the day, capped at three times 7, covers the writing');
  assert.equal(m.cases, null);
  assert.equal(buildMeasurement({ people: [], contractedHours: 37.5, levels: DEFAULT_LEVELS }), null);
});

import { fromInTouchItem } from '../../../lib/server/epa/taxonomy';
import { toFolderActivity } from '../../../lib/server/integrations/intouch/mapping';

test('InTouch: what the firm filed, as a kind of work; email records and calls are not work of their own', () => {
  assert.equal(fromInTouchItem({ kind: 'document', name: 'Report on Title - 12 Elm Rd.pdf' }), 'report_on_title');
  assert.equal(fromInTouchItem({ kind: 'document', name: 'Additional Enquiries' }), 'raising_enquiries');
  assert.equal(fromInTouchItem({ kind: 'document', name: 'TR1 signed.pdf' }), 'contract_and_lease_review');
  assert.equal(fromInTouchItem({ kind: 'document', name: 'Completion Statement v2' }), 'requesting_funds');
  assert.equal(fromInTouchItem({ kind: 'document', name: 'SDLT5 certificate' }), 'sdlt_return');
  assert.equal(fromInTouchItem({ kind: 'document', name: 'AP1 application' }), 'land_registry_applications');
  assert.equal(fromInTouchItem({ kind: 'document', name: 'Local search results' }), 'filing');
  assert.equal(fromInTouchItem({ kind: 'note', name: null }), 'notes_and_outcomes');
  assert.equal(fromInTouchItem({ kind: 'email', name: 'Re: completion' }), null);
  assert.equal(fromInTouchItem({ kind: 'call', name: null }), null);
});

test('InTouch folder item: kind, when, who filed it and its name', () => {
  const a = toFolderActivity({ type: 'Document', createdOn: '2026-10-06T10:00:00Z', fields: { fileName: 'Report on Title.pdf', label1: 'Reports', uploadedBy: 'Firm User' } });
  assert.deepEqual(a, { kind: 'document', at: '2026-10-06T10:00:00.000Z', byFirm: true, name: 'Report on Title.pdf · Reports' });
  assert.equal(toFolderActivity({ type: 'Email', createdOn: '2026-10-06T10:00:00Z' }).kind, 'email');
  assert.equal(toFolderActivity({ type: 'Document', createdOn: '2026-10-06T10:00:00Z', uploadedBy: 'Client' }).byFirm, false);
});

test('a reply wait runs from the email received to the next one sent on that conversation; two people waiting are two waits', async () => {
  const { replyWaits } = await import('../../../lib/server/epa/measure');
  const H = 3_600_000;
  const e = (id: string, h: number, category: string, conversationId: string | null): ScanEmail => ({ id, at: T0 + h * H, draftedAt: null, category, roles: [], conversationId });
  const waits = replyWaits({
    received: [
      e('a', 0, 'update_request', 'c1'), // client asks at 0h
      e('b', 1, 'question', 'c2'), // agent asks at 1h, at the same time as the client waits
      e('c', 2, 'other', 'c1'), // not case mail: no wait
      e('d', 3, 'enquiry', 'c3'), // never answered: left out
      e('f', 0, 'question', 'c4'), // answered after three weeks: a new subject, not a reply
    ],
    sent: [e('x', 4, 'update_reply', 'c1'), e('y', 3, 'update_reply', 'c2'), e('z', 21 * 24, 'legal_work', 'c4')],
  });
  assert.deepEqual(waits.map((w) => w / H).sort(), [2, 4]);
});
