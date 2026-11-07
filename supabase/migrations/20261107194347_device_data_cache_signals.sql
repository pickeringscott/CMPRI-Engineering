begin;
-- Extend the existing content-free signal stream. No business records are exposed.
do $$
declare item record;
begin
 for item in select * from (values
  ('cmpri_inventory_items','reference'),('cmpri_inventory_movements','reference'),
  ('cmpri_asset_inventory_compatibility','reference'),('cmpri_work_order_items','orders'),
  ('cmpri_order_ideas','reference'),('cmpri_vendors','reference'),('cmpri_vendor_contacts','reference'),
  ('cmpri_vendor_proposals','reference'),('cmpri_enseo_assignments','reference'),
  ('cmpri_enseo_assignment_history','reference'),('cmpri_gss_reports','reference'),
  ('pool_daily_logs','pool'),('cmpri_pool_log_history','pool'),
  ('pm_plans','reference'),('pm_tasks','reference'),('pm_completions','reference'),
  ('cmpri_pm_plans','reference'),('cmpri_pm_tasks','reference'),('cmpri_pm_completions','reference'),
  ('cmpri_staff_notes','inbox'),('cmpri_staff_note_names','reference')
 ) as targets(table_name,topic)
 loop
  -- Optional modules can be absent; never add a row trigger to a compatibility view.
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname=item.table_name and c.relkind in ('r','p'))
   and exists(select 1 from information_schema.columns where table_schema='public' and table_name=item.table_name and column_name='hotel_id') then
   execute format('create trigger resource_device_cache after insert or update or delete on public.%I for each row execute function cmpri_private.signal_resource(%L)',item.table_name,item.topic);
  end if;
 end loop;
end $$;

create function cmpri_private.signal_cached_session() returns trigger
language plpgsql security definer set search_path='' as $$
declare item jsonb; target uuid;
begin
 item=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 target=case when tg_table_name='profiles' then (item->>'id')::uuid else (item->>'user_id')::uuid end;
 insert into public.cmpri_resource_signals(hotel_id,recipient_user_id,topic)
 select distinct m.hotel_id,m.user_id,'session' from public.hotel_members m join public.profiles p on p.id=m.user_id
 where m.user_id=target and p.active and m.active
 on conflict(hotel_id,recipient_user_id,topic) do update set revision=cmpri_resource_signals.revision+1;
 return null;
end $$;
revoke all on function cmpri_private.signal_cached_session() from public,anon,authenticated;
create trigger resource_cached_profile after update on public.profiles for each row execute function cmpri_private.signal_cached_session();
create trigger resource_cached_membership after insert or update or delete on public.hotel_members for each row execute function cmpri_private.signal_cached_session();

-- Global role grants can affect any property; invalidate active sessions without carrying profile data.
create function cmpri_private.signal_cached_permissions() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into public.cmpri_resource_signals(hotel_id,recipient_user_id,topic)
 select distinct m.hotel_id,m.user_id,'session' from public.hotel_members m join public.profiles p on p.id=m.user_id
 where p.active and m.active
 on conflict(hotel_id,recipient_user_id,topic) do update set revision=cmpri_resource_signals.revision+1;
 return null;
end $$;
revoke all on function cmpri_private.signal_cached_permissions() from public,anon,authenticated;
create trigger resource_cached_permissions after insert or update or delete on public.role_permissions for each statement execute function cmpri_private.signal_cached_permissions();
commit;
