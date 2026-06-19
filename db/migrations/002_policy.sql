create table if not exists policy_config (
  tenant_id uuid primary key references tenant(id),
  default_disclaimer text not null default '',
  folder_naming_pattern text not null default '{matter_ref}_{address_slug}',
  allowed_external_domains text[] not null default '{}',
  updated_by uuid references app_user(id),
  updated_at timestamptz not null default now()
);
