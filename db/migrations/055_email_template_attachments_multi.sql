-- 055: an email template can carry MULTIPLE documents. Replaces the single
-- attach_doc_template_id (054) with an array; backfills the single value if 054 ran.
alter table template add column if not exists attach_doc_template_ids uuid[] not null default '{}';

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'template' and column_name = 'attach_doc_template_id'
  ) then
    update template
       set attach_doc_template_ids = array[attach_doc_template_id]
     where attach_doc_template_id is not null
       and (attach_doc_template_ids is null or attach_doc_template_ids = '{}');
  end if;
end $$;
