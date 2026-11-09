begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- Store the staff-selected priority separately from temporary room-driven escalation.
alter table public.work_orders
  add column ranker_base_priority text,
  add column ranker_auto_urgent boolean not null default false,
  add column ranker_base_due_by timestamptz;

create table cmpri_private.room_rank_state (
  hotel_id uuid not null,
  location_id uuid not null,
  rank text not null check (rank in ('A','B','C')),
  primary key (hotel_id, location_id)
);
revoke all on cmpri_private.room_rank_state from public, anon, authenticated;

-- Acquire one transaction lock before the statement takes any row locks. This
-- serializes both work-order and room-inventory writes, including bulk writes.
create function cmpri_private.room_ranker_lock_statement() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cmpri-room-ranker-global',0));
  return null;
end $$;
revoke all on function cmpri_private.room_ranker_lock_statement() from public,anon,authenticated;
create trigger aa_room_ranker_statement_lock before insert or update or delete on public.work_orders
for each statement execute function cmpri_private.room_ranker_lock_statement();
create trigger aa_room_ranker_location_statement_lock before insert or update or delete on public.locations
for each statement execute function cmpri_private.room_ranker_lock_statement();

-- These two existing RPCs take a work-order row lock before issuing UPDATE.
-- Acquire the same advisory lock first, preserving their entire existing bodies.
-- Refuse to overwrite an independently changed routine.
do $patch_existing$
declare r record; definition text; source_hash text;
begin
  for r in select * from (values
    ('public.cmpri_save_mentioned_work_order(uuid,uuid,uuid,integer,jsonb,uuid[],boolean)',
     'c9d03e5be5f7cfc994c608ea0b0209a2','  select * into v_before from public.work_orders'),
    ('public.cmpri_finalize_work_order_troubleshooting(uuid,uuid,uuid,uuid)',
     '5268f343c1afa8b8d11e7bc6fc7e2474','  select * into ticket from public.work_orders')
  ) as v(signature,expected,marker) loop
    select md5(btrim(replace(p.prosrc,E'\r',''),E' \n\t')),pg_get_functiondef(p.oid)
      into source_hash,definition from pg_catalog.pg_proc p where p.oid=to_regprocedure(r.signature);
    if source_hash is distinct from r.expected or position(r.marker in definition)=0 then
      raise exception 'Work-order locking routine % changed; review before applying room-ranker migration',r.signature;
    end if;
    execute replace(definition,r.marker,
      '  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(''cmpri-room-ranker-global'',0));' || E'\n' || r.marker);
  end loop;
end $patch_existing$;

create function cmpri_private.room_ranker_prepare_order() returns trigger
language plpgsql security definer set search_path='' as $$
declare internal boolean := coalesce(current_setting('cmpri.room_ranker_internal',true),'')='on';
  today timestamptz := ((now() at time zone 'America/Chicago')::date::timestamp at time zone 'UTC');
begin
  if tg_op='DELETE' then
    return old;
  end if;
  if internal then return new; end if;
  if tg_op='INSERT' then
    new.ranker_base_priority := new.priority;
    new.ranker_auto_urgent := false;
    new.ranker_base_due_by := null;
    if new.priority='Urgent' then new.due_by := today; end if;
  else
    -- Ignore client attempts to change the bookkeeping directly.
    new.ranker_base_priority := coalesce(old.ranker_base_priority,old.priority);
    new.ranker_auto_urgent := old.ranker_auto_urgent;
    new.ranker_base_due_by := old.ranker_base_due_by;
    if new.priority is distinct from old.priority then
      new.ranker_base_priority := new.priority;
      if new.priority='Urgent' then
        new.due_by := today;
        new.ranker_auto_urgent := false;
        new.ranker_base_due_by := null;
      end if;
    end if;
    if old.ranker_auto_urgent and new.ranker_auto_urgent and new.due_by is distinct from old.due_by then
      new.ranker_base_due_by := new.due_by;
      new.due_by := old.due_by;
    end if;
  end if;
  return new;
end $$;
revoke all on function cmpri_private.room_ranker_prepare_order() from public,anon,authenticated;
create trigger aa_room_ranker_prepare before insert or update or delete on public.work_orders
for each row execute function cmpri_private.room_ranker_prepare_order();

create function cmpri_private.room_ranker_location(p_hotel uuid,p_location uuid,p_room text) returns uuid
language sql stable security definer set search_path='' as $$
 select l.id from public.locations l
 where l.hotel_id=p_hotel and l.active and l.location_type='Guest Room'
   and nullif(l.room_number,'') is not null
   and (case when p_location is not null then l.id=p_location else l.name=p_room end)
 order by l.id limit 1
$$;
revoke all on function cmpri_private.room_ranker_location(uuid,uuid,text) from public,anon,authenticated;

create function cmpri_private.room_ranker_recalculate(p_hotel uuid,p_location uuid,p_notify boolean) returns void
language plpgsql security definer set search_path='' as $$
declare lows bigint; mediums bigint; highs bigint; urgents bigint; next_rank text; prior_rank text;
  room_label text; event_id uuid := gen_random_uuid(); previous_setting text;
  today timestamptz := ((now() at time zone 'America/Chicago')::date::timestamp at time zone 'UTC');
begin
  if p_location is null then return; end if;
  select l.room_number into room_label from public.locations l where l.hotel_id=p_hotel and l.id=p_location
    and l.active and l.location_type='Guest Room' and nullif(l.room_number,'') is not null;
  if not found then return; end if;
  select count(*) filter(where base='Low'),count(*) filter(where base='Medium'),
         count(*) filter(where base='High'),count(*) filter(where base='Urgent')
  into lows,mediums,highs,urgents from (
    select coalesce(w.ranker_base_priority,w.priority) base from public.work_orders w
    where w.hotel_id=p_hotel and w.status::text not in ('Completed','Closed','Will Not Do')
      and cmpri_private.room_ranker_location(w.hotel_id,w.location_id,w.room)=p_location
  ) t;
  next_rank := case when urgents>0 or highs>0 or mediums>=3 or lows>=4 then 'C'
                    when mediums>0 or lows>=3 then 'B' else 'A' end;
  insert into cmpri_private.room_rank_state(hotel_id,location_id,rank) values(p_hotel,p_location,'A') on conflict do nothing;
  select rank into prior_rank from cmpri_private.room_rank_state where hotel_id=p_hotel and location_id=p_location for update;

  -- The internal flag prevents this update from becoming a staff priority edit.
  previous_setting := coalesce(current_setting('cmpri.room_ranker_internal',true),'');
  perform set_config('cmpri.room_ranker_internal','on',true);
  with wanted as (
    select w.id,coalesce(w.ranker_base_priority,w.priority) base,w.priority,w.due_by,w.ranker_auto_urgent,w.ranker_base_due_by,
      case when w.status::text in ('Completed','Closed','Will Not Do') then coalesce(w.ranker_base_priority,w.priority)
        when coalesce(w.ranker_base_priority,w.priority)='Low' and lows>=4 then 'Urgent'
        when coalesce(w.ranker_base_priority,w.priority)='Low' and lows>=3 then 'Medium'
        when coalesce(w.ranker_base_priority,w.priority)='Medium' and mediums>=3 then 'Urgent'
        else coalesce(w.ranker_base_priority,w.priority) end desired
    from public.work_orders w where w.hotel_id=p_hotel
      and cmpri_private.room_ranker_location(w.hotel_id,w.location_id,w.room)=p_location
  ), changes as (
    select *, (desired='Urgent' and base<>'Urgent') auto_urgent from wanted
  )
  update public.work_orders w set
    ranker_base_priority=c.base,
    priority=c.desired,
    ranker_auto_urgent=c.auto_urgent,
    ranker_base_due_by=case when c.auto_urgent then case when c.ranker_auto_urgent then c.ranker_base_due_by else c.due_by end else null end,
    due_by=case when c.auto_urgent and not c.ranker_auto_urgent then today
                when not c.auto_urgent and c.ranker_auto_urgent then c.ranker_base_due_by else c.due_by end
  from changes c where w.id=c.id and (w.priority is distinct from c.desired
    or w.ranker_auto_urgent is distinct from c.auto_urgent);
  perform set_config('cmpri.room_ranker_internal',previous_setting,true);
  update cmpri_private.room_rank_state set rank=next_rank where hotel_id=p_hotel and location_id=p_location;
  if p_notify and prior_rank is distinct from next_rank then
    insert into public.cmpri_dashboard_notifications(hotel_id,recipient_user_id,notification_key,target_path,message,recorded_at,push_requested)
    select distinct p_hotel,p.id,'room-rank-change:'||event_id::text,'/engineering/room-ranking',
      left('Room '||room_label||' rank changed: '||prior_rank||' → '||next_rank||'.',500),clock_timestamp(),true
    from public.hotel_members m join public.profiles p on p.id=m.user_id
    where m.hotel_id=p_hotel and m.active and p.active
    on conflict(hotel_id,recipient_user_id,notification_key) do nothing;
  end if;
end $$;
revoke all on function cmpri_private.room_ranker_recalculate(uuid,uuid,boolean) from public,anon,authenticated;

-- Permit room-ranker notifications while retaining all existing destinations.
alter table public.cmpri_dashboard_notifications drop constraint cmpri_dashboard_notifications_target;
alter table public.cmpri_dashboard_notifications add constraint cmpri_dashboard_notifications_target check (
  (work_order_id is not null and target_path is null) or
  (work_order_id is null and (target_path = any (array['/engineering/room-operations','/engineering/pool-log','/pool','/engineering/room-ranking'])
   or target_path ~ '^/staff-notes#note-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
);

-- Silent initial reconciliation: existing rooms acquire the new rules without
-- flooding everyone's inbox with historical changes.
do $$ declare r record; begin
 for r in select id,hotel_id from public.locations where active and location_type='Guest Room' and nullif(room_number,'') is not null loop
   perform cmpri_private.room_ranker_recalculate(r.hotel_id,r.id,false);
 end loop;
end $$;

create function cmpri_private.room_ranker_after_order() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_room uuid; new_room uuid; previous_setting text;
begin
  if tg_op <> 'INSERT' then old_room:=cmpri_private.room_ranker_location(old.hotel_id,old.location_id,old.room); end if;
  if tg_op <> 'DELETE' then new_room:=cmpri_private.room_ranker_location(new.hotel_id,new.location_id,new.room); end if;
  if old_room is not null then perform cmpri_private.room_ranker_recalculate(old.hotel_id,old_room,true); end if;
  if new_room is not null and (tg_op='INSERT' or new.hotel_id is distinct from old.hotel_id or new_room is distinct from old_room) then
    perform cmpri_private.room_ranker_recalculate(new.hotel_id,new_room,true);
  end if;
  -- An escalated ticket moved out of guest inventory must return to its own priority.
  if tg_op <> 'DELETE' and new_room is null then
    previous_setting:=coalesce(current_setting('cmpri.room_ranker_internal',true),'');
    perform set_config('cmpri.room_ranker_internal','on',true);
    update public.work_orders w set priority=coalesce(w.ranker_base_priority,w.priority),
      due_by=case when w.ranker_auto_urgent then w.ranker_base_due_by else w.due_by end,
      ranker_auto_urgent=false,ranker_base_due_by=null
    where w.id=new.id
      and cmpri_private.room_ranker_location(w.hotel_id,w.location_id,w.room) is null
      and (w.ranker_auto_urgent or w.priority is distinct from coalesce(w.ranker_base_priority,w.priority));
    perform set_config('cmpri.room_ranker_internal',previous_setting,true);
  end if;
  return null;
end $$;
revoke all on function cmpri_private.room_ranker_after_order() from public,anon,authenticated;
create constraint trigger room_ranker_insert after insert on public.work_orders
  deferrable initially deferred for each row execute function cmpri_private.room_ranker_after_order();
create constraint trigger room_ranker_delete after delete on public.work_orders
  deferrable initially deferred for each row execute function cmpri_private.room_ranker_after_order();
create constraint trigger room_ranker_update after update on public.work_orders
  deferrable initially deferred for each row
  when (old.hotel_id is distinct from new.hotel_id or old.location_id is distinct from new.location_id
    or old.room is distinct from new.room or old.status is distinct from new.status
    or old.priority is distinct from new.priority
    or coalesce(old.ranker_base_priority,old.priority) is distinct from coalesce(new.ranker_base_priority,new.priority))
  execute function cmpri_private.room_ranker_after_order();

-- Inventory edits can add, remove, or remap rooms without touching a ticket.
create function cmpri_private.room_ranker_refresh_hotel(p_hotel uuid) returns void
language plpgsql security definer set search_path='' as $$
declare r record; previous_setting text;
begin
  delete from cmpri_private.room_rank_state s where s.hotel_id=p_hotel and not exists (
    select 1 from public.locations l where l.hotel_id=s.hotel_id and l.id=s.location_id
      and l.active and l.location_type='Guest Room' and nullif(l.room_number,'') is not null
  );
  for r in select l.id from public.locations l where l.hotel_id=p_hotel
    and l.active and l.location_type='Guest Room' and nullif(l.room_number,'') is not null loop
    perform cmpri_private.room_ranker_recalculate(p_hotel,r.id,true);
  end loop;
  previous_setting:=coalesce(current_setting('cmpri.room_ranker_internal',true),'');
  perform set_config('cmpri.room_ranker_internal','on',true);
  update public.work_orders w set priority=coalesce(w.ranker_base_priority,w.priority),
    due_by=case when w.ranker_auto_urgent then w.ranker_base_due_by else w.due_by end,
    ranker_auto_urgent=false,ranker_base_due_by=null
  where w.hotel_id=p_hotel and cmpri_private.room_ranker_location(w.hotel_id,w.location_id,w.room) is null
    and (w.ranker_auto_urgent or w.priority is distinct from coalesce(w.ranker_base_priority,w.priority));
  perform set_config('cmpri.room_ranker_internal',previous_setting,true);
end $$;
revoke all on function cmpri_private.room_ranker_refresh_hotel(uuid) from public,anon,authenticated;

create function cmpri_private.room_ranker_after_location() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op <> 'INSERT' then perform cmpri_private.room_ranker_refresh_hotel(old.hotel_id); end if;
  if tg_op='INSERT' or (tg_op='UPDATE' and new.hotel_id is distinct from old.hotel_id) then
    perform cmpri_private.room_ranker_refresh_hotel(new.hotel_id);
  end if;
  return null;
end $$;
revoke all on function cmpri_private.room_ranker_after_location() from public,anon,authenticated;
create constraint trigger room_ranker_location_insert after insert on public.locations
  deferrable initially deferred for each row execute function cmpri_private.room_ranker_after_location();
create constraint trigger room_ranker_location_delete after delete on public.locations
  deferrable initially deferred for each row execute function cmpri_private.room_ranker_after_location();
create constraint trigger room_ranker_location_update after update on public.locations
  deferrable initially deferred for each row
  when (old.hotel_id is distinct from new.hotel_id or old.name is distinct from new.name
    or old.room_number is distinct from new.room_number or old.active is distinct from new.active
    or old.location_type is distinct from new.location_type)
  execute function cmpri_private.room_ranker_after_location();
commit;
