/**
 * Idempotent migration runner. Applies db/migrations/*.sql in filename order,
 * tracking applied files in schema_migrations. Run with `npm run migrate`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;

async function main() {
  // Load .env.local (Next convention) then .env, without adding a dotenv dep.
  for (const file of ['.env.local', '.env']) {
    try {
      const raw = await fs.readFile(path.resolve(process.cwd(), file), 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
    } catch {
      /* file may not exist */
    }
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required (set it in .env.local)');

  const client = new Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const migrationsDir = path.resolve(process.cwd(), 'db/migrations');
    const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    await client.query(`
      create table if not exists schema_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      );
    `);

    for (const file of files) {
      const exists = await client.query('select 1 from schema_migrations where filename = $1', [file]);
      if (exists.rowCount) continue;

      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename) values ($1)', [file]);
      await client.query('commit');
      console.log(`Applied ${file}`);
    }
    console.log('Migrations up to date.');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
