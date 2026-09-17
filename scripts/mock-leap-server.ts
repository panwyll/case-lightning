/**
 * A stand-in LEAP for local development and the demo.
 *
 *   npm run leap:mock            # serves the endpoint map on http://127.0.0.1:4010
 *
 * Then point the app at it and connect from /integrations/leap:
 *   LEAP_AUTH_BASE_URL=http://127.0.0.1:4010  LEAP_API_BASE_URL=http://127.0.0.1:4010
 *   LEAP_CLIENT_ID=demo  LEAP_CLIENT_SECRET=demo  LEAP_API_KEY=demo-key  LEAP_WEBHOOK_SECRET=demo-whsec
 *
 * The firm is pre-seeded (two handlers, a freehold purchase with parties and searches
 * in the Searches folder, a leasehold purchase, a sale, a will). Type a line while it
 * runs to add documents and watch the webhook + engine react:
 *   doc <matterNumber> <fileName>          e.g.  doc OAK-14 "CON29R 14 Oak Street.pdf"
 *   close <matterNumber>
 */
import readline from 'node:readline';
import { MockLeapServer } from '../lib/server/integrations/leap/mock';
import { textPdf } from '../lib/server/engine/text-pdf';

async function main() {
  const port = Number(process.env.LEAP_MOCK_PORT ?? 4010);
  // LEAP_MOCK_RUN=<n> gives every seeded id and matter number a suffix, so re-running the demo mirrors fresh matters.
  const run = process.env.LEAP_MOCK_RUN ? `-${process.env.LEAP_MOCK_RUN}` : '';
  const server = new MockLeapServer({ idPrefix: run ? `r${process.env.LEAP_MOCK_RUN}` : null, clientId: process.env.LEAP_CLIENT_ID ?? 'demo', clientSecret: process.env.LEAP_CLIENT_SECRET ?? 'demo', apiKey: process.env.LEAP_API_KEY ?? 'demo-key', webhookSecret: process.env.LEAP_WEBHOOK_SECRET ?? 'demo-whsec', log: (m) => console.log(`[leap-mock] ${m}`) });
  const L = server.leap;
  const alice = { id: 'staff-alice', name: 'Alice Okafor', email: 'alice@demo-conveyancing.co.uk' };
  const bob = { id: 'staff-bob', name: 'Bob Harding', email: 'bob@demo-conveyancing.co.uk' };
  const hdr = (title: string, addr: string, ref: string) => [title, '='.repeat(title.length), `Property: ${addr}`, `Our ref: ${ref}`, ''];

  const oak = L.seedMatter({ number: `OAK-14${run}`, description: 'Purchase of 14 Oak Street', propertyAddress: '14 Oak Street, Reading, RG1 4QT', responsible: alice, completionDate: new Date(Date.now() + 70 * 86_400_000).toISOString().slice(0, 10), exchangeDate: new Date(Date.now() + 56 * 86_400_000).toISOString().slice(0, 10), purchasePrice: '£385,000' });
  L.addParty(oak.id, L.seedCard({ name: 'Priya Shah', firstName: 'Priya', lastName: 'Shah', email: 'priya.shah@example.com', phone: '447700900123' }), 'Client', 'client');
  L.addParty(oak.id, L.seedCard({ name: 'Mock Building Society', organisation: 'Mock Building Society', type: 'company', email: 'completions@mockbs.example' }), 'Mortgagee', 'lender');
  L.addParty(oak.id, L.seedCard({ name: 'Greenfield Law LLP', organisation: 'Greenfield Law LLP', type: 'company', email: 'post@greenfield-law.example' }), "Vendor's Solicitor", 'other_side_solicitor');
  L.addParty(oak.id, L.seedCard({ name: 'Hartleys Estate Agents', organisation: 'Hartleys Estate Agents', type: 'company', email: 'conveyancing@hartleys-estates.example' }), 'Estate Agent', 'agent');
  L.seedDocument(oak.id, { name: 'ID and AML report - Priya Shah.pdf', folder: 'AML', bytes: textPdf([...hdr('ELECTRONIC ID & AML CHECK', '14 Oak Street', 'OAK-14'), 'Subject: Priya Shah', 'Identity: PASS', 'PEP / sanctions: no match', 'Overall: CLEAR']) });
  L.seedDocument(oak.id, { name: 'LLC1 - 14 Oak Street.pdf', folder: 'Searches', bytes: textPdf([...hdr('OFFICIAL CERTIFICATE OF SEARCH — LLC1', '14 Oak Street', 'OAK-14'), 'Result: no entries registered.']) });
  L.seedDocument(oak.id, { name: 'CON29R - 14 Oak Street.pdf', folder: 'Searches', bytes: textPdf([...hdr('LOCAL AUTHORITY SEARCH — CON29R', '14 Oak Street', 'OAK-14'), '2.1 Roads: Oak Street — ADOPTED', '3.7 Outstanding notices: ENFORCEMENT NOTICE served 12/03/2024 re rear outbuilding — OUTSTANDING', "3.10 Conservation area: QUEEN'S ROAD CONSERVATION AREA"]) });
  L.seedDocument(oak.id, { name: 'Client care letter.docx', folder: 'Correspondence', bytes: Buffer.from('not a pdf') });

  const riv = L.seedMatter({ number: `RIV-3${run}`, description: 'Purchase of 3 Riverside Court', propertyAddress: '3 Riverside Court, Caversham, RG4 8AA', responsible: bob, completionDate: new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10) });
  L.addParty(riv.id, L.seedCard({ name: 'Hannah Reid', firstName: 'Hannah', lastName: 'Reid', email: 'reid.family@example.com' }), 'Client', 'client');
  L.addParty(riv.id, L.seedCard({ name: 'Bartlett & Co', organisation: 'Bartlett & Co', type: 'company', email: 'post@bartlett-co.example' }), "Vendor's Solicitor", 'other_side_solicitor');
  L.seedMatter({ number: `FLAT-2${run}`, description: 'Purchase of Flat 2, 9 Quay House', matterTypeId: 'mt-conv-purchase-lh', propertyAddress: 'Flat 2, 9 Quay House, Reading', responsible: alice });
  L.seedMatter({ number: `MILL-7-SALE${run}`, description: 'Sale of 7 Mill Lane', matterTypeId: 'mt-conv-sale-fh', propertyAddress: '7 Mill Lane, Henley-on-Thames', responsible: bob });
  L.seedMatter({ number: `WILL-22${run}`, description: 'Will — J Smith', matterTypeId: 'mt-wills', responsible: alice });

  const base = await server.start(port);
  console.log(`Mock LEAP listening on ${base}`);
  console.log(`  LEAP_AUTH_BASE_URL=${base} LEAP_API_BASE_URL=${base} LEAP_CLIENT_ID=${process.env.LEAP_CLIENT_ID ?? 'demo'} LEAP_CLIENT_SECRET=${process.env.LEAP_CLIENT_SECRET ?? 'demo'} LEAP_API_KEY=${process.env.LEAP_API_KEY ?? 'demo-key'} LEAP_WEBHOOK_SECRET=${process.env.LEAP_WEBHOOK_SECRET ?? 'demo-whsec'}`);
  console.log('  matters: ' + (await L.listMatters({ limit: 100 })).items.map((m) => `${m.number} (${m.id})`).join(', '));
  console.log('  commands: doc <matterNumber> <file name>   |   close <matterNumber>   |   deliveries');

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const m = line.trim().match(/^(\w+)\s*(.*)$/);
    if (!m) return;
    const all = (await L.listMatters({ limit: 1000 })).items;
    const byNumber = (n: string) => all.find((x) => x.number === n);
    if (m[1] === 'doc') {
      const [, num, ...rest] = m[2].match(/^(\S+)\s+"?(.+?)"?$/) ?? [];
      const target = num && byNumber(num);
      if (!target) return console.log('unknown matter');
      const name = rest.join(' ') || 'document.pdf';
      const d = L.seedDocument(target.id, { name, folder: /con29|llc1|drainage|environ/i.test(name) ? 'Searches' : 'Correspondence', bytes: textPdf([name, '='.repeat(name.length), 'Result: see body', '3.7 Outstanding notices: none']) });
      console.log(`added ${d.id} to ${target.number} (webhook sent to ${L.webhooks.length} subscriber(s))`);
    } else if (m[1] === 'close') {
      const target = byNumber(m[2].trim());
      if (!target) return console.log('unknown matter');
      L.updateMatter(target.id, { status: 'closed' });
      console.log(`closed ${target.number}`);
    } else if (m[1] === 'deliveries') {
      console.log(server.deliveries.slice(-10));
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
