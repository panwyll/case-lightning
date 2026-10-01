/**
 * The register read in full (class of title, notices, proprietors) and what it means; seller-impersonation red flags
 * on a purchase; joint clients each authorising exchange, and a conflict when they disagree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleFindings, sellerIdentityRisk } from '../../../lib/server/engine/findings';
import { decide, type Command } from '../../../lib/server/engine/machine';
import { applyEvent } from '../../../lib/server/engine/projection';
import { initialState, type EngineEvent, type MatterState, type TitleFacts } from '../../../lib/server/engine/types';
import { TENANT, MATTER, USER } from './helpers';

const title = (over: Partial<TitleFacts>): TitleFacts => ({ titleNumber: 'AB1', tenure: 'freehold', restrictions: [], charges: [], covenants: [], confidence: 0.95, ...over });
const buyer = { side: 'buyer' as const, hasLender: true };

test('possessory title is a critical defect; good leasehold needs the lender; notices are read; Form A with one proprietor needs a second trustee', () => {
  const kinds = (t: TitleFacts) => titleFindings(t, buyer).map((f) => `${f.kind}:${f.severity}`);
  assert.deepEqual(kinds(title({ titleClass: 'possessory' })), ['title_defect:critical']);
  assert.deepEqual(kinds(title({ titleClass: 'good_leasehold' })), ['lender_approval:warning']);
  assert.deepEqual(kinds(title({ notices: [{ code: 'N1', text: 'Unilateral notice in respect of an option in favour of Acme Land Ltd' }, { code: 'N2', text: 'Agreed notice of a deed of variation dated 2019' }] })), ['title_defect:warning', 'third_party_encumbrance:warning']);
  const formA = title({ proprietors: ['Mary Jones'], restrictions: [{ code: 'A', text: 'No disposition by a sole proprietor of the registered estate under which capital money arises is to be registered' }] });
  assert.match(titleFindings(formA, buyer).map((f) => f.title).join(' | '), /only one proprietor: two trustees/);
});

test('seller impersonation red flags: unencumbered, owner elsewhere or abroad, owned for years', () => {
  assert.equal(sellerIdentityRisk(title({ propertyDescription: '12 Oak Road, Leeds LS1 2AB', proprietorAddresses: ['12 Oak Road, Leeds LS1 2AB'] })), null, 'no mortgage alone is not a pattern');
  const risky = sellerIdentityRisk(title({ propertyDescription: '12 Oak Road, Leeds LS1 2AB', proprietorAddresses: ['Calle Mayor 4, Marbella, Spain'], proprietorSince: '2003-05-01' }))!;
  assert.match(risky.title, /no mortgage on the title, the owner's address for service is not the property, the owner gives an address abroad, owned since 2003/);
  assert.equal(risky.kind, 'seller_identity_risk');
});

test('joint clients each authorise exchange; one withdrawing while the other authorises is a conflict that holds exchange', () => {
  let s: MatterState = { ...initialState(TENANT, MATTER), enrolled: true, transactionType: 'freehold_purchase', stage: 'pre_exchange', requireExchangeAuthority: true, parties: 2, partyNames: ['Asha Patel', 'Ben Carter'] };
  let seq = 0;
  const run = (cmd: Record<string, unknown>) => { const { events } = decide(s, { actor: USER, ...cmd } as unknown as Command, { now: new Date('2026-10-01T10:00:00Z') }); s = events.map((e) => ({ ...e, id: `e${++seq}`, seq, tenantId: TENANT, matterId: MATTER, createdAt: '2026-10-01T10:00:00Z', sourceDocumentId: e.sourceDocumentId ?? null } as unknown as EngineEvent)).reduce(applyEvent, s); };
  run({ type: 'client_decision_recorded', subject: 'exchange_authority', decision: 'authorised', party: 'Asha Patel' });
  assert.equal(s.clientDecisions.exchange_authority?.decision, 'not_yet', 'one of two is not authority to exchange');
  run({ type: 'client_decision_recorded', subject: 'exchange_authority', decision: 'withdrawn', party: 'Ben Carter', note: 'Ben says they have separated' });
  const conflict = Object.values(s.issues).find((i) => i.kind === 'joint_client_conflict')!;
  assert.equal(conflict.gate, 'exchange');
  assert.equal(s.clientDecisions.exchange_authority?.decision, 'withdrawn');
  run({ type: 'client_decision_recorded', subject: 'exchange_authority', decision: 'authorised', party: 'Ben Carter' });
  assert.equal(s.clientDecisions.exchange_authority?.decision, 'authorised');
});
