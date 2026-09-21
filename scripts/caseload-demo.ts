/**
 * Seed a realistic BOOK OF WORK so the caseload map can be seen the way a conveyancer
 * sees it — fifty-odd matters, most of them fine, a handful that need someone today.
 *
 *   npm run caseload:demo
 *
 * Every matter is driven through the real engine with a controllable clock, so the
 * health you see is computed, not painted: a wait that is genuinely 14 working days old
 * is what makes a house go orange. Matters are assigned to Alice in the demo tenant.
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
    } catch { /* optional */ }
  }
}

/** Deterministic RNG so a re-seed produces the same book of work. */
function rng(seed: number) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

const STREETS = ['Oak Street', 'Mill Lane', 'Church Road', 'Riverside Court', 'Elm Close', 'Ash Grove', 'Birch Way', 'Cedar Avenue', 'Harbour View', 'Kings Meadow', 'Priory Gardens', 'Station Road', 'The Limes', 'Weavers Yard', 'Orchard Rise', 'Bramble Close', 'Foundry Walk', 'Tanners Row', 'Sheep Street', 'Castle Hill'];
const TOWNS = ['Reading RG1', 'Henley-on-Thames RG9', 'Caversham RG4', 'Wokingham RG41', 'Twyford RG10', 'Marlow SL7'];
const NAMES = ['Priya Shah', 'Daniel Okafor', 'Sam Lee', 'Hannah Reid', 'Marcus Webb', 'Aisha Rahman', 'Tom Fletcher', 'Grace Muturi', 'Owen Pryce', 'Lena Kowalski', 'Ravi Nair', 'Beth Sutton'];

async function main() {
  await loadEnv();
  const { query, queryOne, pool, runAsSystem } = await import('../lib/server/db');
  const { config } = await import('../lib/server/config');
  const { signSession } = await import('../lib/server/session');
  const { EngineService } = await import('../lib/server/engine/service');
  const { PgEventStore } = await import('../lib/server/engine/store');
  const { productionPorts } = await import('../lib/server/engine/adapters');
  const { textPdf } = await import('../lib/server/engine/text-pdf');

  const tenant = await runAsSystem(async () => {
    const t = await queryOne<{ id: string }>(`select id from tenant where name = 'Demo Conveyancing LLP'`);
    return t ? t.id : (await queryOne<{ id: string }>(`insert into tenant (name) values ('Demo Conveyancing LLP') returning id`))!.id;
  });
  const alice = (await queryOne<{ id: string }>(`select id from app_user where tenant_id = $1 and email = 'alice@demo-conveyancing.co.uk'`, [tenant]))?.id
    ?? (await queryOne<{ id: string }>(`insert into app_user (tenant_id, entra_object_id, email, display_name, role) values ($1,'demo-alice','alice@demo-conveyancing.co.uk','Alice Okafor','ADMIN') returning id`, [tenant]))!.id;

  let clock = new Date();
  const ports = { ...productionPorts(), now: () => clock, newId: () => crypto.randomUUID(), log: () => {} };
  const svc = new EngineService(new PgEventStore(), ports);
  const tick = (days: number) => (clock = new Date(clock.getTime() + days * 86_400_000));

  const doc = async (matterId: string, fileName: string, docType: string, facts: unknown) => {
    const bytes = textPdf([fileName, '='.repeat(fileName.length), `Date: ${clock.toISOString().slice(0, 10)}`], { title: fileName });
    const d = await queryOne<{ id: string }>(
      `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, hash_sha256, doc_type, extracted_facts, extraction_confidence, created_by)
       values ($1,$2,'ENGINE_UPLOAD',$3,$4,'application/pdf',$5,$6,$7,$8::jsonb,0.97,$9) returning id`,
      [tenant, matterId, `engine-upload://${matterId}/${fileName}`, fileName, bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'), docType, JSON.stringify(facts), alice]
    );
    await query(`insert into document_blob (document_id, tenant_id, bytes) values ($1,$2,$3)`, [d!.id, tenant, bytes]);
    return d!.id;
  };
  const idClear = { provider: 'demo-id', outcome: 'clear', flags: [], confidence: 0.98 };
  const searchClear = (t: string) => ({ searchType: t, flags: [{ code: 'NOTE', severity: 'info', description: 'Nothing adverse', locator: { page: 1 } }], confidence: 0.95 });
  const titleClear = { titleNumber: `BK${Math.floor(Math.random() * 900000 + 100000)}`, tenure: 'freehold', restrictions: [], charges: [], covenants: [], confidence: 0.97 };

  // A re-seed RETIRES the previous demo book rather than deleting it: the event log is
  // append-only by design (a database trigger refuses DELETE), so old demo matters are
  // closed off and their engine state marked finished, which takes them off the caseload.
  await runAsSystem(async () => {
    const old = await query<{ id: string }>(`select id from matter where tenant_id = $1 and matter_ref like 'CL-%' and status <> 'CLOSED'`, [tenant]);
    if (!old.length) return;
    const ids = old.map((m) => m.id);
    await query(`update matter_engine_state set finished_at = now() where matter_id = any($1::uuid[]) and finished_at is null`, [ids]);
    await query(`update matter set status = 'CLOSED', updated_at = now() where id = any($1::uuid[])`, [ids]);
    console.log(`retired ${ids.length} matters from the previous seed`);
  });
  /** A person looks at whatever the rules flagged and accepts it, so the recipe can move on. */
  const approveAll = async (id: string, kinds: string[]) => {
    const st = await svc.getState(tenant, id);
    for (const d of Object.values(st.decisions).filter((x) => x.status === 'pending' && kinds.includes(x.kind))) {
      await svc.openDecisionSource(tenant, id, d.eventId, alice);
      await svc.resolveDecision(tenant, id, d.eventId, alice, 'approve', 'reviewed — acceptable');
    }
  };

  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  const r = rng(20260921);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];

  // The shape of the book: how far each matter has got, and what is wrong with it.
  type Recipe = 'instructed' | 'instructed_stale' | 'searches' | 'searches_overdue' | 'searches_escalated' | 'title' | 'title_blocked' | 'ready' | 'exchanged' | 'completed' | 'critical_offer' | 'sale' | 'remortgage';
  const BOOK: Recipe[] = [
    ...Array(6).fill('instructed'), 'instructed_stale',
    ...Array(11).fill('searches'), 'searches_overdue', 'searches_overdue', 'searches_escalated',
    ...Array(7).fill('title'), 'title_blocked', 'title_blocked',
    ...Array(5).fill('ready'), 'critical_offer',
    ...Array(5).fill('exchanged'),
    ...Array(4).fill('completed'),
    ...Array(3).fill('sale'), 'remortgage', 'remortgage',
  ];

  const made: string[] = [];
  for (let n = 0; n < BOOK.length; n++) {
    const recipe = BOOK[n];
    const address = `${Math.floor(r() * 90) + 1} ${pick(STREETS)}, ${pick(TOWNS)}`;
    const client = pick(NAMES);
    const shallow = recipe === 'searches' || recipe === 'searches_overdue' || recipe === 'title';
    const type = recipe === 'sale' ? 'freehold_sale' : recipe === 'remortgage' ? 'remortgage' : shallow && r() < 0.25 ? 'leasehold_purchase' : 'freehold_purchase';
    const id = (await queryOne<{ id: string }>(
      `insert into matter (tenant_id, matter_ref, property_address, buyer_names, seller_names, lender, status, stage, track, created_by, assigned_to, purchase_price, completion_target_date)
       values ($1,$2,$3,$4,'{The Vendors}',$5,'OPEN','INSTRUCTION',$6,$7,$7,$8, current_date + ($9::int)) returning id`,
      [tenant, `CL-${stamp}-${String(n + 1).padStart(3, '0')}`, address, [client], recipe === 'sale' ? null : 'Mock Building Society', recipe === 'sale' ? 'SALE' : 'PURCHASE', alice, `£${(Math.floor(r() * 600) + 180)},000`, Math.floor(r() * 70) + 20]
    ))!.id;
    made.push(id);

    // Wind the clock back to when this matter was instructed, then play it forward.
    // The age is the length of the recipe plus a short tail, so a matter that is moving
    // normally ARRIVES at its current state recently — otherwise every case would look
    // stalled, which is exactly the false alarm the health model exists to avoid.
    const AGE: Record<Recipe, number> = {
      instructed: Math.floor(r() * 3) + 1,
      instructed_stale: 45,          // the ID check has sat with the client for six weeks
      searches: Math.floor(r() * 5) + 6,
      searches_overdue: 20,          // past the chase point, not yet escalated
      searches_escalated: 40,        // chased, escalated, still nothing
      title: Math.floor(r() * 5) + 12,
      title_blocked: Math.floor(r() * 4) + 15,
      ready: Math.floor(r() * 5) + 16,
      critical_offer: 18,
      exchanged: Math.floor(r() * 6) + 19,
      completed: Math.floor(r() * 6) + 29,
      sale: Math.floor(r() * 4) + 10,
      remortgage: Math.floor(r() * 4) + 6,
    };
    const ageDays = AGE[recipe];
    clock = new Date(Date.now() - ageDays * 86_400_000);

    const lender = recipe !== 'sale';
    await svc.run(tenant, id, { type: 'enrol', actor: alice, transactionType: type as never, hasLender: lender, hasExistingMortgage: recipe === 'sale' || recipe === 'remortgage', requireProofOfFunds: false, requireExchangeAuthority: false, targetCompletionDate: new Date(Date.now() + (Math.floor(r() * 60) + 20) * 86_400_000).toISOString().slice(0, 10) });

    if (recipe === 'instructed') { await svc.requestIdCheck(tenant, id, alice); continue; }
    if (recipe === 'instructed_stale') { tick(2); await svc.requestIdCheck(tenant, id, alice); continue; } // the ID check has sat for six weeks

    tick(1);
    await svc.requestIdCheck(tenant, id, alice);
    tick(1);
    await svc.idCheckResultReceived(tenant, id, await doc(id, 'id-aml.pdf', 'ID_CHECK_REPORT', idClear));

    if (recipe === 'sale') {
      tick(2);
      await svc.run(tenant, id, { type: 'request_property_forms', actor: alice });
      if (r() < 0.6) { tick(4); await svc.run(tenant, id, { type: 'property_forms_received', actor: alice, forms: ['TA6', 'TA10'] }); await svc.titleReceived(tenant, id, await doc(id, 'title.pdf', 'TITLE_REGISTER', titleClear)); tick(1); await svc.run(tenant, id, { type: 'contract_pack_sent', actor: alice }); }
      continue;
    }
    if (recipe === 'remortgage') {
      tick(3);
      await svc.titleReceived(tenant, id, await doc(id, 'title.pdf', 'TITLE_REGISTER', titleClear));
      await svc.run(tenant, id, { type: 'request_redemption_statement', actor: alice, lender: 'Old Lender plc' });
      continue;
    }

    // Purchases: searches are auto-ordered on entry to pre-contract.
    const state = await svc.getState(tenant, id);
    const searches = state.requiredSearches;
    if (recipe === 'searches') {
      tick(3);
      for (const t of searches.slice(0, Math.max(1, Math.floor(r() * searches.length) + 1))) await svc.searchReturned(tenant, id, t, await doc(id, `${t}.pdf`, 'SEARCH_RESULT', searchClear(t)));
      continue;
    }
    if (recipe === 'searches_overdue') { tick(4); await svc.searchReturned(tenant, id, searches[0], await doc(id, 'search.pdf', 'SEARCH_RESULT', searchClear(searches[0]))); continue; }
    if (recipe === 'searches_escalated') { clock = new Date(); await svc.tick(tenant, id); continue; } // the timer chases and escalates for real

    // Everything past pre-contract: clear the searches, then the title.
    tick(6);
    for (const t of searches) await svc.searchReturned(tenant, id, t, await doc(id, `${t}.pdf`, 'SEARCH_RESULT', searchClear(t)));
    if (lender) { tick(1); await svc.mortgageOfferReceived(tenant, id, await doc(id, 'offer.pdf', 'MORTGAGE_OFFER', { lender: 'Mock Building Society', amountPennies: 25_000_000, expiryDate: new Date(Date.now() + (recipe === 'critical_offer' ? 4 : 120) * 86_400_000).toISOString().slice(0, 10), conditions: [{ code: 'STD1', text: 'Buildings insurance on completion', standard: true }], confidence: 0.97 })); }
    tick(2);
    await svc.titleReceived(tenant, id, await doc(id, 'title.pdf', 'TITLE_REGISTER', titleClear));

    if (recipe === 'title') continue;
    if (recipe === 'title_blocked') {
      tick(3);
      await svc.run(tenant, id, { type: 'raise_issue', actor: alice, kind: 'title_defect', title: 'Restriction in the register requires a certificate of compliance on transfer', gate: 'exchange', detail: 'Form N restriction in favour of the management company.' });
      continue;
    }

    // Report on title → ready to exchange. Anything the rules flagged on the way is
    // looked at first (an offer near expiry flags, and would otherwise hold the phase).
    await approveAll(id, ['search', 'mortgage', 'title', 'enquiry', 'management_pack']);
    tick(2);
    await svc.draftReportOnTitle(tenant, id);
    await approveAll(id, ['report_on_title']);
    await svc.sendReportOnTitle(tenant, id, alice);
    tick(2);
    await svc.run(tenant, id, { type: 'deposit_received', actor: alice });
    if (recipe === 'ready' || recipe === 'critical_offer') continue;

    tick(3);
    const completionDate = new Date(clock.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
    await svc.run(tenant, id, { type: 'contracts_exchanged', actor: alice, completionDate });
    await svc.run(tenant, id, { type: 'completion_statement_generated', actor: alice });
    if (recipe === 'exchanged') continue;

    tick(10);
    const bd = crypto.randomUUID();
    await svc.recordBankDetails(tenant, id, { actor: alice, payeeKind: 'firm_client_account', payeeRef: 'Our client account', details: { sortCode: '401234', accountNumber: '99990000', accountName: 'Demo Conveyancing Client Account', firmName: 'Demo Conveyancing LLP' }, sourceChannel: 'letter' });
    let s3 = await svc.getState(tenant, id);
    for (const d of Object.values(s3.decisions).filter((x) => x.kind === 'bank_details' && x.status === 'pending')) {
      await svc.openDecisionSource(tenant, id, d.eventId, alice);
      await svc.resolveDecision(tenant, id, d.eventId, alice, 'verify', 'called back on a known number', { method: 'phone_callback_known_number' });
    }
    s3 = await svc.getState(tenant, id);
    const firm = Object.values(s3.bankDetails).find((b) => b.payeeKind === 'firm_client_account' && b.status === 'verified');
    if (firm) {
      await svc.run(tenant, id, { type: 'funds_requested', actor: alice, fromRole: lender ? 'lender' : 'client', bankDetailsId: firm.id });
      await svc.run(tenant, id, { type: 'funds_received', actor: alice, fromRole: lender ? 'lender' : 'client' });
    }
    await svc.recordBankDetails(tenant, id, { actor: alice, payeeKind: 'seller_solicitor', payeeRef: 'Bartlett & Co', details: { sortCode: '203045', accountNumber: '55556666', accountName: 'Bartlett & Co Client Account', firmName: 'Bartlett & Co' }, sourceChannel: 'letter' });
    s3 = await svc.getState(tenant, id);
    for (const d of Object.values(s3.decisions).filter((x) => x.kind === 'bank_details' && x.status === 'pending')) {
      await svc.openDecisionSource(tenant, id, d.eventId, alice);
      await svc.resolveDecision(tenant, id, d.eventId, alice, 'verify', 'Lawyer Checker match', { method: 'lawyer_checker_match', reference: `LC-${bd.slice(0, 8)}` });
    }
    s3 = await svc.getState(tenant, id);
    const seller = Object.values(s3.bankDetails).find((b) => b.payeeKind === 'seller_solicitor' && b.status === 'verified');
    if (seller) {
      await svc.run(tenant, id, { type: 'payment_authorised', actor: alice, payeeKind: 'seller_solicitor', bankDetailsId: seller.id, purpose: 'completion_monies' });
      await svc.run(tenant, id, { type: 'completion_confirmed', actor: alice });
      tick(1);
      await svc.run(tenant, id, { type: 'sdlt_submitted', actor: alice, reference: 'SDLT-DEMO' });
      await svc.run(tenant, id, { type: 'ap1_submitted', actor: alice, reference: 'AP1-DEMO' });
    }
  }

  // Let the timers catch up on everything, as the cron would have.
  clock = new Date();
  for (const id of made) await svc.tick(tenant, id).catch(() => {});

  const cookie = config.sessionJwtSecret ? await signSession(alice) : null;
  console.log(`\nSeeded ${made.length} matters for Alice in Demo Conveyancing LLP (tenant ${tenant}).`);
  console.log(`  Caseload map: ${config.appUrl}/cases`);
  console.log(`  My work:      ${config.appUrl}/my-work`);
  if (cookie) console.log(`\nSession cookie (Alice):  cl_session=${cookie}`);
  await pool().end();
}

main().catch((e) => { console.error(e); process.exit(1); });
