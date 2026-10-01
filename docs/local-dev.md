# Running the whole app locally

`next dev` uses a local Postgres database with a demo firm, so every signed-in page works on localhost.

```bash
npm run dev:db              # create conveyi_dev, run every migration, seed the demo firm (once)
bash scripts/dev-db.sh --fresh   # drop it and start again
```

Then sign in at `http://localhost:3000/api/v1/dev/sign-in`. Add `?as=email` to sign in as someone else, and `&next=/conveyi/...` to choose where you land.

**What is in the demo firm:**
- Anwyll & Co (Demo), with Peter (admin and platform admin), Asha, Ben and Chloe.
- Four live cases run by the real engine: a purchase, a sale, a leasehold purchase and a remortgage.
- About 800 finished cases over two years, for Analytics.
- Fees, targets and client feedback.
- A client portal for DEMO-001. The seed prints its link, and the code appears on the page in development.

**Setup files:**
- `.env.development.local` (gitignored) holds the local settings. It is read only by `next dev`, never by builds, the smoke test or production.
- Microsoft sign-in and Graph do not work locally; the Azure values in that file are placeholders.
- `db/local/000_outside_migrations.sql` creates what prod has that the migrations do not (the `leads` table and Supabase's roles).

The sign-in route refuses to exist in production, or against any database that is not on this machine.
