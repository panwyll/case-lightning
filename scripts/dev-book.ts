/**
 * Local development only: a full book of made-up cases for the demo firm (scripts/dev-seed.ts), so Case View, the
 * Tasks list and the case pages have something in them. Adds the cases, then stages each at a different point
 * through the real engine with nothing sent (scripts/stage-cases.ts). Run with DATABASE_URL pointing at localhost;
 * refuses otherwise. Once the firm has a book, it adds another only with --more.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

for (const file of ['.env.development.local']) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) throw new Error('dev-book only runs against a local database.');

const STREETS = ['Clarendon Road', 'Kirkgate', 'Westfield Avenue', 'Ash Grove', 'Victoria Terrace', 'Mill Hill', 'Chapel Street', 'Grange Park', 'Beech Walk', 'Otley Road', 'Church Lane', 'Harewood Close', 'Wetherby Road', 'St Mark’s Avenue', 'Bramley Fold', 'Canal Wharf', 'Moorland Drive', 'Elmete Lane', 'Park Square', 'Headingley Mount'];
const TOWNS = ['Leeds LS2', 'Leeds LS6', 'Harrogate HG2', 'York YO10', 'Wakefield WF1', 'Ilkley LS29', 'Otley LS21', 'Leeds LS8'];
const CLIENTS = ['Amira Hussain', 'Joe Whitaker', 'Hannah Brook', 'Daniel Okafor', 'Lucy Marsh', 'Ravi Nair', 'Ellie Turner', 'Marcus Webb', 'Sophie Laing', 'Owen Pryce', 'Nadia Khan', 'George Hall', 'Isla Murray', 'Kwame Mensah', 'Beth Sutton', 'Tom Fielding', 'Zara Ahmed', 'Callum Reid', 'Freya Dale', 'Adam Novak'];
const TYPES = ['freehold_purchase', 'freehold_purchase', 'leasehold_purchase', 'freehold_purchase', 'freehold_sale', 'freehold_purchase', 'leasehold_sale', 'remortgage'];
const COUNT = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 40);
/** After the book: a few cases whose task has waited on us for a week (Delayed - Us). */
const LATE = ['id_done,todo,ourslate', 'title,todo,ourslate', 'id_done,todo,ourslate', 'searches_done,todo,ourslate', 'id_done,todo,ourslate'];

async function main() {
  const { query, queryOne, runAsSystem } = await import('../lib/server/db');
  const host = new URL(process.env.DATABASE_URL!).hostname;
  const stage = (plan?: string) => execFileSync('npx', ['tsx', 'scripts/stage-cases.ts', '--tenant', 'Anwyll & Co (Demo)', '--confirm-host', host, ...(plan ? ['--plan', plan] : [])], { stdio: 'inherit', env: process.env });
  const tenant = await queryOne<{ id: string }>(`select id from tenant where name = 'Anwyll & Co (Demo)'`);
  if (!tenant) throw new Error('No demo firm: run scripts/dev-db.sh first.');
  const already = Number((await queryOne<{ n: string }>(`select count(*)::text as n from matter where tenant_id = $1 and matter_ref like 'DEMO-%' and status <> 'CLOSED'`, [tenant.id]))?.n ?? 0);
  if (already > 10 && !process.argv.includes('--more')) { console.log(`The demo firm already has ${already} live cases. Add another book with: npm run dev:book -- 40 --more`); process.exit(0); }
  const people = await query<{ id: string }>(`select id from app_user where tenant_id = $1 and not coalesce(is_developer, false) order by created_at`, [tenant.id]);
  const n0 = Number((await queryOne<{ n: string }>(`select count(*)::text as n from matter where tenant_id = $1 and matter_ref like 'DEMO-%'`, [tenant.id]))?.n ?? 0);
  let added = 0;
  const add = async (count: number) => { for (let i = 0; i < count; i++) {
    const k = n0 + added++;
    const type = TYPES[k % TYPES.length];
    const client = CLIENTS[k % CLIENTS.length];
    const address = `${(k * 7) % 98 + 2} ${STREETS[k % STREETS.length]}, ${TOWNS[(k * 3) % TOWNS.length]} ${String.fromCharCode(65 + (k % 26))}${(k % 9) + 1}`;
    const handler = people[k % people.length].id;
    const sale = type.endsWith('_sale');
    const price = type === 'remortgage' ? null : `£${(180 + ((k * 37) % 420)).toLocaleString('en-GB')},000`;
    const m = (await queryOne<{ id: string }>(
      `insert into matter (tenant_id, matter_ref, property_address, buyer_names, seller_names, created_by, assigned_to, transaction_type, purchase_price, lender, track, exchange_target_date, completion_target_date, created_at)
       values ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, current_date + $11::int, current_date + $12::int, now() - ($13 || ' days')::interval) returning id`,
      [tenant.id, `DEMO-${String(k + 1).padStart(3, '0')}`, address, sale ? [] : [client], sale ? [client] : [], handler, type, price, sale ? null : 'Demo Building Society', sale ? 'SALE' : type === 'remortgage' ? 'REMORTGAGE' : 'PURCHASE', 20 + (k % 30), 35 + (k % 40), String(30 + (k % 25))]
    ))!.id;
    const email = `${client.toLowerCase().replace(/[^a-z]+/g, '.')}@demo.test`;
    await query(`insert into matter_contact (tenant_id, matter_id, email, name, role) values ($1, $2, $3, $4, 'CLIENT')`, [tenant.id, m, email, client]);
    await runAsSystem(async () => (await import('../lib/server/client-portal')).ensurePortal(tenant.id, m)).catch(() => null);
  } };
  await add(COUNT);
  console.log(`Added ${COUNT} demo cases; staging them through the engine (nothing is sent)…`);
  stage();
  for (const plan of LATE) { await add(1); stage(plan); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
