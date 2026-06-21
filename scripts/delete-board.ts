/**
 * One-off: delete a tenant user's master matters board from OneDrive so the app
 * rebuilds a fresh formatted template (new conditional formatting / tooltip) on
 * the next refresh. Run with: tsx scripts/delete-board.ts <user-email>
 */
import fs from 'node:fs/promises';
import path from 'node:path';

async function loadEnv() {
  for (const file of ['.env.vercel.tmp', '.env.local', '.env']) {
    try {
      const raw = await fs.readFile(path.resolve(process.cwd(), file), 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch {
      /* file absent — skip */
    }
  }
}

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error('Usage: tsx scripts/delete-board.ts <user-email>');
  await loadEnv();

  const { queryOne } = await import('../lib/server/db');
  const { deleteDriveItemByPath } = await import('../lib/server/graph');
  const { MASTER_WORKBOOK_NAME } = await import('../lib/server/matters-board');
  const { config } = await import('../lib/server/config');

  const user = await queryOne<{ id: string; email: string }>(
    `select id, email from app_user where lower(email) = lower($1)`,
    [email]
  );
  if (!user) throw new Error(`No app_user with email ${email}`);

  const masterPath = `${config.oneDriveRoot}/${MASTER_WORKBOOK_NAME}`;
  const removed = await deleteDriveItemByPath(user.id, masterPath);
  console.log(removed ? `Deleted: ${masterPath}` : `Not found (nothing to delete): ${masterPath}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
);
