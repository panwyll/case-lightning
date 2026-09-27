-- 099: no duplicate email templates or document templates within a firm.
--
-- Two paths could double up: the "seed examples" route inserted with an ON CONFLICT that had
-- no constraint to conflict on, and two first loads of the templates page could both seed the
-- engine's message templates. This folds duplicates (keeping the earliest, re-pointing every
-- reference to it) and then makes the uniqueness a constraint.

-- ── document templates: keep the earliest per (firm, name) ──
create temp table dt_keep as
  select tenant_id, name, (array_agg(id order by created_at, id))[1] as keep_id, array_agg(id order by created_at, id) as ids
    from doc_template group by tenant_id, name having count(*) > 1;

update task_template t set doc_template_id = k.keep_id
  from dt_keep k where t.doc_template_id = any(k.ids) and t.doc_template_id <> k.keep_id;
update template t set attach_doc_template_id = k.keep_id
  from dt_keep k where t.attach_doc_template_id = any(k.ids) and t.attach_doc_template_id <> k.keep_id;
update template t
   set attach_doc_template_ids = (
     select array_agg(distinct coalesce(k.keep_id, x.id))
       from unnest(t.attach_doc_template_ids) as x(id)
       left join dt_keep k on x.id = any(k.ids)
   )
 where t.attach_doc_template_ids is not null and array_length(t.attach_doc_template_ids, 1) > 0
   and exists (select 1 from dt_keep k where t.attach_doc_template_ids && k.ids);
delete from doc_template d using dt_keep k where d.id = any(k.ids) and d.id <> k.keep_id;
drop table dt_keep;
create unique index if not exists doc_template_tenant_name_uq on doc_template (tenant_id, name);

-- ── email templates: keep the earliest active per (firm, name) ──
create temp table tp_keep as
  select tenant_id, name, (array_agg(id order by created_at, id))[1] as keep_id, array_agg(id order by created_at, id) as ids
    from template where is_active group by tenant_id, name having count(*) > 1;
update task_template t set email_template_id = k.keep_id
  from tp_keep k where t.email_template_id = any(k.ids) and t.email_template_id <> k.keep_id;
do $$
declare tbl text;
begin
  foreach tbl in array array['auto_rule', 'automation'] loop
    if exists (select 1 from information_schema.columns where table_name = tbl and column_name = 'reply_template_id') then
      execute format('update %I t set reply_template_id = k.keep_id from tp_keep k where t.reply_template_id = any(k.ids) and t.reply_template_id <> k.keep_id', tbl);
    end if;
  end loop;
end $$;
delete from template d using tp_keep k where d.id = any(k.ids) and d.id <> k.keep_id;
drop table tp_keep;
create unique index if not exists template_tenant_name_active_uq on template (tenant_id, name) where is_active;
