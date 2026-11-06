begin;
-- Content-free invalidations. Business tables remain inaccessible to browser roles.
create schema if not exists cmpri_private;
revoke all on schema cmpri_private from public, anon, authenticated;
create index if not exists work_orders_hotel_status_created_page_idx on public.work_orders(hotel_id,status,created_at desc,id);
create table public.cmpri_resource_signals (
 hotel_id uuid not null, recipient_user_id uuid not null references public.profiles(id) on delete cascade,
 topic text not null check(topic in ('orders','inbox','pool','rooms','feedback','session')),
 revision bigint not null default 1, primary key(hotel_id,recipient_user_id,topic)
);
alter table public.cmpri_resource_signals enable row level security;
revoke all on public.cmpri_resource_signals from public,anon,authenticated;
grant select on public.cmpri_resource_signals to authenticated;
grant all on public.cmpri_resource_signals to service_role;
-- This function is a policy predicate, not a writable RPC. No user-controlled claims.
create function cmpri_private.active_signal_member(h uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from public.hotel_members m join public.profiles p on p.id=m.user_id
 where m.hotel_id=h and m.user_id=auth.uid() and m.active and p.active)
$$;
grant usage on schema cmpri_private to authenticated;
revoke all on function cmpri_private.active_signal_member(uuid) from public,anon,authenticated;
grant execute on function cmpri_private.active_signal_member(uuid) to authenticated;
create policy own_resource_signals on public.cmpri_resource_signals for select to authenticated
using(recipient_user_id=(select auth.uid()) and cmpri_private.active_signal_member(hotel_id));

create function cmpri_private.signal_resource() returns trigger
language plpgsql security definer set search_path='' as $$
declare row_data jsonb; h uuid; recipient uuid;
begin
 row_data=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 h=(row_data->>'hotel_id')::uuid;
 if tg_argv[0]='inbox' then recipient=(row_data->>'recipient_user_id')::uuid; end if;
 insert into public.cmpri_resource_signals(hotel_id,recipient_user_id,topic)
 select distinct h,m.user_id,tg_argv[0] from public.hotel_members m join public.profiles p on p.id=m.user_id
 where m.hotel_id=h and m.active and p.active and (recipient is null or m.user_id=recipient)
 on conflict(hotel_id,recipient_user_id,topic) do update set revision=cmpri_resource_signals.revision+1;
 return null;
end $$;
revoke all on function cmpri_private.signal_resource() from public,anon,authenticated;
create trigger resource_orders after insert or update or delete on public.work_orders for each row execute function cmpri_private.signal_resource('orders');
create trigger resource_inbox after insert or update or delete on public.cmpri_dashboard_notifications for each row execute function cmpri_private.signal_resource('inbox');
create trigger resource_pool after insert or update or delete on public.cmpri_pool_control for each row execute function cmpri_private.signal_resource('pool');
create trigger resource_rooms after insert or update or delete on public.room_operations for each row execute function cmpri_private.signal_resource('rooms');
create trigger resource_room_imports after insert or update or delete on public.cmpri_room_operation_imports for each row execute function cmpri_private.signal_resource('rooms');
create trigger resource_feedback after insert or update or delete on public.user_feedback for each row execute function cmpri_private.signal_resource('feedback');
create trigger resource_drafts after insert or update or delete on public.cmpri_work_order_drafts for each row execute function cmpri_private.signal_resource('orders');
do $$begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  alter publication supabase_realtime add table public.cmpri_resource_signals;
 end if;
end$$;

-- Prospective materialization in the same transaction as the event, without history scans.
create function cmpri_private.notification_roles(primary_role text, secondary_roles text[]) returns text[]
language sql immutable set search_path='' as $$
 select coalesce(array_agg(regexp_replace(lower(label),'[[:space:]_-]','','g')),'{}'::text[])
 from unnest(array[primary_role]||coalesce(secondary_roles,'{}'::text[])) r,
 lateral regexp_split_to_table(r,'\s*(/|\+|,|&|\mand\M)\s*','i') label
$$;
revoke all on function cmpri_private.notification_roles(text,text[]) from public,anon,authenticated;
create function cmpri_private.materialize_work_notification() returns trigger
language plpgsql security definer set search_path='' as $$
declare e jsonb=to_jsonb(new); p record; roles text[]; chief boolean; tech boolean;
 key text; message text; wid uuid; recorded timestamptz; label text; actor_role text; technician text;
begin
 wid=case when tg_table_name='work_orders' then (e->>'id')::uuid else (e->>'work_order_id')::uuid end;
 recorded=coalesce((e->>'recorded_at')::timestamptz,(e->>'viewed_at')::timestamptz,(e->>'created_at')::timestamptz,now());
 for p in select distinct pr.* from public.profiles pr join public.hotel_members m on m.user_id=pr.id
 where pr.active and m.active and m.hotel_id=(e->>'hotel_id')::uuid loop
  roles=cmpri_private.notification_roles(p.role,p.secondary_roles);
  chief=roles && array['chiefengineer','systemadmin','sysadmin','systemadministrator','administrator','admin'];
  tech=not chief and roles && array['technician','maintenancetechnician'];
  if not chief and not tech then continue; end if;
  message=null; key=null;
  if tg_table_name='work_orders' then
   key='new-order:'||wid::text;
   message='New '||coalesce(nullif(trim(e->>'display_id'),''),'Work order')||': '||coalesce(nullif(trim(e->>'room'),''),'No location')
    ||case when nullif(trim(e->>'issue'),'') is not null then ' — '||trim(e->>'issue') else '' end
    ||case when nullif(trim(e->>'status'),'') is not null then ' · '||trim(e->>'status') else '' end;
  elsif tg_table_name='cmpri_work_order_technician_views' and chief then
   key='technician-view:'||(e->>'id');
   message=coalesce(nullif(trim(e->>'work_order_display_id'),''),'Work order')||' viewed awaiting satisfying.';
  elsif tg_table_name='cmpri_work_order_history' and (e->>'actor_user_id') is distinct from p.id::text then
   actor_role=regexp_replace(lower(coalesce(e#>>'{changed_fields,actor_role}','')),'[^a-z]','','g');
   technician=trim(coalesce(e#>>'{changed_fields,technician_name}',''));
   label=coalesce(nullif(trim(e#>>'{snapshot,display_id}'),''),'Work order');
   if chief and actor_role in ('technician','maintenancetechnician') then
    key='history:'||(e->>'id');
    if e->>'event_type' in ('status_changed','closed','reopened') and nullif(e->>'new_status','') is not null then
     message=label||' ('||coalesce(nullif(trim(e#>>'{snapshot,room}'),''),'No location')||' — '||coalesce(nullif(trim(e#>>'{snapshot,issue}'),''),'No issue details')||') status changed: '||coalesce(nullif(e->>'old_status',''),'—')||' → '||(e->>'new_status')||' by '||coalesce(nullif(trim(e->>'actor_name'),''),'System')||'.';
    elsif e->>'event_type'='claimed' then message=label||' was claimed by '||coalesce(nullif(technician,''),nullif(trim(e->>'actor_name'),''),'System')||'.'; end if;
   elsif tech then
    key=e->>'id';
    if e->>'event_type' in ('assigned','claimed') and technician<>'' and lower(technician)=lower(trim(p.full_name)) then
     message=label||case when e#>>'{changed_fields,after_close}'='true' then ' was reopened and reassigned to you.' else ' was assigned to you.' end;
    elsif e->>'event_type'='claimed' and actor_role in ('engineer','chiefengineer','systemadmin','systemadministrator','administrator','admin') then
     message=label||': Claimed by Engineer';
    end if;
   end if;
  end if;
  if message is not null then
   insert into public.cmpri_dashboard_notifications(hotel_id,recipient_user_id,notification_key,work_order_id,message,recorded_at,push_requested)
   values((e->>'hotel_id')::uuid,p.id,key,wid,left(message,500),recorded,true)
   on conflict(hotel_id,recipient_user_id,notification_key) do nothing;
  end if;
 end loop;
 return null;
end $$;
revoke all on function cmpri_private.materialize_work_notification() from public,anon,authenticated;
create trigger event_work_created after insert on public.work_orders for each row execute function cmpri_private.materialize_work_notification();
create trigger event_work_history after insert on public.cmpri_work_order_history for each row execute function cmpri_private.materialize_work_notification();
create trigger event_work_viewed after insert on public.cmpri_work_order_technician_views for each row execute function cmpri_private.materialize_work_notification();
commit;
