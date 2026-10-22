/**
 * Local development only: a finished mailbox measurement for each fee earner at the demo firm (scripts/dev-seed.ts),
 * so the Measure page (/conveyi/integrations/measure) has a typical week to draw. Eight weeks of made-up case email,
 * sent and received, in the mix a conveyancer's mailbox has; the measurement itself is the real code's. Run with
 * DATABASE_URL pointing at localhost; refuses otherwise. Replaces any earlier demo measurement.
 *
 * Also the last two weeks of each person's own email as Analytics → Time records it live (epa_action): what is left
 * to them once CONVEYi is sending and drafting, so the Time view is not only the Tasks list.
 */
import fs from 'node:fs';

for (const file of ['.env.development.local']) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) throw new Error('dev-measure only runs against a local database.');

const WEEKS = 8;
/** A week's sent case email for one person: category, how many, who to, minutes writing each. */
const SENT: Array<[string, number, string[], number]> = [
  ['chaser', 18, ['other_solicitor', 'other_solicitor', 'client', 'estate_agent', 'lender'], 3],
  ['status_update', 22, ['client', 'client', 'estate_agent'], 4],
  ['update_reply', 20, ['client', 'client', 'estate_agent', 'other_solicitor'], 3],
  ['first_request', 8, ['client', 'other_solicitor'], 5],
  ['file_send', 10, ['client', 'other_solicitor'], 3],
  ['resend', 3, ['client'], 2],
  ['acknowledgement', 14, ['client', 'other_solicitor', 'estate_agent'], 1],
  ['scheduling', 5, ['client', 'other_solicitor'], 3],
  ['process_question', 6, ['client'], 5],
  ['client_question', 5, ['client'], 12],
  ['legal_work', 12, ['other_solicitor', 'client'], 25],
];
/** A week of each person's own sent email once CONVEYi is running: the legal work, and what is still theirs. */
const RECENT: Array<[string, number, string[], number]> = [
  ['legal_work', 12, ['other_solicitor', 'client'], 25],
  ['client_question', 6, ['client'], 12],
  ['process_question', 4, ['client'], 5],
  ['update_reply', 7, ['client', 'estate_agent'], 3],
  ['scheduling', 4, ['client', 'other_solicitor'], 3],
  ['file_send', 5, ['other_solicitor', 'client'], 3],
  ['chaser', 3, ['other_solicitor', 'lender'], 3],
  ['first_request', 2, ['other_solicitor'], 5],
];
/** A week's received case email: category, how many, from whom. */
const RECEIVED: Array<[string, number, string[]]> = [
  ['update_request', 24, ['client', 'client', 'estate_agent', 'estate_agent', 'other_solicitor']],
  ['chaser_received', 9, ['client', 'estate_agent', 'other_solicitor']],
  ['document_delivery', 30, ['client', 'other_solicitor', 'lender']],
  ['question', 8, ['client']],
  ['instruction', 5, ['client']],
  ['enquiry', 6, ['other_solicitor']],
];

/** What InTouch would have said: the person's live cases, and how many were opened in the window. */
const intouch = (live: number, opened: number) => ({
  cases: Array.from({ length: live }, (_, i) => `demo-${i}`), read: live, live, openedInWindow: opened,
  filedByFirm: { email: 0, note: 0, call: 0, document: 0 }, filedByOthers: 0, error: null,
});

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

/** A working moment in week `w` before `until`: a weekday, 9:00 to 17:30. */
function when(until: Date, w: number): Date {
  const d = new Date(until.getTime() - (w + 1) * 7 * 86_400_000);
  d.setUTCDate(d.getUTCDate() + Math.floor(rnd() * 5) - ((d.getUTCDay() + 6) % 7));
  d.setUTCHours(8, 0, 0, 0);
  return new Date(d.getTime() + Math.floor(rnd() * 510) * 60_000);
}

async function main() {
  const { query, queryOne } = await import('../lib/server/db');
  const tenant = await queryOne<{ id: string }>(`select id from tenant where name = 'Anwyll & Co (Demo)'`);
  if (!tenant) throw new Error('No demo firm: run scripts/dev-db.sh first.');
  const people = await query<{ id: string }>(`select id from app_user where tenant_id = $1 and not coalesce(is_developer, false) order by created_at`, [tenant.id]);
  await query(`delete from workload_scan where tenant_id = $1`, [tenant.id]);
  const until = new Date();
  const since = new Date(until.getTime() - WEEKS * 7 * 86_400_000);
  for (const [i, p] of people.entries()) {
    const scale = 0.85 + 0.1 * i;
    const scan = (await queryOne<{ id: string }>(
      `insert into workload_scan (tenant_id, user_id, status, since, until, completed_at, intouch) values ($1, $2, 'COMPLETE', $3, $4, now(), $5::jsonb) returning id`,
      [tenant.id, p.id, since, until, JSON.stringify(intouch(Math.round(38 * scale), Math.round(14 * scale)))]
    ))!.id;
    const rows: unknown[][] = [];
    let n = 0;
    for (let w = 0; w < WEEKS; w++) {
      for (const [category, count, roles] of RECEIVED) {
        for (let k = 0; k < Math.round(count * scale * (0.85 + rnd() * 0.3)); k++) {
          const at = when(until, w);
          const conv = `conv-${scan}-${n}`;
          rows.push([`in-${n++}`, conv, 'in', null, at, [pick(roles)], category]);
          // Most status requests get an answer, a few hours later.
          if (category === 'update_request' && rnd() < 0.8) {
            const sent = new Date(at.getTime() + (1 + rnd() * 30) * 3_600_000);
            if (sent < until) rows.push([`out-${n++}`, conv, 'out', new Date(sent.getTime() - 3 * 60_000), sent, [pick(roles)], 'update_reply']);
          }
        }
      }
      for (const [category, count, roles, minutes] of SENT) {
        const c = category === 'update_reply' ? count * 0.2 : count;
        for (let k = 0; k < Math.round(c * scale * (0.85 + rnd() * 0.3)); k++) {
          const at = when(until, w);
          rows.push([`out-${n++}`, `conv-${scan}-${n}`, 'out', new Date(at.getTime() - minutes * (0.7 + rnd() * 0.6) * 60_000), at, [pick(roles)], category]);
        }
      }
    }
    for (let k = 0; k < rows.length; k += 500) {
      const chunk = rows.slice(k, k + 500);
      const values = chunk.map((_, j) => `($1, $2, $3, $${j * 7 + 4}, $${j * 7 + 5}, $${j * 7 + 6}, $${j * 7 + 7}, $${j * 7 + 8}, $${j * 7 + 9}, $${j * 7 + 10}, 'rule')`).join(', ');
      await query(`insert into workload_email (scan_id, tenant_id, user_id, graph_message_id, conversation_id, direction, drafted_at, sent_at, recipient_roles, category, classified_by) values ${values}`, [scan, tenant.id, p.id, ...chunk.flat()]);
    }
    await query(`update workload_scan set messages_read = $2, classified = $2 where id = $1`, [scan, rows.length]);
    await query(`delete from epa_action where user_id = $1 and ref like 'dev-%'`, [p.id]);
    let r = 0;
    for (let w = 0; w < 2; w++) {
      for (const [category, count, roles, minutes] of RECENT) {
        for (let k = 0; k < Math.round(count * scale * (0.85 + rnd() * 0.3)); k++) {
          const at = when(until, w - 1);
          if (at > until) continue;
          await query(`insert into epa_action (tenant_id, user_id, source, ref, at, drafted_at, category, roles, classified_by) values ($1, $2, 'sent', $3, $4, $5, $6, $7, 'rule')`,
            [tenant.id, p.id, `dev-${r++}`, at, new Date(at.getTime() - minutes * (0.7 + rnd() * 0.6) * 60_000), category, [pick(roles)]]);
        }
      }
      for (const [category, count, roles] of RECEIVED.filter(([c]) => c !== 'document_delivery')) {
        for (let k = 0; k < Math.round(count * 0.4 * scale); k++) {
          const at = when(until, w - 1);
          if (at > until) continue;
          await query(`insert into epa_action (tenant_id, user_id, source, ref, at, category, roles, classified_by) values ($1, $2, 'received', $3, $4, $5, $6, 'rule')`,
            [tenant.id, p.id, `dev-${r++}`, at, category, [pick(roles)]]);
        }
      }
    }
    console.log(`Measured ${rows.length} emails for one fee earner.`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
