-- Component #7: tamper-evidence for the engine's event log.
--
-- Every matter_event now carries a SHA-256 over its own canonical content plus the
-- previous event's hash (a per-matter hash chain, genesis prev_hash = ''). Together
-- with the append-only trigger (065) this means: a row cannot be changed in place, and
-- a row cannot be removed, reordered or inserted without every later hash failing
-- verification (lib/server/engine/audit.ts verifyChain). The chain is recomputed and
-- checked on every audit export and by scripts/engine-audit.ts.
alter table matter_event add column if not exists prev_hash text;
alter table matter_event add column if not exists hash text;
create index if not exists matter_event_hash_idx on matter_event (matter_id, hash);

comment on column matter_event.hash is 'sha256(prev_hash || canonical(event)); see lib/server/engine/audit.ts';
