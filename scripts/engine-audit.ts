/**
 * Verify a matter's engine log from the command line (component #7).
 *
 *   npx tsx scripts/engine-audit.ts <matterId> [--csv out.csv]
 *
 * Checks the hash chain, replays the log and compares it with the read model, and
 * prints the compliance summary. Exit code 1 on any failure so it can run in CI/ops.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

async function main() {
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
  const [matterId, ...rest] = process.argv.slice(2);
  if (!matterId) throw new Error('usage: engine-audit.ts <matterId> [--csv file]');
  const { queryOne, pool } = await import('../lib/server/db');
  const { PgEventStore } = await import('../lib/server/engine/store');
  const { auditMatter, auditCsv } = await import('../lib/server/engine/audit');
  const m = await queryOne<{ tenant_id: string; matter_ref: string }>(`select tenant_id, matter_ref from matter where id = $1`, [matterId]);
  if (!m) throw new Error('matter not found');
  const store = new PgEventStore();
  const report = await auditMatter(store, m.tenant_id, matterId, await store.cachedState(m.tenant_id, matterId));
  console.log(`Matter ${m.matter_ref} (${matterId})`);
  console.log(`  events: ${report.summary.events}  stage: ${report.state.stage}  head: ${report.headHash ?? '-'}`);
  console.log(`  chain:  ${report.chain.ok ? 'OK' : `BROKEN at seq ${report.chain.brokenAtSeq} — ${report.chain.reason}`}`);
  console.log(`  replay: ${report.replay.ok ? 'OK' : 'MISMATCH'} — ${report.replay.detail}`);
  console.log(`  actors: ${JSON.stringify(report.summary.byActorKind)}`);
  console.log(`  decisions: ${report.summary.decisions}  resolved-without-opening-source: ${report.summary.decisionsResolvedWithoutOpeningSource}  ai-sent-without-approval: ${report.summary.aiSentWithoutApproval}`);
  const csvIdx = rest.indexOf('--csv');
  if (csvIdx >= 0 && rest[csvIdx + 1]) {
    await fs.writeFile(rest[csvIdx + 1], auditCsv(report));
    console.log(`  csv written to ${rest[csvIdx + 1]}`);
  }
  await pool().end();
  if (!report.chain.ok || !report.replay.ok || report.summary.decisionsResolvedWithoutOpeningSource > 0 || report.summary.aiSentWithoutApproval > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
