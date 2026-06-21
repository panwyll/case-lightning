// Generates a large, varied set of England & Wales conveyancing emails across many
// cases and sends them to a test inbox, so the Outlook add-in can be exercised at scale.
//
// Usage:
//   node scripts/send-bulk-cases.mjs --dry                 # preview, send nothing
//   node scripts/send-bulk-cases.mjs                       # send for real
//   node scripts/send-bulk-cases.mjs --cases=50 --limit=100
//
// Flags:
//   --dry           build everything, print a summary, send nothing
//   --cases=N       number of distinct matters (default 50)
//   --min=N --max=N emails per case range (default 3..5)
//   --limit=N       stop after N actual sends (e.g. 100 to respect a daily cap)
//   --seed=N        deterministic generation (default 42)
//
// Env (.env.local / .env.vercel / inline):
//   RESEND_API_KEY        required to send
//   RESEND_FROM_DOMAIN    verified domain for the from-address (default caselightning.co.uk)
//   RESEND_FROM_ADDRESS   override full from-address (e.g. onboarding@resend.dev sandbox)
//   TEST_INBOX            recipient (default pete@killerdotdev.onmicrosoft.com)
//   SEND_DELAY_MS         spacing between sends (default 800)

import { readFileSync } from 'node:fs';
import { Resend } from 'resend';

function loadEnv(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore */ }
}
loadEnv(new URL('../.env.vercel', import.meta.url));
loadEnv(new URL('../.env.local', import.meta.url));

const args = process.argv.slice(2);
const flag = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : def;
};
const DRY = args.includes('--dry');
const CASES = parseInt(flag('cases', '50'), 10);
const MIN = parseInt(flag('min', '3'), 10);
const MAX = parseInt(flag('max', '5'), 10);
const LIMIT = flag('limit', null) ? parseInt(flag('limit', null), 10) : Infinity;
let seed = parseInt(flag('seed', '42'), 10);

const API_KEY = process.env.RESEND_API_KEY;
const DOMAIN = process.env.RESEND_FROM_DOMAIN || 'caselightning.co.uk';
const FROM_OVERRIDE = process.env.RESEND_FROM_ADDRESS || null;
const TO = process.env.TEST_INBOX || 'pete@killerdotdev.onmicrosoft.com';
const DELAY = parseInt(process.env.SEND_DELAY_MS || '800', 10);

// --- deterministic PRNG (mulberry32) so runs are reproducible ---
function rng() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

// --- data pools ---
const FIRST = ['James', 'Priya', 'Liam', 'Aoife', 'Tom', 'Hannah', 'Raj', 'Chloe', 'Daniel', 'Emily', 'Mohammed', 'Grace', 'Owen', 'Sofia', 'Ben', 'Isla', 'Adam', 'Maya', 'Jack', 'Freya', 'Noah', 'Ella', 'Sam', 'Niamh'];
const LAST = ['Harding', 'Okafor', 'Whitfield', 'Patel', 'Mercer', 'Donnelly', 'Ashworth', 'Bryant', 'Kaur', 'Lindqvist', 'Boyle', 'Frost', 'Nguyen', 'Sutcliffe', 'Reilly', 'Carmichael', 'Hossain', 'Ellison', 'Marsh', 'Pryce'];
const STREETS = ['Elm Grove', 'Beech Road', 'Sycamore Avenue', 'Victoria Terrace', 'Kingsley Drive', 'Mill Lane', 'Oakfield Close', 'Carlton Road', 'Hawthorn Way', 'Priory Gardens', 'Station Road', 'Marlborough Street', 'Fernlea Avenue', 'Cedar Court', 'Brookfield Rise', 'Albion Street', 'Riverside Walk', 'Heathcote Road', 'Lansdowne Crescent', 'Tennyson Close'];
const TOWNS = [['Didsbury, Manchester', 'M20'], ['Chorlton, Manchester', 'M21'], ['Headingley, Leeds', 'LS6'], ['Jesmond, Newcastle', 'NE2'], ['Clifton, Bristol', 'BS8'], ['Moseley, Birmingham', 'B13'], ['Walthamstow, London', 'E17'], ['Stockport', 'SK4'], ['Altrincham', 'WA14'], ['Harrogate', 'HG1'], ['Sale', 'M33'], ['Macclesfield', 'SK10']];
const AGENTS = ['Didsbury Property Co.', 'Northern Homes', 'Bramley & Vale', 'Cityside Lettings & Sales', 'Whitegate Estates', 'Marsh & Partners', 'Hilltop Residential', 'Keystone Estate Agents'];
const BUYER_SOLS = ['Hartley & Rowe LLP', 'Greenwood Legal', 'Mason Clarke Solicitors', 'Fairbridge Law', 'Oakhurst & Co', 'Pennine Conveyancing', 'Thornton Legal'];
const SELLER_SOLS = ['Pennington Legal', 'Croft & Hargreaves', 'Bluestone Solicitors', 'Wardle Mackenzie LLP', 'Ashby Conveyancing', 'Delaney & Webb'];
const LENDERS = ['Halifax', 'Nationwide', 'Santander', 'NatWest', 'Barclays', 'HSBC', 'Coventry Building Society', 'Skipton'];
const BROKERS = ['Northgate Mortgages', 'Clearpath Financial', 'Anchor Mortgage Advice', 'Bluebell Brokers'];
const SURVEYORS = ['Forsythe Surveying', 'Halliday RICS', 'Pinnacle Property Surveys', 'County Surveyors'];

const localPart = (name) =>
  name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '').slice(0, 40);

function person() { return `${pick(FIRST)} ${pick(LAST)}`; }

function buildCase(i) {
  const [town, pc] = pick(TOWNS);
  const num = int(1, 180);
  const street = pick(STREETS);
  const price = int(180, 750) * 1000;
  const tenure = rng() < 0.25 ? 'leasehold' : 'freehold';
  return {
    ref: `CL-2026-${String(1000 + i).padStart(4, '0')}`,
    address: `${num} ${street}, ${town} ${pc} ${int(1, 9)}${pick('ABDEHJLNPRSTWXYZ')}${pick('ABDEHJLNPRSTWXYZ')}`,
    price: `£${price.toLocaleString('en-GB')}`,
    deposit: `£${Math.round(price * 0.1).toLocaleString('en-GB')}`,
    tenure,
    buyer: person(),
    seller: person(),
    agent: pick(AGENTS),
    agentRep: person(),
    bSol: pick(BUYER_SOLS),
    bSolRep: person(),
    sSol: pick(SELLER_SOLS),
    sSolRep: person(),
    lender: pick(LENDERS),
    broker: pick(BROKERS),
    brokerRep: person(),
    surveyor: pick(SURVEYORS),
    surveyorRep: person(),
  };
}

const para = (...l) => l.join('\n\n');

// --- email stage templates (ordered lifecycle) ---
const STAGES = [
  (c) => ({
    persona: `${c.agentRep} — ${c.agent}`,
    local: localPart(c.agent),
    subject: `Sale agreed — ${c.address}`,
    body: para(`Dear ${c.buyer},`,
      `Your offer of ${c.price} on ${c.address} has been accepted. Memorandum of sale issued to all parties. The property is ${c.tenure}.`,
      `Your solicitor: ${c.bSol}. Vendor's solicitor: ${c.sSol}.`,
      `Kind regards,\n${c.agentRep}\n${c.agent}`),
  }),
  (c) => ({
    persona: `${c.bSolRep} — ${c.bSol}`,
    local: localPart(c.bSol),
    subject: `We're now acting for you — ${c.address} [Ref ${c.ref}]`,
    body: para(`Dear ${c.buyer},`,
      `Thank you for instructing ${c.bSol} on your purchase of ${c.address}. Matter reference ${c.ref}.`,
      `Next we'll request the contract pack, order searches, and carry out ID checks. We'll need the £350 search fee on account and confirmation of how you're funding the ${c.deposit} deposit.`,
      `Kind regards,\n${c.bSolRep}\n${c.bSol}`),
  }),
  (c) => ({
    persona: `${c.brokerRep} — ${c.broker}`,
    local: localPart(c.broker),
    subject: `Mortgage offer received — ${c.lender}, ${c.address}`,
    body: para(`Hi ${c.buyer},`,
      `${c.lender} has issued your formal mortgage offer. The valuation came back at the full purchase price of ${c.price}. The offer is valid for 6 months; a copy has gone to ${c.bSol}.`,
      `Best,\n${c.brokerRep}\n${c.broker}`),
  }),
  (c) => ({
    persona: `${c.sSolRep} — ${c.sSol} (vendor)`,
    local: localPart(c.sSol),
    subject: `Draft contract pack — ${c.address}`,
    body: para(`Dear Sirs,`,
      `We act for the vendor. Enclosed: draft contract, office copy entries, TA6 Property Information Form, TA10 Fittings & Contents, and EPC. The property is sold ${c.tenure} with vacant possession.`,
      `Yours faithfully,\n${c.sSolRep}\n${c.sSol}`),
  }),
  (c) => ({
    persona: `${c.surveyorRep} — ${c.surveyor}`,
    local: localPart(c.surveyor),
    subject: `RICS HomeBuyer Report — ${c.address}`,
    body: para(`Dear ${c.buyer},`,
      `Your Level 2 survey for ${c.address} is attached. The property is generally sound for its age. Items to note: minor damp to a ground-floor wall (condition rating 3) and some perished pointing to the chimney (rating 2). Nothing that should stop you proceeding.`,
      `Regards,\n${c.surveyorRep}\n${c.surveyor}`),
  }),
  (c) => ({
    persona: `${c.bSolRep} — ${c.bSol}`,
    local: localPart(c.bSol),
    subject: `RE: Searches back — enquiries raised [Ref ${c.ref}]`,
    body: para(`Dear ${c.buyer},`,
      `Search results for ${c.address} are in: local authority clear, mains water & drainage connected, environmental low risk. Following your survey we've raised enquiries with the vendor's solicitor about the damp and the last gas safety check. Nothing for you to do yet.`,
      `Kind regards,\n${c.bSolRep}\n${c.bSol}`),
  }),
  (c) => ({
    persona: `${c.bSolRep} — ${c.bSol}`,
    local: localPart(c.bSol),
    subject: `Ready to exchange — completion date [Ref ${c.ref}]`,
    body: para(`Dear ${c.buyer},`,
      `We can now exchange contracts on ${c.address}. We need your signed contract and TR1, the ${c.deposit} deposit in cleared funds, and confirmation of the proposed completion date. On exchange the agreement becomes legally binding.`,
      `Kind regards,\n${c.bSolRep}\n${c.bSol}`),
  }),
  (c) => ({
    persona: `${c.bSolRep} — ${c.bSol}`,
    local: localPart(c.bSol),
    subject: `Completion confirmed — keys released! [Ref ${c.ref}]`,
    body: para(`Dear ${c.buyer},`,
      `Completion of ${c.address} has taken place. Funds sent and receipt confirmed; keys released to you at the agent's office. We'll deal with SDLT and Land Registry on your behalf. Congratulations!`,
      `Warm regards,\n${c.bSolRep}\n${c.bSol}`),
  }),
];

// --- build the full list ---
const messages = [];
for (let i = 0; i < CASES; i++) {
  const c = buildCase(i);
  const n = int(MIN, MAX);
  // always start at "sale agreed"; take the first n lifecycle stages (in order)
  for (let s = 0; s < Math.min(n, STAGES.length); s++) {
    const m = STAGES[s](c);
    messages.push({ ref: c.ref, ...m });
  }
}

const toHtml = (text) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">` +
  text.split('\n\n').map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('') + `</div>`;

console.log(`${DRY ? '[DRY RUN] ' : ''}${CASES} cases → ${messages.length} emails → ${TO}`);
console.log(`From: ${FROM_OVERRIDE ? FROM_OVERRIDE + ' (override)' : '*@' + DOMAIN}` +
  `${LIMIT !== Infinity ? `   limit=${LIMIT}` : ''}\n`);

if (DRY) {
  for (const m of messages.slice(0, 12)) {
    const addr = FROM_OVERRIDE || `${m.local}@${DOMAIN}`;
    console.log(`[${m.ref}] ${m.persona} <${addr}>\n        ${m.subject}`);
  }
  if (messages.length > 12) console.log(`... and ${messages.length - 12} more`);
  process.exit(0);
}

if (!API_KEY) { console.error('Missing RESEND_API_KEY.'); process.exit(1); }
const resend = new Resend(API_KEY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sent = 0, failed = 0;
for (const m of messages) {
  if (sent >= LIMIT) { console.log(`\nReached limit (${LIMIT}). Stopping.`); break; }
  const from = `${m.persona} <${FROM_OVERRIDE || `${m.local}@${DOMAIN}`}>`;
  try {
    const { data, error } = await resend.emails.send({
      from, to: TO, subject: m.subject, html: toHtml(m.body), text: m.body,
    });
    if (error) { failed++; console.error(`✗ [${m.ref}] ${m.subject} — ${JSON.stringify(error)}`); }
    else { sent++; if (sent % 10 === 0) console.log(`  …${sent} sent`); }
  } catch (err) { failed++; console.error(`✗ [${m.ref}] ${m.subject} — ${err?.message || err}`); }
  await sleep(DELAY);
}

console.log(`\nDone. Sent ${sent}, failed ${failed}, of ${messages.length} generated.`);
