#!/usr/bin/env bash
# Build the production bundle, start it, and check the engine works inside it (GET /api/v1/health).
# Unit tests run the source; this runs what Vercel runs. Usage: npm run smoke  (or: npm run smoke -- https://www.caselightning.co.uk)
set -euo pipefail
if [[ "${1:-}" == http* ]]; then
  body=$(curl -fsS "$1/api/v1/health") || { echo "SMOKE FAIL: $1/api/v1/health did not answer 200"; curl -sS "$1/api/v1/health"; exit 1; }
  echo "$body" | grep -q '"engine":"ok"' || { echo "SMOKE FAIL: $body"; exit 1; }
  echo "smoke ok: $1"; exit 0
fi
PORT=${SMOKE_PORT:-3107}
# Its own build folder: a dev server running on .next is left alone.
export NEXT_DIST_DIR=.next-smoke
# next build rewrites these two for its folder; put them back afterwards.
cp tsconfig.json /tmp/smoke-tsconfig.json; cp next-env.d.ts /tmp/smoke-next-env.d.ts
restore() { cp /tmp/smoke-tsconfig.json tsconfig.json; cp /tmp/smoke-next-env.d.ts next-env.d.ts; }
trap 'restore' EXIT
npx next build >/dev/null
npx next start -p "$PORT" >/tmp/smoke-next.log 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true; restore' EXIT
for _ in $(seq 1 60); do curl -fsS "http://localhost:$PORT/api/v1/health" >/dev/null 2>&1 && break; sleep 1; done
body=$(curl -sS "http://localhost:$PORT/api/v1/health")
echo "$body" | grep -q '"engine":"ok"' || { echo "SMOKE FAIL: $body"; exit 1; }
echo "smoke ok (production build)"
