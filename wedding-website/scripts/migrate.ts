import { loadEnv } from './env';
import { MIGRATION_SQL, createPostgresStore } from '../lib/store/postgres';

async function main() {
  loadEnv();

  if (!process.env.DATABASE_URL) {
    console.error(
      'DATABASE_URL is not set.\n' +
        'Without it the site uses the local file store (.data/store.json) and needs\n' +
        'no migration. Set DATABASE_URL to point at Postgres, then run this again.',
    );
    process.exit(1);
  }

  await createPostgresStore().ready();
  console.log('Applied:\n');
  console.log(MIGRATION_SQL.trim());
  console.log('\nDone.');
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
