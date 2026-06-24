-- Per-matter Outlook Inbox subfolders are now OPT-IN (off by default): some firms
-- don't want their inbox reorganised. When off, createMatter skips the subfolder and
-- matched mail simply isn't auto-filed (it stays in the inbox). `prompted` tracks the
-- one-time nudge shown on the first historical import so we don't ask again.
alter table policy_config add column if not exists mail_subfolders_enabled  boolean not null default false;
alter table policy_config add column if not exists mail_subfolders_prompted boolean not null default false;
