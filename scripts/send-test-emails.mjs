// Sends a realistic England & Wales house-purchase email series to a test inbox
// so the Outlook add-in can be exercised against varied conveyancing messages.
//
// Usage:
//   1. In .env.local set:
//        RESEND_API_KEY=re_xxx
//        RESEND_FROM_DOMAIN=caselightning.co.uk   (must be a domain verified in Resend)
//        TEST_INBOX=peteranwyll@hotmail.com        (optional; this is the default)
//   2. node scripts/send-test-emails.mjs
//        --dry        print what would be sent, send nothing
//        --only=3,5   send only those numbered emails
//
// Each email is "from" a different conveyancing persona. Resend requires the
// from-address to be on a verified domain, so the local-part varies per party
// (agent@, broker@, ...) but the domain stays constant.

import { readFileSync } from 'node:fs';
import { Resend } from 'resend';

// --- load .env.local (simple parser; avoids adding a dotenv dep) ---
function loadEnv(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* no .env.local — rely on real env */ }
}
loadEnv(new URL('../.env.local', import.meta.url));

const API_KEY = process.env.RESEND_API_KEY;
const DOMAIN = process.env.RESEND_FROM_DOMAIN || 'caselightning.co.uk';
const TO = process.env.TEST_INBOX || 'peteranwyll@hotmail.com';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.replace('--only=', '').split(',').map(Number) : null;

if (!API_KEY && !DRY) {
  console.error('Missing RESEND_API_KEY in .env.local. Add it, or run with --dry to preview.');
  process.exit(1);
}

// --- the matter ---
const M = {
  buyer: 'Peter Anwyll',
  property: '14 Elm Grove, Didsbury, Manchester M20 6RT',
  price: '£385,000',
  deposit: '£38,500',
  ref: 'CL-2026-0417',
};

const p = (...lines) => lines.join('\n\n');

// --- the series ---
const emails = [
  {
    n: 1,
    persona: 'Olivia Reece — Didsbury Property Co.',
    local: 'olivia.reece',
    subject: `Sale agreed — ${M.property}`,
    body: p(
      `Dear ${M.buyer},`,
      `Great news — your offer of ${M.price} on ${M.property} has been accepted by the vendor, Mr & Mrs Harding. I've issued the memorandum of sale to all parties this morning.`,
      `Both solicitors are now instructed:\n  • Your conveyancer: Hartley & Rowe LLP (Sarah Hartley)\n  • Vendor's solicitor: Pennington Legal (David Cole)`,
      `The property is freehold and the vendors are in a short onward chain (one above). They're hoping for completion within 10–12 weeks. Anything you need from me, just shout.`,
      `Kind regards,\nOlivia Reece\nSales Negotiator, Didsbury Property Co.\n0161 555 0142`,
    ),
  },
  {
    n: 2,
    persona: 'Sarah Hartley — Hartley & Rowe LLP',
    local: 'sarah.hartley',
    subject: `We're now acting for you — ${M.property} [Ref ${M.ref}]`,
    body: p(
      `Dear ${M.buyer},`,
      `Thank you for instructing Hartley & Rowe LLP on your purchase of ${M.property}. Your matter reference is ${M.ref} — please quote it on all correspondence.`,
      `What happens next:\n  1. We carry out ID and source-of-funds checks (form attached).\n  2. We request the contract pack from the vendor's solicitor.\n  3. We order searches (local authority, water & drainage, environmental).\n  4. We raise enquiries and report to you before exchange.`,
      `To get started we'll need: proof of ID, your mortgage agreement-in-principle, and the £350 search fee on account. Could you also confirm how you intend to fund the ${M.deposit} deposit?`,
      `Kind regards,\nSarah Hartley\nPartner, Hartley & Rowe LLP\n0161 555 0288`,
    ),
  },
  {
    n: 3,
    persona: 'Marcus Bell — Northgate Mortgages',
    local: 'marcus.bell',
    subject: `Mortgage offer received — Halifax, ${M.property}`,
    body: p(
      `Hi ${M.buyer},`,
      `Good news — Halifax has issued your formal mortgage offer. Summary:`,
      `  • Loan: £308,000 (80% LTV)\n  • Term: 25 years\n  • Rate: 4.39% fixed for 5 years\n  • Monthly payment: £1,701\n  • Valuation: came back at full purchase price of ${M.price}`,
      `The offer is valid for 6 months. I've sent a copy to Hartley & Rowe so they have it on file for exchange. Please review the offer document carefully and let me know if anything looks off.`,
      `Best,\nMarcus Bell\nNorthgate Mortgages\n0161 555 0710`,
    ),
  },
  {
    n: 4,
    persona: 'David Cole — Pennington Legal (vendor)',
    local: 'david.cole',
    subject: `Draft contract pack — ${M.property}`,
    body: p(
      `Dear Sirs,`,
      `We act for the vendors, Mr & Mrs Harding. Please find enclosed the draft contract pack for ${M.property}:`,
      `  • Draft contract\n  • Office copy entries and title plan (HM Land Registry)\n  • Property Information Form (TA6)\n  • Fittings and Contents Form (TA10)\n  • Energy Performance Certificate (rating C)`,
      `Our clients confirm the property is sold with vacant possession. We look forward to receiving your enquiries in due course. Kindly note our clients are keen to exchange before the end of next month.`,
      `Yours faithfully,\nDavid Cole\nPennington Legal`,
    ),
  },
  {
    n: 5,
    persona: 'Ian Forsythe MRICS — Forsythe Surveying',
    local: 'ian.forsythe',
    subject: `Level 2 HomeBuyer Report — ${M.property}`,
    body: p(
      `Dear ${M.buyer},`,
      `Please find attached your RICS Level 2 HomeBuyer Report for ${M.property}. Overall the property is in sound condition for its age (built c.1935). Headline findings:`,
      `  • Condition rating 3 (urgent): minor damp readings to the rear ground-floor wall — recommend a damp specialist's report.\n  • Condition rating 2: some perished pointing to the chimney stack; gutters overflowing on the north elevation.\n  • Roof, electrics and boiler all appear serviceable; boiler is 7 years old.`,
      `None of this is unusual or a reason not to proceed, but you may wish to factor the damp investigation into your negotiations. Happy to talk it through.`,
      `Regards,\nIan Forsythe MRICS\nForsythe Surveying`,
    ),
  },
  {
    n: 6,
    persona: 'Sarah Hartley — Hartley & Rowe LLP',
    local: 'sarah.hartley',
    subject: `RE: We're now acting for you — searches back, enquiries raised [Ref ${M.ref}]`,
    body: p(
      `Dear ${M.buyer},`,
      `An update on ${M.property} (ref ${M.ref}). Search results are in:`,
      `  • Local authority search: no adverse entries; no planning issues affecting the property. Note the road is adopted and maintained at public expense.\n  • Water & drainage: mains water and sewerage connected.\n  • Environmental: low risk; no significant flood or contamination concern.`,
      `Following your survey we've raised additional enquiries with the vendor's solicitor regarding the damp to the rear wall and the date of the last gas safety check. We'll report their replies as soon as they arrive.`,
      `Nothing for you to do at this stage. Kind regards,\nSarah Hartley\nHartley & Rowe LLP`,
    ),
  },
  {
    n: 7,
    persona: 'Sarah Hartley — Hartley & Rowe LLP',
    local: 'sarah.hartley',
    subject: `Ready to exchange — completion date proposal [Ref ${M.ref}]`,
    body: p(
      `Dear ${M.buyer},`,
      `We're now in a position to exchange contracts on ${M.property}. All enquiries are satisfactorily answered, your mortgage offer is on file, and searches are clear.`,
      `Before we exchange we need:\n  • Your signed contract and transfer deed (TR1) — enclosed for signature.\n  • The deposit of ${M.deposit} in cleared funds in our client account.\n  • Your confirmation of the proposed completion date: Friday 14 August 2026.`,
      `On exchange the agreement becomes legally binding and you'll be committed to completing on the agreed date. Please confirm you're happy to proceed.`,
      `Kind regards,\nSarah Hartley\nHartley & Rowe LLP`,
    ),
  },
  {
    n: 8,
    persona: 'Sarah Hartley — Hartley & Rowe LLP',
    local: 'sarah.hartley',
    subject: `Completion confirmed — keys released! [Ref ${M.ref}]`,
    body: p(
      `Dear ${M.buyer},`,
      `Congratulations — completion of ${M.property} took place at 11:42 this morning. The purchase monies have been sent to the vendor's solicitor and receipt confirmed. The keys have been released to you at the estate agent's office.`,
      `Final points we'll handle on your behalf:\n  • Pay Stamp Duty Land Tax and submit the SDLT return (within 14 days).\n  • Register your ownership at HM Land Registry.\n  • Send you the registered title and our completion statement once finalised.`,
      `It's been a pleasure acting for you. Enjoy your new home!`,
      `Warm regards,\nSarah Hartley\nPartner, Hartley & Rowe LLP`,
    ),
  },
];

const toHtml = (text) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">` +
  text.split('\n\n').map((para) => `<p>${para.replace(/\n/g, '<br/>')}</p>`).join('') +
  `</div>`;

const resend = API_KEY ? new Resend(API_KEY) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const queue = emails.filter((e) => !ONLY || ONLY.includes(e.n));
console.log(`${DRY ? '[DRY RUN] ' : ''}Sending ${queue.length} email(s) to ${TO} (from-domain: ${DOMAIN})\n`);

for (const e of queue) {
  // RESEND_FROM_ADDRESS overrides the per-persona address (e.g. onboarding@resend.dev
  // sandbox sender when no custom domain is verified). Display name still varies per party.
  const fromAddr = process.env.RESEND_FROM_ADDRESS || `${e.local}@${DOMAIN}`;
  const from = `${e.persona} <${fromAddr}>`;
  if (DRY) {
    console.log(`#${e.n}  FROM ${from}\n     SUBJ ${e.subject}\n`);
    continue;
  }
  try {
    const { data, error } = await resend.emails.send({
      from,
      to: TO,
      subject: e.subject,
      html: toHtml(e.body),
      text: e.body,
    });
    if (error) {
      console.error(`#${e.n}  ✗ ${e.subject}\n     ${JSON.stringify(error)}`);
    } else {
      console.log(`#${e.n}  ✓ ${e.subject}  (id ${data?.id})`);
    }
  } catch (err) {
    console.error(`#${e.n}  ✗ ${e.subject}\n     ${err?.message || err}`);
  }
  await sleep(1200); // gentle spacing; also helps inbox ordering
}

console.log('\nDone.');
