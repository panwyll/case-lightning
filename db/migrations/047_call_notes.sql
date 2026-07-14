-- Call notes: record a client call, transcribe it (full transcript + a summary), and
-- optionally attach it to a matter later — at which point it's indexed into that matter's
-- knowledge base. The audio itself is not stored; only the transcript + summary.
create table if not exists call_note (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenant(id) on delete cascade,
  user_id          uuid not null references app_user(id) on delete cascade,   -- who recorded it
  matter_id        uuid references matter(id) on delete set null,             -- null until assigned
  title            text,
  transcript       text not null default '',
  summary          text not null default '',
  duration_seconds int,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists call_note_tenant_idx on call_note (tenant_id, created_at desc);
create index if not exists call_note_matter_idx on call_note (matter_id);
