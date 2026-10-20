#!/usr/bin/env bash
# Local development only: a local Postgres database for `next dev` (.env.development.local), with every migration,
# the demo firm (scripts/dev-seed.ts) and its book of live cases (scripts/dev-book.ts). --fresh drops it and starts again.
set -euo pipefail
DB=conveyi_dev
if [[ "${1:-}" == "--fresh" ]]; then dropdb -h localhost --if-exists "$DB"; fi
createdb -h localhost "$DB" 2>/dev/null || true
psql -h localhost -d "$DB" -q -f db/local/000_outside_migrations.sql
DATABASE_URL="postgres://localhost/$DB" npx tsx scripts/migrate.ts | tail -1
DATABASE_URL="postgres://localhost/$DB" npx tsx scripts/dev-seed.ts
# A book of made-up live cases at every point, staged through the engine with nothing sent (scripts/dev-book.ts).
DATABASE_URL="postgres://localhost/$DB" npx tsx scripts/dev-book.ts
