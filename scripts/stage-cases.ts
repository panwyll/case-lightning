/**
 * Move a firm's EXISTING open cases to different points in the process, so the caseload,
 * the case view and the task list can be looked around with something in them.
 *
 *   npm run cases:stage -- --tenant "Firm name or id" --confirm-host <database host> [--dry-run]
 *
 * No new cases and no invented parties: only the firm's own open matters are moved, each
 * to a different stage. Where a step needs evidence the engine reads (an ID report, a
 * search result, a title register, a mortgage offer), a document named "SAMPLE — …" is
 * attached, whose text says it is a sample added for review. Every step goes through the
 * real engine, so health, waits and tasks are computed, not painted.
 *
 * Nothing leaves the building while it runs: the engine is wired here with the fixture
 * extractor, template summaries, mock search and ID providers, and mock client comms and
 * chaser, and no LEAP write-back — so no emails, chases, client updates, paid searches or
 * tasks in LEAP. The engine's event log is append-only: what this writes stays in each
 * case's history, and a case can only be closed off afterwards, not rewound.
 *
 * Refuses to run on a Vercel production environment, and only runs against the database
 * whose host you name in --confirm-host, so it cannot be pointed at the wrong one by accident.
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

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] ?? '' : null;
};

/** How far each case goes. Purchases climb the whole ladder; sales and remortgages their own. */
type Target = 'instructed' | 'id_done' | 'searches_part' | 'searches_done' | 'title' | 'ready' | 'exchanged' | 'completed';
const PURCHASE: Target[] = ['instructed', 'id_done', 'searches_part', 'searches_done', 'title', 'ready', 'exchanged', 'completed'];
/**
 * The spread across a book: most in the middle, a few at each end. `todo` leaves the last
 * thing for the conveyancer (a flagged search, a report on title to approve, source of
 * funds to sign off); `stale` means the steps happened weeks ago, so the open wait is
 * overdue and the timer chases it.
 */
interface Plan { t: Target; todo?: boolean; stale?: boolean; /** someone says the deal is in danger: the case goes Critical */ atRisk?: boolean; /** the last step was about a week ago and its task is still waiting on us: Delayed - Us */ oursLate?: boolean }
const SPREAD: Plan[] = [
  { t: 'searches_part' }, { t: 'title', todo: true }, { t: 'instructed', stale: true }, { t: 'searches_done', todo: true },
  { t: 'ready' }, { t: 'id_done' }, { t: 'exchanged' }, { t: 'searches_part', stale: true },
  { t: 'title' }, { t: 'completed' }, { t: 'searches_done' }, { t: 'ready', todo: true },
  { t: 'id_done', stale: true }, { t: 'searches_part' }, { t: 'exchanged' }, { t: 'title', stale: true },
  { t: 'searches_done', atRisk: true }, { t: 'title' }, { t: 'instructed' }, { t: 'ready', stale: true },
];
const SAMPLE_CONTRACT = (address: string | null) => ({ sellers: ['Sample seller'], buyers: ['Sample buyer'], propertyAddress: address, titleNumber: null, pricePennies: null, depositPennies: null, depositHolder: 'stakeholder', completionDate: null, chattelsPricePennies: null, vat: null, incorporatedConditions: 'Standard Conditions of Sale (5th ed.)', noticeToCompleteDays: 10, fixturesListPresent: true, specialConditions: [], indemnities: [], flags: [], confidence: 0.95 });
const describe = (p: Plan) => [p.t.replace(/_/g, ' '), p.todo ? 'with a task for you' : '', p.stale ? 'gone quiet' : '', p.atRisk ? 'deal at risk' : '', p.oursLate ? 'waiting on us for a week' : ''].filter(Boolean).join(', ');
/** --plan "searches_done,todo,ourslate": one plan for the cases not yet on the engine (others are left as they are). */
const planArg = (v: string | null): Plan | null => {
  if (!v) return null;
  const [t, ...flags] = v.split(',').map((x) => x.trim());
  if (!PURCHASE.includes(t as Target)) throw new Error(`--plan: unknown point "${t}" (one of ${PURCHASE.join(', ')})`);
  return { t: t as Target, todo: flags.includes('todo'), stale: flags.includes('stale'), atRisk: flags.includes('atrisk'), oursLate: flags.includes('ourslate') };
};

async function main() {
  await loadEnv();
  if (process.env.VERCEL_ENV === 'production') throw new Error('Refusing to run on a production environment.');
  const tenantArg = arg('tenant');
  const confirmHost = arg('confirm-host');
  const dryRun = process.argv.includes('--dry-run');
  if (!tenantArg) throw new Error('Usage: npm run cases:stage -- --tenant "<firm name or id>" --confirm-host <db host> [--dry-run]');
  const dbHost = new URL(process.env.DATABASE_URL ?? 'postgres://unset').hostname;
  if (confirmHost !== dbHost) throw new Error(`This would write to the database at ${dbHost}. Re-run with --confirm-host ${dbHost} if that is the one you mean.`);

  const { query, queryOne, pool, runAsSystem } = await import('../lib/server/db');
  const { EngineService } = await import('../lib/server/engine/service');
  const { PgEventStore } = await import('../lib/server/engine/store');
  const { PgDocumentRepository } = await import('../lib/server/engine/pg-documents');
  const { FixtureExtractor, TemplateSummariser, TemplateReportDrafter, MockSearchProvider, MockIdCheckProvider, MockClientComms, MockChaser, MockProofOfFundsForms, MockFileShares, MockSigning } = await import('../lib/server/engine/mocks');
  const { DeterministicNoteReader } = await import('../lib/server/engine/notes');
  const { textPdf } = await import('../lib/server/engine/text-pdf');
  const { counterpartyTypeOf } = await import('../lib/server/engine/counterparty');

  const tenant = await runAsSystem(() => queryOne<{ id: string; name: string }>(`select id, name from tenant where id::text = $1 or name = $1`, [tenantArg]));
  if (!tenant) throw new Error(`No firm called or with id "${tenantArg}".`);

  let clock = new Date();
  const svc = new EngineService(new PgEventStore(), {
    documents: new PgDocumentRepository(),
    extractor: new FixtureExtractor(),
    summariser: new TemplateSummariser(),
    reportDrafter: new TemplateReportDrafter(),
    noteExtractor: new DeterministicNoteReader(),
    searchProvider: new MockSearchProvider(),
    idCheckProvider: new MockIdCheckProvider(),
    clientComms: new MockClientComms(),
    chaser: new MockChaser(),
    pofForms: new MockProofOfFundsForms(),
    fileShares: new MockFileShares(),
    signing: new MockSigning(),
    now: () => clock,
    newId: () => crypto.randomUUID(),
    log: () => {},
  });

  const matters = await runAsSystem(() =>
    query<{ id: string; matter_ref: string; property_address: string | null; handler: string; lender: string | null; track: string | null; exchange_target_date: string | null; completion_target_date: string | null; created_at: Date; purchase_price: string | null }>(
      `select id, matter_ref, property_address, coalesce(assigned_to, created_by) as handler, lender, track,
              exchange_target_date::text, completion_target_date::text, created_at, purchase_price
         from matter where tenant_id = $1 and status <> 'CLOSED' order by created_at, matter_ref, id`,
      [tenant.id]
    )
  );
  console.log(`${tenant.name}: ${matters.length} open case${matters.length === 1 ? '' : 's'} on ${dbHost}${dryRun ? ' (dry run)' : ''}`);

  const only = planArg(arg('plan'));
  for (const [n, m] of matters.entries()) {
    if (only && (await svc.getState(tenant.id, m.id)).enrolled) continue;
    const plan = only ?? SPREAD[n % SPREAD.length];
    const label = `${m.matter_ref} ${m.property_address ?? ''}`.trim();
    if (dryRun) { console.log(`  ${label} → ${describe(plan)}`); continue; }
    try {
      await stage(m, plan);
      await settleProposals(tenant.id, m.id, m.handler);
      if (plan.atRisk) await svc.run(tenant.id, m.id, { type: 'raise_issue', actor: m.handler, kind: 'transaction_at_risk', title: 'Sample — the agent says the buyer may be pulling out', detail: 'Sample issue, added to stage this case for review.' } as never);
      console.log(`  ${label} → ${describe(plan)}`);
    } catch (e) {
      console.log(`  ${label} → stopped: ${e instanceof Error ? e.message : e}`);
    }
  }
  // Let the timers catch up, as the cron would have: overdue waits chase (mock) and climb.
  if (!dryRun) {
    clock = new Date();
    for (const m of matters) await svc.tick(tenant.id, m.id).catch(() => {});
  }
  await pool().end();

  /**
   * What the engine proposed along the way (a search order, a client update, an acknowledgement) a person approved
   * soon after, as a firm does: left for weeks it would read as ours late on every case. The plan's own task (a
   * flagged result, a report to approve, funds to sign off) is a decision of its own kind and stays.
   */
  async function settleProposals(T: string, matterId: string, actor: string) {
    for (let round = 0; round < 5; round++) {
      const st = await svc.getState(T, matterId);
      const open = Object.values(st.decisions).filter((x) => x.status === 'pending' && (x.kind === 'proposal' || x.kind === 'auto_clear'));
      if (!open.length) return;
      clock = new Date(Math.min(Date.now(), (st.lastEventAt ? new Date(st.lastEventAt).getTime() : Date.now()) + 3_600_000));
      for (const d of open) {
        await svc.openDecisionSource(T, matterId, d.eventId, actor).catch(() => null);
        await svc.resolveDecision(T, matterId, d.eventId, actor, 'approve', 'Sample — approved to stage this case for review').catch(() => null);
      }
    }
  }

  async function stage(m: (typeof matters)[number], plan: Plan) {
    const target = plan.t;
    const T = tenant!.id;
    const actor = m.handler;
    const depth = PURCHASE.indexOf(target);
    const now = Date.now();
    // Waiting on us for a week: everything happened up to eight days ago, and nothing since.
    const end = plan.oursLate ? now - 8 * 86_400_000 : now;
    const windowStart = Math.max(new Date(m.created_at).getTime(), end - (plan.stale ? 28 : depth * 4 + 3) * 86_400_000);
    let s = await svc.getState(T, m.id);

    // Not on the engine yet: enrol it here, on this offline wiring and at the start of its
    // window, the same way the app does (enrol.ts) — never through the live engine.
    if (!s.enrolled) {
      clock = new Date(windowStart);
      const counterpartyType = await runAsSystem(() => counterpartyTypeOf(T, m.id)).catch(() => null);
      await runAsSystem(() => svc.run(T, m.id, {
        type: 'enrol', actor,
        transactionType: m.track === 'SALE' ? 'freehold_sale' : m.track === 'REMORTGAGE' ? 'remortgage' : 'freehold_purchase',
        hasLender: !!m.lender, targetExchangeDate: m.exchange_target_date, targetCompletionDate: m.completion_target_date, counterpartyType, shadowMode: false,
      }));
      s = await svc.getState(T, m.id);
    }
    if (!s.transactionType) throw new Error('not on the engine');
    const side = s.transactionType.endsWith('_sale') ? 'sale' : s.transactionType === 'remortgage' || s.transactionType === 'transfer_of_equity' ? 'owner' : 'purchase';

    // Spread this case's steps over the recent past (never before its own last event), so
    // waits have real ages: a case far along started weeks ago, a new one days ago. A case
    // that has gone quiet did its steps early in a longer window, then nothing since.
    const from = Math.max(s.lastEventAt ? new Date(s.lastEventAt).getTime() + 60_000 : 0, windowStart);
    const span = plan.stale ? 0.15 : 1;
    const steps = depth + 3;
    let k = 0;
    const step = () => { k += 1; clock = new Date(Math.min(end, from + ((end - from) * span * k) / (steps + 1))); };
    const reload = async () => (s = await svc.getState(T, m.id));

    const sample = async (fileName: string, docType: string, facts: unknown) => {
      const name = `SAMPLE — ${fileName}.pdf`;
      const bytes = textPdf([name, '', 'SAMPLE DOCUMENT', 'Added to stage this case for review in CONVEYi.', 'It is not a real report and nothing in it is true of this property or client.', '', `Date: ${clock.toISOString().slice(0, 10)}`], { title: name });
      const d = await runAsSystem(() =>
        queryOne<{ id: string }>(
          `insert into document (tenant_id, matter_id, source_type, storage_path, file_name, mime_type, size_bytes, hash_sha256, doc_type, extracted_facts, extraction_confidence, created_by)
           values ($1,$2,'ENGINE_UPLOAD',$3,$4,'application/pdf',$5,$6,$7,$8::jsonb,0.97,$9) returning id`,
          [T, m.id, `sample://${m.id}/${crypto.randomUUID()}`, name, bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'), docType, JSON.stringify(facts), actor]
        )
      );
      await runAsSystem(() => query(`insert into document_blob (document_id, tenant_id, bytes) values ($1,$2,$3)`, [d!.id, T, bytes]));
      return d!.id;
    };
    /** A person reads what the rules flagged and accepts it, so the case can move on. */
    const approve = async (kinds: string[]) => {
      await reload();
      // Where the firm has the engine propose rather than act (auto-clears; messages such as client updates and
      // acknowledgements), the person approves each as it comes up, as a firm would: left for weeks they read as ours late.
      for (const d of Object.values(s.decisions).filter((x) => x.status === 'pending' && (kinds.includes(x.kind) || x.kind === 'auto_clear' || x.kind === 'proposal'))) {
        await svc.openDecisionSource(T, m.id, d.eventId, actor);
        await svc.resolveDecision(T, m.id, d.eventId, actor, 'approve', 'Sample — accepted to stage this case for review');
      }
      await reload();
    };
    const lenderName = m.lender || 'the lender';

    // ── Instruction ──
    if (s.idCheck.status === 'not_started') { step(); await svc.requestIdCheck(T, m.id, actor); await reload(); }
    if (target === 'instructed') return;
    // With a task: the ID check came back needing a person's review, and it is still waiting.
    const idReview = !!plan.todo && target === 'id_done';
    if (s.idCheck.status === 'requested') { step(); await svc.idCheckResultReceived(T, m.id, await sample('ID and AML check', 'ID_CHECK_REPORT', idReview ? { provider: 'sample', outcome: 'refer', flags: [{ code: 'ADDRESS_MISMATCH', severity: 'medium', description: 'Sample result: the address on the ID does not match the address given', locator: { page: 1 } }], confidence: 0.97 } : { provider: 'sample', outcome: 'clear', flags: [], confidence: 0.98 })); }
    if (idReview) return;
    await approve(['id_check']);
    if (target === 'id_done') return;

    const titleFacts = { titleNumber: `SAMPLE${String(Math.floor(Math.random() * 900000) + 100000)}`, tenure: s.transactionType.startsWith('leasehold') ? 'leasehold' : 'freehold', restrictions: [], charges: [], covenants: [], confidence: 0.97 };

    if (side === 'sale') {
      if (s.propertyForms.status === 'not_started') { step(); await svc.run(T, m.id, { type: 'request_property_forms', actor }); await reload(); }
      if (depth <= PURCHASE.indexOf('searches_part')) return; // forms still with the client
      if (s.propertyForms.status === 'requested') { step(); await svc.run(T, m.id, { type: 'property_forms_received', actor, forms: ['TA6', 'TA10'] }); }
      await reload();
      if (s.title.status === 'awaiting') { step(); await svc.titleReceived(T, m.id, await sample('Title register', 'TITLE_REGISTER', titleFacts)); }
      await approve(['title']);
      if (!s.contractPack.sentAt) { step(); await svc.run(T, m.id, { type: 'contract_pack_sent', actor }); }
      return;
    }
    if (side === 'owner') {
      if (s.title.status === 'awaiting') { step(); await svc.titleReceived(T, m.id, await sample('Title register', 'TITLE_REGISTER', titleFacts)); }
      await approve(['title']);
      if (s.redemption.status === 'not_started') { step(); await svc.run(T, m.id, { type: 'request_redemption_statement', actor, lender: 'the existing lender' }); }
      return;
    }

    // ── Searches & enquiries (purchases) ── ordered on entry to pre-contract when the firm lets them go on their
    // own; otherwise they wait for a person to approve the order, so the person orders them here.
    await approve([]); // the engine's own search order, where it proposed one, approved as a person would
    for (const t of s.requiredSearches.filter((x) => !s.searches[x])) { step(); await svc.run(T, m.id, { type: 'record_search_ordered', actor, searchType: t, provider: 'Sample search provider' } as never); }
    await reload();
    const outstanding = s.requiredSearches.filter((t) => !s.searches[t] || s.searches[t].status === 'ordered');
    const back = target === 'searches_part' ? outstanding.slice(0, Math.max(1, Math.floor(outstanding.length / 2))) : outstanding;
    for (const [i, t] of back.entries()) {
      step();
      const flagged = plan.todo && target === 'searches_done' && i === 0;
      const flags = flagged
        ? [{ code: 'PLANNING', severity: 'medium', description: 'Sample result: a planning entry for a neighbouring extension needs a look', locator: { page: 2 } }]
        : [{ code: 'NOTE', severity: 'info', description: 'Sample result: nothing adverse', locator: { page: 1 } }];
      await svc.searchReturned(T, m.id, t, await sample(`${t} search result`, 'SEARCH_RESULT', { searchType: t, flags, confidence: 0.95 }));
    }
    if (target === 'searches_part') return;
    if (target === 'searches_done') { if (!plan.todo) await approve(['search']); return; }
    await approve(['search']);

    // ── Contract & exchange ── (a case already exchanged, staged on an earlier run, goes straight on)
    await reload();
    if (!s.exchange.exchangedAt) {
      if (s.hasLender && s.mortgage.status === 'awaiting') {
        step();
        await svc.mortgageOfferReceived(T, m.id, await sample('Mortgage offer', 'MORTGAGE_OFFER', { lender: lenderName, amountPennies: null, expiryDate: new Date(now + 120 * 86_400_000).toISOString().slice(0, 10), conditions: [{ code: 'STD1', text: 'Buildings insurance on completion', standard: true }], confidence: 0.97 }));
      }
      await reload();
      if (s.title.status === 'awaiting') { step(); await svc.titleReceived(T, m.id, await sample('Title register', 'TITLE_REGISTER', titleFacts)); }
      // The rest of the contract pack: the draft contract comes with the title.
      if (!s.readiness.contractApprovedAt) await svc.contractReceived(T, m.id, await sample('Draft contract', 'CONTRACT', SAMPLE_CONTRACT(m.property_address))).catch(() => null);
      if (target === 'title' && !plan.todo) return;
      await approve(['search', 'mortgage', 'title', 'enquiry', 'management_pack']);
      if (s.reportOnTitle.status === 'not_started') { step(); await svc.draftReportOnTitle(T, m.id); }
      if (target === 'title') return; // with a task: the draft report on title waits for approval
      await approve(['report_on_title']);
      if (s.reportOnTitle.status === 'approved') await svc.sendReportOnTitle(T, m.id, actor);
      // Before any money moves, and before exchange, the firm's own conditions: source of funds
      // signed off, and the client's authority to exchange where the firm asks for it.
      await reload();
      if (s.requireProofOfFunds && s.proofOfFunds.status === 'not_started') { step(); await svc.requestProofOfFunds(T, m.id, actor); await reload(); }
      if (s.proofOfFunds.status === 'requested' && s.proofOfFunds.requestId) {
        step();
        const typed = Number(String(m.purchase_price ?? '').replace(/[£,\s]/g, ''));
        const price = s.purchasePricePennies ?? (Number.isFinite(typed) && typed > 0 ? Math.round(typed * 100) : 30_000_000);
        await svc.proofOfFundsSubmitted(T, m.id, s.proofOfFunds.requestId, {
          declarant: { fullName: 'Sample declaration', email: null, phone: null },
          purchasePricePennies: price,
          mortgageAdvancePennies: null,
          sources: [{ kind: 'savings', amountPennies: price, description: 'Sample source of funds, added to stage this case for review', evidenceDocumentIds: [] }],
          declarations: { accurate: true, noThirdPartyInterest: true, noUndisclosedBorrowing: true },
          clientNote: null,
          submittedAt: clock.toISOString(),
        });
      }
      if (target === 'ready' && plan.todo) return; // with a task: source of funds waits for sign-off
      await approve(['proof_of_funds']);
      if (s.requireExchangeAuthority && !Object.values(s.clientDecisions ?? {}).some((d: { subject?: string; decision?: string }) => d.subject === 'exchange_authority' && d.decision === 'authorised')) {
        await svc.run(T, m.id, { type: 'client_decision_recorded', actor, subject: 'exchange_authority', decision: 'authorised', note: 'Sample — staged for review' });
      }
      await reload();
      if (!s.deposit.received) { step(); await svc.run(T, m.id, { type: 'deposit_received', actor }); }
      if (target === 'ready') return;
    }

    await reload();
    if (!s.exchange.exchangedAt) {
      step();
      // The contract, read and approved by the person, before exchange.
      await svc.run(T, m.id, { type: 'contract_approved', actor } as never).catch(async () => {
        await svc.contractReceived(T, m.id, await sample('Draft contract', 'CONTRACT', SAMPLE_CONTRACT(m.property_address)));
        await approve(['contract']);
        await reload();
        if (!s.readiness.contractApprovedAt) await svc.run(T, m.id, { type: 'contract_approved', actor } as never).catch(() => null);
      });
      await reload();
      if (!s.readiness.signedContractHeldAt) await svc.run(T, m.id, { type: 'signed_contract_held', actor, documentId: await sample('Signed contract', 'CONTRACT', { signed: true }) } as never);
      await svc.run(T, m.id, { type: 'contracts_exchanged', actor, completionDate: new Date(now + 10 * 86_400_000).toISOString().slice(0, 10) });
      await svc.run(T, m.id, { type: 'completion_statement_generated', actor });
    }
    if (target === 'exchanged') return;

    // ── Completion ── bank details are verified out of band before any money moves. (Completed on an earlier run: done.)
    await reload();
    if (s.stage === 'completed' || s.stage === 'post_completion') return;
    step();
    const verifyAll = async (method: string) => {
      await reload();
      for (const d of Object.values(s.decisions).filter((x) => x.kind === 'bank_details' && x.status === 'pending')) {
        await svc.openDecisionSource(T, m.id, d.eventId, actor);
        await svc.resolveDecision(T, m.id, d.eventId, actor, 'verify', 'Sample — staged for review', { method, reference: 'SAMPLE' });
      }
      await reload();
    };
    await svc.recordBankDetails(T, m.id, { actor, payeeKind: 'firm_client_account', payeeRef: 'Client account (sample)', details: { sortCode: '000000', accountNumber: '00000000', accountName: 'SAMPLE client account', firmName: tenant!.name }, sourceChannel: 'letter' }).catch(() => null); // already on file from an earlier run
    await verifyAll('phone_callback_known_number');
    const firm = Object.values(s.bankDetails).find((b) => b.payeeKind === 'firm_client_account' && b.status === 'verified');
    // The lender releases the advance against the certificate of title, which can only be given once the mortgage
    // deed is signed, the bankruptcy and priority searches are clear, insurance is on and the client's balance is in.
    if (firm && s.hasLender) {
      const done = async (cmd: Record<string, unknown>) => svc.run(T, m.id, { actor, ...cmd } as never).catch(() => null);
      await done({ type: 'mortgage_deed_executed', witnessed: true });
      await done({ type: 'transfer_deed_executed', parties: s.partyNames?.length ? s.partyNames : ['Sample buyer'] });
      await done({ type: 'bankruptcy_search_clear', subjects: s.partyNames?.length ? s.partyNames : ['Sample buyer'], documentId: await sample('Bankruptcy search (K16)', 'SEARCH_RESULT', { clear: true }) });
      await done({ type: 'priority_search_made', expiresAt: new Date(now + 30 * 86_400_000).toISOString().slice(0, 10), documentId: await sample('Priority search (OS1)', 'SEARCH_RESULT', { clear: true }) });
      await done({ type: 'buildings_insurance_confirmed', insurer: 'Sample insurer', fromDate: s.exchange.exchangedAt?.slice(0, 10) ?? clock.toISOString().slice(0, 10) });
      await done({ type: 'funds_requested', fromRole: 'client', bankDetailsId: firm.id });
      await done({ type: 'funds_received', fromRole: 'client' });
      await done({ type: 'certificate_of_title_sent', completionDate: s.exchange.completionDate ?? new Date(now + 10 * 86_400_000).toISOString().slice(0, 10) });
    }
    if (firm) {
      await svc.run(T, m.id, { type: 'funds_requested', actor, fromRole: s.hasLender ? 'lender' : 'client', bankDetailsId: firm.id });
      await svc.run(T, m.id, { type: 'funds_received', actor, fromRole: s.hasLender ? 'lender' : 'client' });
    }
    await svc.recordBankDetails(T, m.id, { actor, payeeKind: 'seller_solicitor', payeeRef: "Seller's solicitor (sample)", details: { sortCode: '000000', accountNumber: '00000001', accountName: 'SAMPLE seller solicitor account', firmName: 'Sample' }, sourceChannel: 'letter' }).catch(() => null);
    await verifyAll('lawyer_checker_match');
    const seller = Object.values(s.bankDetails).find((b) => b.payeeKind === 'seller_solicitor' && b.status === 'verified');
    if (seller) {
      await svc.run(T, m.id, { type: 'payment_authorised', actor, payeeKind: 'seller_solicitor', bankDetailsId: seller.id, purpose: 'completion_monies' }).catch(() => null); // authorised on an earlier run
      await svc.run(T, m.id, { type: 'completion_information_received', actor, undertakingToRedeem: true, documentId: await sample('Completion information (TA13)', 'TA13', { undertakingToRedeem: true }) } as never).catch(() => null);
      await svc.run(T, m.id, { type: 'completion_payment_sent', actor, reference: 'SAMPLE-CHAPS' } as never).catch(() => null);
      await svc.run(T, m.id, { type: 'completion_confirmed', actor });
    }
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
