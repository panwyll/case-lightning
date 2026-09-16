/**
 * Seed a realistic demo for the conveyancing engine and print where to look.
 *
 *   npm run engine:demo
 *
 * Creates (idempotently, under a tenant named "Demo Conveyancing LLP"):
 *   - Alice (admin/handler) and Bob (conveyancer)
 *   - 14 Oak Street — Alice's buyer matter, mid pre_contract: ID cleared, searches
 *     ordered and returning (LLC1 + drainage clear, CON29 flagged, environmental
 *     unreadable), enquiries raised (E1 answered, E2 partial → decision), mortgage
 *     offer with a retention → decision. Three decisions waiting.
 *   - 14 Oak Street (sale) — Bob's seller matter, linked as the INTERNAL counterparty,
 *     so the ethical wall can be shown.
 *   - 7 Mill Lane — Alice's cash purchase at contract_review with an AI-drafted report
 *     on title awaiting approval, and an unanswered enquiry old enough to have been
 *     chased and escalated by the timer.
 * Documents are real PDFs (document_blob) carrying pre-extracted facts, so the demo
 * runs without a model key; with ANTHROPIC_API_KEY the same PDFs go through Claude.
 * Prints session cookies for Alice and Bob for a browser or curl walkthrough.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

async function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      const raw = await fs.readFile(path.resolve(process.cwd(), file), 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch {
      /* optional */
    }
  }
}

async function main() {
  await loadEnv();
  const { query, queryOne, pool, runAsSystem } = await import('../lib/server/db');
  const { config } = await import('../lib/server/config');
  const { signSession } = await import('../lib/server/session');
  const { EngineService } = await import('../lib/server/engine/service');
  const { PgEventStore } = await import('../lib/server/engine/store');
  const { productionPorts } = await import('../lib/server/engine/adapters');
  const { setCounterparty } = await import('../lib/server/engine/counterparty');
  const { textPdf } = await import('../lib/server/engine/text-pdf');
  const { resolve } = await import('node:path');
  void resolve;

  // ── firm + people ──
  const tenant = await runAsSystem(async () => {
    const t = await queryOne<{ id: string }>(`select id from tenant where name = 'Demo Conveyancing LLP'`);
    if (t) return t.id;
    return (await queryOne<{ id: string }>(`insert into tenant (name) values ('Demo Conveyancing LLP') returning id`))!.id;
  });
  const user = async (email: string, name: string, role: string) => {
    const u = await queryOne<{ id: string }>(`select id from app_user where tenant_id = $1 and email = $2`, [tenant, email]);
    if (u) return u.id;
    return (await queryOne<{ id: string }>(`insert into app_user (tenant_id, entra_object_id, email, display_name, role) values ($1,$2,$3,$4,$5) returning id`, [tenant, `demo-${email}`, email, name, role]))!.id;
  };
  const alice = await user('alice@demo-conveyancing.co.uk', 'Alice Okafor', 'ADMIN');
  const bob = await user('bob@demo-conveyancing.co.uk', 'Bob Harding', 'CONVEYANCER');

  // Fresh matters each run (old demo matters are left untouched, so the feed keeps growing if you re-seed).
  const stamp = new Date().toISOString().slice(11, 16).replace(':', '');
  const matter = async (ref: string, address: string, handler: string, buyer: string, lender: string | null, track: string) =>
    (await queryOne<{ id: string }>(
      `insert into matter (tenant_id, matter_ref, property_address, buyer_names, seller_names, lender, status, stage, track, created_by, assigned_to, purchase_price, exchange_target_date, notes)
       values ($1,$2,$3,$4,$5,$6,'OPEN','INSTRUCTION',$7,$8,$8,$9, current_date + 56, $10) returning id`,
      [tenant, `${ref}-${stamp}`, address, [buyer], ['The Vendors'], lender, track, handler, '£385,000', `Client instructions (confidential): ${buyer} — first-time buyer, needs to complete before the school term.`]
    ))!.id;
  const contact = (matterId: string, email: string, name: string, role: string, phone?: string) =>
    query(`insert into matter_contact (tenant_id, matter_id, email, name, role, source, phone, whatsapp_opt_in) values ($1,$2,$3,$4,$5,'MANUAL',$6,$7) on conflict (matter_id, email) do nothing`, [tenant, matterId, email, name, role, phone ?? null, !!phone]);

  const A = await matter('OAK-14', '14 Oak Street, Reading, RG1 4QT', alice, 'Priya Shah', 'Mock Building Society', 'PURCHASE');
  await contact(A, 'priya.shah@example.com', 'Priya Shah', 'CLIENT', '447700900123');
  await contact(A, 'conveyancing@hartleys-estates.example', 'Hartleys Estate Agents', 'AGENT');
  await contact(A, 'completions@mockbs.example', 'Mock Building Society', 'LENDER');
  const B = await matter('OAK-14-SALE', '14 Oak Street, Reading, RG1 4QT', bob, 'Priya Shah (buyer)', null, 'SALE');
  await query(`update matter set buyer_names = '{}', seller_names = $2 where id = $1`, [B, ['Mr & Mrs Delaney']]);
  await contact(B, 'delaney@example.com', 'Mr & Mrs Delaney', 'CLIENT');
  const C = await matter('MILL-7', '7 Mill Lane, Henley-on-Thames, RG9 2BH', alice, 'Tomasz & Ewa Nowak', null, 'PURCHASE');
  await contact(C, 'nowak.family@example.com', 'Tomasz Nowak', 'CLIENT');
  await contact(C, 'post@greenfield-law.example', 'Greenfield Law LLP', 'OTHER_SIDE');

  // Internal counterparty link (different handlers → allowed; the wall now applies).
  await setCounterparty(tenant, A, { kind: 'internal', matterId: B }, alice, 'CHAIN-OAK-14');
  await setCounterparty(tenant, C, { kind: 'external', name: 'Greenfield Law LLP', email: 'post@greenfield-law.example', firm: 'Greenfield Law LLP' }, alice);

  // ── an engine with a controllable clock, so waits can be old enough to chase ──
  let clock = new Date(Date.now() - 28 * 86_400_000);
  const ports = { ...productionPorts(), now: () => clock, newId: () => crypto.randomUUID(), log: () => {} };
  const svc = new EngineService(new PgEventStore(), ports);
  const tick = (days: number) => (clock = new Date(clock.getTime() + days * 86_400_000));

  // A real PDF with pre-extracted facts (what pipeline #2 would have produced).
  const doc = async (matterId: string, fileName: string, docType: string, lines: string[], facts: unknown, confidence: number) => {
    const bytes = textPdf(lines, { title: fileName });
    const d = await queryOne<{ id: string }>(
      `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, hash_sha256, doc_type, extracted_facts, extraction_confidence, created_by)
       values ($1,$2,'ENGINE_UPLOAD',$3,$4,'application/pdf',$5,$6,$7,$8::jsonb,$9,$10) returning id`,
      [tenant, matterId, `engine-upload://${matterId}/${fileName}`, fileName, bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'), docType, JSON.stringify(facts), confidence, alice]
    );
    await query(`insert into document_blob (document_id, tenant_id, bytes) values ($1,$2,$3)`, [d!.id, tenant, bytes]);
    return d!.id;
  };
  const hdr = (title: string, addr: string, ref: string) => [title, '='.repeat(title.length), `Property: ${addr}`, `Our ref: ${ref}    Date: ${clock.toISOString().slice(0, 10)}`, ''];

  // ════ Matter A: 14 Oak Street ════
  await svc.run(tenant, A, { type: 'enrol', actor: alice, hasLender: true, targetExchangeDate: new Date(Date.now() + 56 * 86_400_000).toISOString().slice(0, 10), counterpartyType: 'internal' });
  await svc.requestIdCheck(tenant, A, alice);
  tick(1);
  await svc.idCheckResultReceived(tenant, A, await doc(A, 'id-aml-report-priya-shah.pdf', 'ID_CHECK_REPORT', [...hdr('ELECTRONIC ID & AML CHECK', '14 Oak Street', 'OAK-14'), 'Subject: Priya Shah', 'Identity: PASS (passport + address verified)', 'PEP / sanctions: no match', 'Overall: CLEAR'], { provider: 'mock-id', outcome: 'clear', flags: [], confidence: 0.99 }, 0.99));
  // → pre_contract; searches auto-ordered (mock provider)
  tick(9);
  await svc.searchReturned(tenant, A, 'LLC1', await doc(A, 'LLC1-14-oak-street.pdf', 'SEARCH_LLC1', [...hdr('OFFICIAL CERTIFICATE OF SEARCH — LLC1', '14 Oak Street, Reading', 'OAK-14'), 'Part 1  General financial charges: NONE', 'Part 2  Specific financial charges: NONE', 'Part 3  Planning charges: NONE', 'Part 4  Miscellaneous: NONE', 'Part 10 Listed buildings: NONE', '', 'Result: no entries registered.'], { searchType: 'LLC1', flags: [{ code: 'NO_ENTRIES', severity: 'info', description: 'No local land charges registered', locator: { page: 1, section: 'Result' } }], confidence: 0.97 }, 0.97));
  tick(1);
  await svc.searchReturned(tenant, A, 'DRAINAGE_WATER', await doc(A, 'CON29DW-14-oak-street.pdf', 'SEARCH_DRAINAGE_WATER', [...hdr('DRAINAGE AND WATER ENQUIRY — CON29DW', '14 Oak Street, Reading', 'OAK-14'), '1.1 Is the property connected to a public water supply?  Yes', '2.1 Is the property connected to a public foul sewer?    Yes', '3.1 Public sewer within the boundary?                    No', '4.1 Build over agreement required?                       No', '', 'No adverse entries.'], { searchType: 'DRAINAGE_WATER', flags: [{ code: 'SEWER_CONNECTED', severity: 'info', description: 'Connected to public foul sewer and water supply', locator: { page: 1, section: '1.1–2.1' } }], confidence: 0.96 }, 0.96));
  tick(2);
  await svc.searchReturned(tenant, A, 'CON29', await doc(A, 'CON29R-14-oak-street.pdf', 'SEARCH_CON29', [...hdr('LOCAL AUTHORITY SEARCH — CON29R', '14 Oak Street, Reading', 'OAK-14'), '1.1 Planning decisions: 21/01877/HOU rear single-storey extension — GRANTED 2021', '2.1 Roads: Oak Street — ADOPTED, maintainable at public expense', '3.7 Outstanding notices:', '    ENFORCEMENT NOTICE served 12/03/2024 under s.172 TCPA 1990 in respect of', '    a rear outbuilding erected without planning permission. Compliance period', '    expired 12/09/2024. Notice remains OUTSTANDING.', '3.10 Conservation area: the property is within the QUEEN\'S ROAD CONSERVATION AREA', '3.12 Tree preservation orders: none', '', 'End of replies.'], { searchType: 'CON29', flags: [{ code: 'PLANNING_ENFORCEMENT', severity: 'high', description: 'Enforcement notice served 12/03/2024 for a rear outbuilding erected without permission; compliance period expired and the notice remains outstanding', locator: { page: 1, section: '3.7', quote: 'ENFORCEMENT NOTICE served 12/03/2024 … remains OUTSTANDING' } }, { code: 'CONSERVATION_AREA', severity: 'low', description: "Property lies within the Queen's Road conservation area", locator: { page: 1, section: '3.10' } }, { code: 'ROAD_ADOPTED', severity: 'info', description: 'Oak Street is adopted', locator: { page: 1, section: '2.1' } }], confidence: 0.94 }, 0.94));
  tick(1);
  await svc.searchReturned(tenant, A, 'ENVIRONMENTAL', await doc(A, 'enviro-14-oak-street-SCAN.pdf', 'SEARCH_ENVIRONMENTAL', [...hdr('ENVIRONMENTAL SEARCH (scanned copy — poor quality)', '14 Oak Street, Reading', 'OAK-14'), '[page 1 mostly illegible in scan]', 'Flood risk: ri?er ?lood — [illegible]', 'Contaminated land: [illegible]', 'Ground stability: [illegible]', 'Radon: below action level'], { searchType: 'ENVIRONMENTAL', flags: [], confidence: 0.45 }, 0.45));
  // enquiries
  await svc.run(tenant, A, { type: 'raise_enquiry', actor: alice, enquiryId: 'E1', subject: 'Boundary fence ownership (east side)' });
  await svc.run(tenant, A, { type: 'raise_enquiry', actor: alice, enquiryId: 'E2', subject: 'Building regulations completion certificate for the 2021 extension' });
  tick(6);
  await svc.enquiryReplyReceived(tenant, A, 'E1', await doc(A, 'replies-to-enquiries-E1.pdf', 'ENQUIRY_REPLY', [...hdr('REPLIES TO ADDITIONAL ENQUIRIES', '14 Oak Street', 'OAK-14'), 'E1  Boundary fence ownership (east side)', '    Reply: The seller has maintained the east fence since purchase in 2015 and', '    understands it to be within their ownership. Deeds are silent.'], { enquiryId: 'E1', status: 'answered', issues: [], confidence: 0.95 }, 0.95));
  tick(1);
  await svc.enquiryReplyReceived(tenant, A, 'E2', await doc(A, 'replies-to-enquiries-E2.pdf', 'ENQUIRY_REPLY', [...hdr('REPLIES TO ADDITIONAL ENQUIRIES', '14 Oak Street', 'OAK-14'), 'E2  Building regulations completion certificate for the 2021 extension', '    Reply: The seller cannot locate the completion certificate. The works were', '    carried out by a reputable builder. The buyer must rely on their own survey.'], { enquiryId: 'E2', status: 'partial', issues: [{ code: 'MISSING_BUILDING_REGS', severity: 'medium', description: 'No building regulations completion certificate for the 2021 extension; seller relies on the buyer\'s survey', locator: { page: 1, section: 'E2' } }], confidence: 0.93 }, 0.93));
  tick(1);
  await svc.mortgageOfferReceived(tenant, A, await doc(A, 'mortgage-offer-mock-bs.pdf', 'MORTGAGE_OFFER', [...hdr('MORTGAGE OFFER — Mock Building Society', '14 Oak Street, Reading', 'OAK-14'), 'Borrower: Priya Shah        Loan: £308,000       Term: 30 years', `Offer expires: ${new Date(Date.now() + 70 * 86_400_000).toISOString().slice(0, 10)}`, '', 'GENERAL CONDITIONS 1–14 (standard)', '', 'SPECIAL CONDITIONS', 'SC4  A RETENTION of £5,000 will be held from the advance until a satisfactory', '     roof report and completion of the works identified in the valuation.', 'SC5  Buildings insurance to be in place from exchange.'], { lender: 'Mock Building Society', amountPennies: 30_800_000, expiryDate: new Date(Date.now() + 70 * 86_400_000).toISOString().slice(0, 10), conditions: [{ code: 'GC1-14', text: 'General conditions 1–14', standard: true }, { code: 'SC4', text: 'Retention of £5,000 until a satisfactory roof report and completion of works identified in the valuation', standard: false, locator: { page: 1, section: 'Special conditions' } }, { code: 'SC5', text: 'Buildings insurance in place from exchange', standard: true }], confidence: 0.96 }, 0.96));

  // ════ Matter C: 7 Mill Lane — further along ════
  clock = new Date(Date.now() - 40 * 86_400_000);
  await svc.run(tenant, C, { type: 'enrol', actor: alice, hasLender: false, requiredSearches: ['LLC1', 'CON29', 'DRAINAGE_WATER'], counterpartyType: 'external' });
  await svc.requestIdCheck(tenant, C, alice);
  tick(1);
  await svc.idCheckResultReceived(tenant, C, await doc(C, 'id-aml-nowak.pdf', 'ID_CHECK_REPORT', [...hdr('ELECTRONIC ID & AML CHECK', '7 Mill Lane', 'MILL-7'), 'Subjects: Tomasz Nowak, Ewa Nowak', 'Overall: CLEAR'], { provider: 'mock-id', outcome: 'clear', flags: [], confidence: 0.99 }, 0.99));
  tick(8);
  for (const t of ['LLC1', 'CON29', 'DRAINAGE_WATER'] as const) {
    await svc.searchReturned(tenant, C, t, await doc(C, `${t}-7-mill-lane.pdf`, `SEARCH_${t}`, [...hdr(`${t} SEARCH RESULT`, '7 Mill Lane', 'MILL-7'), 'No adverse entries.'], { searchType: t, flags: [], confidence: 0.96 }, 0.96));
    tick(1);
  }
  await svc.run(tenant, C, { type: 'raise_enquiry', actor: alice, enquiryId: 'E1', subject: 'Septic tank compliance with the 2020 General Binding Rules' });
  // C moves to contract_review once title arrives? No — the open enquiry E1 blocks pre_contract → keep it as the timer demo,
  // and make a second, answered set so the report can be drafted on a separate track is not possible; so: answer E1 later? We
  // want an OLD unanswered enquiry (chased + escalated) AND a report awaiting approval. Use a follow-up enquiry raised AFTER
  // the report was drafted instead: stage gate lets the draft exist at contract_review while a new enquiry is open.
  tick(2);
  await svc.enquiryReplyReceived(tenant, C, 'E1', await doc(C, 'replies-E1-7-mill-lane.pdf', 'ENQUIRY_REPLY', [...hdr('REPLIES TO ENQUIRIES', '7 Mill Lane', 'MILL-7'), 'E1 Septic tank: replaced 2021 with a package treatment plant; certificate attached.'], { enquiryId: 'E1', status: 'answered', issues: [], confidence: 0.95 }, 0.95));
  tick(1);
  await svc.titleReceived(tenant, C, await doc(C, 'official-copy-register-ON123456.pdf', 'TITLE_REGISTER', [...hdr('OFFICIAL COPY OF REGISTER OF TITLE ON123456', '7 Mill Lane', 'MILL-7'), 'A: PROPERTY REGISTER — FREEHOLD land shown edged red', '   1 (1962) A right of way on foot over the track coloured brown', 'B: PROPRIETORSHIP REGISTER — Title absolute', 'C: CHARGES REGISTER — none'], { titleNumber: 'ON123456', tenure: 'freehold', restrictions: [], charges: [], covenants: [{ code: 'A1', text: 'A right of way on foot over the track coloured brown (1962)', register: 'A', locator: { page: 1, section: 'A: Property register' } }], confidence: 0.97 }, 0.97));
  // title flagged (covenant) → Alice already reviewed it:
  let s = await svc.getState(tenant, C);
  const titleDecision = Object.values(s.decisions).find((d) => d.kind === 'title' && d.status === 'pending');
  if (titleDecision) {
    await svc.openDecisionSource(tenant, C, titleDecision.eventId, alice);
    await svc.resolveDecision(tenant, C, titleDecision.eventId, alice, 'approve', 'Pedestrian right of way over the rear track — benefits the property; report to client.');
  }
  tick(1);
  await svc.draftReportOnTitle(tenant, C); // → decision: approve the AI draft
  // An old, unanswered follow-up enquiry so the timer has something to chase.
  clock = new Date(Date.now() - 23 * 86_400_000);
  await svc.run(tenant, C, { type: 'raise_enquiry', actor: alice, enquiryId: 'E2', subject: 'Confirm the package treatment plant discharge consent' });
  clock = new Date();
  const t = await svc.tick(tenant, C); // chases + escalation on E2 (working days)

  // ── session cookies for a walkthrough ──
  const cookieA = config.sessionJwtSecret ? await signSession(alice) : null;
  const cookieB = config.sessionJwtSecret ? await signSession(bob) : null;
  s = await svc.getState(tenant, A);
  const sC = await svc.getState(tenant, C);
  console.log(`\nDemo Conveyancing LLP  (tenant ${tenant})`);
  console.log(`  Alice Okafor (admin/handler)  ${alice}`);
  console.log(`  Bob Harding  (handler, other side of 14 Oak Street)  ${bob}\n`);
  console.log(`14 Oak Street  (matter ${A})  stage ${s.stage}  pending decisions ${Object.values(s.decisions).filter((d) => d.status === 'pending').length}`);
  console.log(`  ${config.appUrl}/engine/${A}`);
  console.log(`14 Oak Street — sale (Bob)  (matter ${B})  internal counterparty of the above`);
  console.log(`7 Mill Lane  (matter ${C})  stage ${sC.stage}  pending decisions ${Object.values(sC.decisions).filter((d) => d.status === 'pending').length}  timer this run: ${t.chases} chase(s), ${t.escalations} escalation(s)`);
  console.log(`  ${config.appUrl}/engine/${C}`);
  console.log(`\nDecision feed: ${config.appUrl}/decisions`);
  if (cookieA) console.log(`\nSession cookie (Alice):  cl_session=${cookieA}`);
  if (cookieB) console.log(`Session cookie (Bob):    cl_session=${cookieB}`);
  await pool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
