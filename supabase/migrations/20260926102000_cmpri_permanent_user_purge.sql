-- Schema-aware permanent purge for explicitly confirmed test accounts.
-- Real employee departures must use profile deactivation instead.
create or replace function public.purge_cmpri_user(target_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if target_id is null then
    return;
  end if;

  if pg_catalog.to_regclass('public.work_order_creator_audit') is not null then
    execute 'delete from public.work_order_creator_audit where corrected_by = $1' using target_id;
  end if;

  if pg_catalog.to_regclass('public.cmpri_work_order_drafts') is not null then
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'cmpri_work_order_drafts' and column_name = 'user_id'
    ) then
      execute 'delete from public.cmpri_work_order_drafts where user_id = $1' using target_id;
    end if;
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'cmpri_work_order_drafts' and column_name = 'created_by'
    ) then
      execute 'delete from public.cmpri_work_order_drafts where created_by = $1' using target_id;
    end if;
  end if;

  if pg_catalog.to_regclass('public.work_order_notes') is not null
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'work_order_notes' and column_name = 'author_id'
    ) then
    execute 'delete from public.work_order_notes where author_id = $1' using target_id;
  end if;

  if pg_catalog.to_regclass('public.cmpri_work_order_history') is not null
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'cmpri_work_order_history' and column_name = 'actor_user_id'
    ) then
    execute 'delete from public.cmpri_work_order_history where actor_user_id = $1' using target_id;
  end if;

  if pg_catalog.to_regclass('public.cmpri_ai_refresh_events') is not null
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'cmpri_ai_refresh_events' and column_name = 'actor_user_id'
    ) then
    execute 'delete from public.cmpri_ai_refresh_events where actor_user_id = $1' using target_id;
  end if;

  if pg_catalog.to_regclass('public.work_orders') is not null then
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'work_orders' and column_name = 'created_by'
    ) then
      execute 'delete from public.work_orders where created_by = $1' using target_id;
    end if;
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'work_orders' and column_name = 'submitted_by_user_id'
    ) then
      execute 'delete from public.work_orders where submitted_by_user_id = $1' using target_id;
    end if;
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'work_orders' and column_name = 'creator_account_user_id'
    ) then
      execute 'update public.work_orders set creator_account_user_id = null where creator_account_user_id = $1' using target_id;
    end if;
  end if;

  if pg_catalog.to_regclass('public.pool_daily_logs') is not null then
    execute 'delete from public.pool_daily_logs where created_by = $1' using target_id;
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'pool_daily_logs' and column_name = 'updated_by'
    ) then
      execute 'update public.pool_daily_logs set updated_by = null where updated_by = $1' using target_id;
    end if;
  end if;

  if pg_catalog.to_regclass('public.cmpri_enseo_assignments') is not null then
    execute 'delete from public.cmpri_enseo_assignments where created_by = $1' using target_id;
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'cmpri_enseo_assignments' and column_name = 'updated_by'
    ) then
      execute 'update public.cmpri_enseo_assignments set updated_by = null where updated_by = $1' using target_id;
    end if;
  end if;

  if pg_catalog.to_regclass('public.hotel_members') is not null then
    delete from public.hotel_members where user_id = target_id;
  end if;
  if pg_catalog.to_regclass('public.profiles') is not null then
    delete from public.profiles where id = target_id;
  end if;
end;
$$;

revoke all on function public.purge_cmpri_user(uuid) from public;
revoke all on function public.purge_cmpri_user(uuid) from anon;
revoke all on function public.purge_cmpri_user(uuid) from authenticated;
grant execute on function public.purge_cmpri_user(uuid) to service_role;