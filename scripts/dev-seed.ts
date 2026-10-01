/**
 * Local development only: a demo firm in the local database (scripts/dev-db.sh), so every signed-in page can be
 * seen on localhost. Live cases go through the real engine; two years of finished cases (analytics) are written as
 * stored states from the analytics demo generator. Run with DATABASE_URL pointing at localhost; refuses otherwise.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

for (const file of ['.env.development.local']) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) throw new Error('dev-seed only runs against a local database.');

async function main() {
  const { query, queryOne, runAsUser, runAsSystem } = await import('../lib/server/db');
  const { engine } = await import('../lib/server/engine/adapters');
  const { initialState } = await import('../lib/server/engine/types');
  const { demoAnalyticsInput } = await import('../lib/server/analytics/demo');
  const { setPolicy } = await import('../lib/server/policy');
  const { ensurePortal } = await import('../lib/server/client-portal');

  const existing = await queryOne<{ id: string }>(`select id from tenant where name = 'Anwyll & Co (Demo)'`);
  if (existing) { console.log('Demo firm already seeded. Drop the database to start again (scripts/dev-db.sh --fresh).'); process.exit(0); }

  const tenant = (await queryOne<{ id: string }>(`insert into tenant (name, address_line1, town, postcode, phone, sra_number, website) values ('Anwyll & Co (Demo)', '1 Park Row', 'Leeds', 'LS1 5AB', '0113 496 0000', '612345', 'https://example.com') returning id`))!.id;
  const people = [
    { name: 'Peter Anwyll', email: 'peteranwyll@hotmail.com', role: 'ADMIN' },
    { name: 'Asha Patel', email: 'asha@demo.test', role: 'CONVEYANCER' },
    { name: 'Ben Carter', email: 'ben@demo.test', role: 'CONVEYANCER' },
    { name: 'Chloe Evans', email: 'chloe@demo.test', role: 'CONVEYANCER' },
  ];
  const ids: string[] = [];
  for (const p of people) ids.push((await queryOne<{ id: string }>(`insert into app_user (tenant_id, entra_object_id, email, display_name, role) values ($1, $2, $3, $4, $5) returning id`, [tenant, `local-${crypto.randomUUID()}`, p.email, p.name, p.role]))!.id);
  const [peter] = ids;

  // Two years of finished cases, for analytics: stored states only (no event history behind them).
  const demo = demoAnalyticsInput(new Date());
  const handlerOf = new Map(demo.people.map((p, i) => [p.id, ids[i % ids.length]]));
  let n = 0;
  for (const c of demo.cases.filter((x) => x.completedAt || x.abandoned)) {
    n++;
    const handler = handlerOf.get(c.handlerId ?? '') ?? peter;
    const type = c.side === 'purchase' ? (c.leasehold ? 'leasehold_purchase' : 'freehold_purchase') : c.side === 'sale' ? (c.leasehold ? 'leasehold_sale' : 'freehold_sale') : 'remortgage';
    const m = (await queryOne<{ id: string }>(
      `insert into matter (tenant_id, matter_ref, property_address, buyer_names, created_by, assigned_to, transaction_type, purchase_price, status, created_at)
       values ($1, $2, $3, $4, $5, $5, $6, $7, 'CLOSED', $8) returning id`,
      [tenant, `HIST-${String(n).padStart(4, '0')}`, `${10 + (n % 90)} History Lane, Leeds`, ['A Client'], handler, type, String(180000 + (n % 40) * 9000), c.instructedAt]
    ))!.id;
    const s = initialState(tenant, m);
    const st = {
      ...s, enrolled: true, transactionType: type, hasLender: c.side !== 'sale',
      stage: c.completedAt ? 'post_completion' : s.stage,
      stageHistory: [{ stage: 'instruction', at: c.instructedAt, seq: 1 }],
      exchange: { ...s.exchange, exchangedAt: c.exchangedAt, completionDate: c.completionDate },
      completion: { ...s.completion, confirmedAt: c.completedAt },
      abandoned: c.abandoned ? { at: c.abandoned.at, reason: c.abandoned.reason, detail: null, stage: 'pre_contract' } : null,
      waits: c.waits.map((w, i) => ({ key: w.key, subject: '', openedAt: w.openedAt, openedBySeq: i + 2, closedAt: w.closedAt ?? c.completedAt ?? c.abandoned?.at ?? null, chasesSentAt: w.chases })),
      decisions: Object.fromEntries(c.decisions.filter((d) => d.resolvedAt).map((d, i) => [`hist-${n}-${i}`, { kind: d.kind, eventId: `hist-${n}-${i}`, seq: i + 2, createdAt: d.createdAt, status: 'resolved', openedBy: [], resolvedBy: handler, resolvedAt: d.resolvedAt, resolution: 'approve', resolutionEventId: null, note: null, subject: null, origin: null, title: 'Reviewed', summary: '' }])),
    };
    await query(`insert into matter_engine_state (matter_id, tenant_id, stage, last_seq, state, finished_at) values ($1, $2, $3, 1, $4::jsonb, $5)`, [m, tenant, st.stage, JSON.stringify(st), c.completedAt ?? c.abandoned!.at]);
    for (const f of demo.feedback.filter((x) => x.matterId === c.id)) {
      await query(`insert into client_feedback (tenant_id, matter_id, milestone, kind, score, comment, handler_id, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing`, [tenant, m, f.kind === 'nps' ? 'completed' : 'exchanged', f.kind, f.score, f.comment, handler, f.at]);
    }
  }

  // Live cases through the real engine, as their handler.
  const live = [
    { ref: 'DEMO-001', address: '14 Oak Street, Leeds LS1 2AB', client: 'Priya Shah', email: 'priya@demo.test', type: 'freehold_purchase', price: '£325,000', lender: true, by: 1 },
    { ref: 'DEMO-002', address: '7 Mill Lane, Harrogate HG1 4QT', client: 'Tom Hughes', email: 'tom@demo.test', type: 'freehold_sale', price: '£410,000', lender: false, by: 2 },
    { ref: 'DEMO-003', address: 'Flat 3, 22 Wharf Road, Leeds LS10 1PS', client: 'Grace Lee', email: 'grace@demo.test', type: 'leasehold_purchase', price: '£215,000', lender: true, by: 3 },
    { ref: 'DEMO-004', address: '91 Station Road, York YO24 1AB', client: 'Sam Patel', email: 'sam@demo.test', type: 'remortgage', price: '', lender: true, by: 0 },
  ];
  const svc = engine();
  let portalUrl = '';
  for (const c of live) {
    const handler = ids[c.by];
    const m = (await queryOne<{ id: string }>(`insert into matter (tenant_id, matter_ref, property_address, buyer_names, created_by, assigned_to, transaction_type, purchase_price) values ($1, $2, $3, $4, $5, $5, $6, $7) returning id`, [tenant, c.ref, c.address, [c.client], handler, c.type, c.price || null]))!.id;
    await query(`insert into matter_contact (tenant_id, matter_id, email, name, role) values ($1, $2, $3, $4, 'CLIENT')`, [tenant, m, c.email, c.client]);
    await runAsUser(handler, () => svc.run(tenant, m, { type: 'enrol', actor: handler, transactionType: c.type as never, hasLender: c.lender, requiredSearches: c.type.endsWith('purchase') ? ['LLC1', 'CON29', 'DRAINAGE_WATER', 'ENVIRONMENTAL'] : [], partyNames: [c.client] })).catch((e) => console.error(`enrol ${c.ref}:`, (e as Error).message));
    const url = await runAsSystem(() => ensurePortal(tenant, m));
    if (!portalUrl) portalUrl = url;
  }

  await setPolicy(tenant, 'analyticsTargets', { monthlyCompletions: 24, perPerson: Object.fromEntries(ids.slice(1).map((id) => [id, 6])) }, peter);
  await setPolicy(tenant, 'feeScale', { purchase: [{ upTo: 250000, fee: 950 }, { upTo: null, fee: 1250 }], sale: [{ upTo: null, fee: 995 }], remortgage: [{ upTo: null, fee: 450 }], transfer: [{ upTo: null, fee: 650 }], extras: [{ id: 'id', label: 'ID Check', fee: 15, when: 'each_id_check', sides: [] }, { id: 'lh', label: 'Leasehold Supplement', fee: 350, when: 'leasehold', sides: [] }, { id: 'ln', label: 'Acting For Your Lender', fee: 150, when: 'mortgage', sides: ['purchase', 'remortgage'] }] }, peter);

  console.log(`Seeded "Anwyll & Co (Demo)": ${people.length} people, ${n} finished cases, ${live.length} live cases.`);
  console.log('Sign in:  http://localhost:3000/api/v1/dev/sign-in');
  console.log(`A client portal: ${portalUrl}  (the code is printed on the page in development)`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
