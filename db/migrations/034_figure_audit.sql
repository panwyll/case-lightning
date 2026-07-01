-- Figure history: an append-only audit of every change to a matter's key figures — who
-- changed it, when, why, and the email/document it came from. Conveyancing figures (price,
-- deposit, exchange/completion dates, lender, parties) drive real money and deadlines, so
-- their provenance matters. Populated at the write sites (manual edits, AI extraction from
-- an email); read back on the taskpane House tab.
create table if not exists matter_figure_change (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  matter_id     uuid not null references matter(id),
  field         text not null,          -- 'purchase_price' | 'completion_target_date' | a facts key
  label         text not null,          -- human label shown in the history
  old_value     text,
  new_value     text,
  source        text not null,          -- MANUAL | AI_EMAIL | AI_DOC | IMPORT | TRACKER
  actor_user_id uuid references app_user(id),   -- who; null = system with no acting user
  reason        text,                   -- why (a note, or "Read from email: <subject>")
  ref_kind      text,                   -- EMAIL | DOCUMENT | null
  ref_id        text,                   -- graph message/thread id, or document id
  ref_label     text,                   -- email subject / document filename
  ref_url       text,                   -- optional deep link (e.g. the document's web URL)
  created_at    timestamptz not null default now()
);
create index if not exists matter_figure_change_matter_idx
  on matter_figure_change (matter_id, created_at desc);
