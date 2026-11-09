begin;
-- 20261027190000_cmpri_committed_resource_events.sql
-- LOCAL RELEASE ARTIFACT ONLY. Apply before the coordinated application release.
-- Revisions contain no business payload. A locked row serializes commit order; UUID equality
-- avoids timestamp/sequence cursor gaps. Repeated writes in one transaction coalesce.
create table if not exists public.cmpri_resource_revisions (
 hotel_id uuid not null references public.hotels(id) on delete cascade,
 resource text not null, scope text not null default '*', revision uuid not null default gen_random_uuid(),
 transaction_id bigint not null default txid_current(), primary key(hotel_id,resource,scope)
);
create table if not exists public.cmpri_event_signals (
 hotel_id uuid not null references public.hotels(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 revision uuid not null default gen_random_uuid(), transaction_id bigint not null default txid_current(),
 primary key(hotel_id,user_id)
);
alter table public.cmpri_resource_revisions enable row level security;
alter table public.cmpri_event_signals enable row level security;
revoke all on public.cmpri_resource_revisions, public.cmpri_event_signals from anon, authenticated;
grant all on public.cmpri_resource_revisions, public.cmpri_event_signals to service_role;
-- A recipient can see only their opaque wakeup; no resource name, secret or record is broadcast.
grant select on public.cmpri_event_signals to authenticated;
drop policy if exists cmpri_own_event_signal on public.cmpri_event_signals;
create policy cmpri_own_event_signal on public.cmpri_event_signals for select to authenticated using (user_id=auth.uid());

create or replace function public.cmpri_invalidate(p_hotel uuid,p_resource text,p_scope text default '*')
returns void language plpgsql security definer set search_path='' as $$
begin
 insert into public.cmpri_resource_revisions(hotel_id,resource,scope)
 values(p_hotel,p_resource,coalesce(p_scope,'*'))
 on conflict(hotel_id,resource,scope) do update set revision=gen_random_uuid(),transaction_id=txid_current()
 where cmpri_resource_revisions.transaction_id <> txid_current();
 insert into public.cmpri_event_signals(hotel_id,user_id)
 select p_hotel,m.user_id from public.hotel_members m
 where m.hotel_id=p_hotel and (p_scope='*' or m.user_id::text=p_scope) order by m.user_id
 on conflict(hotel_id,user_id) do update set revision=gen_random_uuid(),transaction_id=txid_current()
 where cmpri_event_signals.transaction_id <> txid_current();
end $$;
revoke all on function public.cmpri_invalidate(uuid,text,text) from public,anon,authenticated;
grant execute on function public.cmpri_invalidate(uuid,text,text) to service_role;

create or replace function public.cmpri_capture_resource_revision()
returns trigger language plpgsql security definer set search_path='' as $$
declare v jsonb; v_hotel uuid; v_scope text := '*'; h record;
begin
 if TG_TABLE_NAME='cmpri_room_operation_imports' and TG_OP<>'INSERT' then return case when TG_OP='DELETE' then old else new end; end if;
 if TG_OP='UPDATE' and to_jsonb(new)=to_jsonb(old) then return new; end if;
 v := case when TG_OP='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 if TG_TABLE_NAME in ('cmpri_personal_mcp_links','cmpri_mcp_oauth_tokens') then v_scope := v->>'user_id'; end if;
 if TG_TABLE_NAME in ('cmpri_dashboard_notifications','cmpri_web_push_tests','cmpri_user_notification_schedules','cmpri_web_push_subscriptions') then
   v_scope := coalesce(v->>'recipient_user_id',v->>'user_id','*');
 end if;
 v_hotel := nullif(v->>'hotel_id','')::uuid;
 if v_hotel is not null then
   perform public.cmpri_invalidate(v_hotel,TG_ARGV[0],v_scope);
   if TG_TABLE_NAME='hotel_members' then
     -- Deleted membership must still wake its former owner so the next authorized read rejects it.
     insert into public.cmpri_event_signals(hotel_id,user_id) select v_hotel,(v->>'user_id')::uuid
     where exists(select 1 from auth.users where id=(v->>'user_id')::uuid)
     on conflict(hotel_id,user_id) do update set revision=gen_random_uuid(),transaction_id=txid_current();
   end if;
   if TG_TABLE_NAME='cmpri_room_operation_imports' then
     update public.cmpri_resource_revisions set revision=(v->>'id')::uuid where hotel_id=v_hotel and resource='room-operations' and scope='*';
   end if;
   if TG_TABLE_NAME in ('cmpri_work_order_items','assets','locations') then perform public.cmpri_invalidate(v_hotel,'catalog'); end if;
   if TG_TABLE_NAME='cmpri_dashboard_notifications' then
     perform public.cmpri_invalidate(v_hotel,'mentions',v_scope);
     if v->>'notification_key' like 'staff-note:%' then perform public.cmpri_invalidate(v_hotel,'staff-notes',v_scope); end if;
   end if;
 elsif TG_TABLE_NAME in ('cmpri_personal_mcp_links','cmpri_mcp_oauth_tokens') then
   for h in select hotel_id from public.hotel_members where user_id=(v->>'user_id')::uuid loop
     perform public.cmpri_invalidate(h.hotel_id,'profile',v->>'user_id');
   end loop;
 elsif TG_TABLE_NAME='cmpri_personal_hours' then
   for h in select hotel_id from public.hotel_members where user_id=(v->>'owner_id')::uuid loop
     perform public.cmpri_invalidate(h.hotel_id,'hours',v->>'owner_id');
   end loop;
 elsif TG_TABLE_NAME='profiles' then
   for h in select hotel_id from public.hotel_members where user_id=(v->>'id')::uuid loop
     perform public.cmpri_invalidate(h.hotel_id,'users');
     perform public.cmpri_invalidate(h.hotel_id,'profile',v->>'id');
     if TG_OP<>'UPDATE' or (to_jsonb(new)->'role',to_jsonb(new)->'secondary_roles',to_jsonb(new)->'active',to_jsonb(new)->'email',to_jsonb(new)->'property_scope') is distinct from (to_jsonb(old)->'role',to_jsonb(old)->'secondary_roles',to_jsonb(old)->'active',to_jsonb(old)->'email',to_jsonb(old)->'property_scope') then
       perform public.cmpri_invalidate(h.hotel_id,'access',(v->>'id'));
     end if;
   end loop;
 else
   -- Hotel-less reference tables can affect multiple properties. Payload remains private.
   for h in select id from public.hotels loop perform public.cmpri_invalidate(h.id,TG_ARGV[0]); end loop;
 end if;
 return case when TG_OP='DELETE' then old else new end;
end $$;
revoke all on function public.cmpri_capture_resource_revision() from public,anon,authenticated;
do $$
declare r record;
begin
 for r in select * from (values
 ('work_orders','work-orders'),
 ('cmpri_work_order_history','work-orders'),
 ('cmpri_work_order_technician_views','work-orders'),
 ('cmpri_work_order_items','work-orders'),
 ('cmpri_work_order_attachments','work-orders'),
 ('cmpri_dashboard_notifications','notifications'),
 ('cmpri_work_order_mentions','mentions'),
 ('cmpri_pool_control','pool'),
 ('pool_daily_logs','pool'),
 ('pool_facilities','pool'),
 ('cmpri_pool_status','pool'),
 ('cmpri_room_operation_imports','room-operations'),
 ('user_feedback','feedback'),
 ('assets','documents'),
 ('maintenance_documents','documents'),
 ('troubleshooting_cache','documents'),
 ('cmpri_staff_notes','staff-notes'),
 ('cmpri_staff_note_reads','staff-notes'),
 ('profiles','access'),
 ('hotel_members','access'),
 ('role_permissions','access'),
 ('cmpri_work_order_drafts','drafts'),
 ('cmpri_inventory_items','catalog'),
 ('cmpri_vendors','catalog'),
 ('cmpri_vendor_contacts','catalog'),
 ('cmpri_vendor_proposals','catalog'),
 ('cmpri_asset_inventory_compatibility','catalog'),
 ('cmpri_order_ideas','catalog'),
 ('cmpri_purchasing_history_records','purchasing'),
 ('cmpri_warranty_cases','purchasing'),
 ('cmpri_supplier_followups','purchasing'),
 ('cmpri_supply_uses','catalog'),
 ('cmpri_po_orders','purchasing'),
 ('cmpri_po_lines','purchasing'),
 ('cmpri_po_shipments','purchasing'),
 ('cmpri_po_sources','purchasing'),
 ('cmpri_po_receipts','purchasing'),
 ('cmpri_purchases','purchasing'),
 ('cmpri_purchase_shipments','purchasing'),
 ('cmpri_purchasing_history','purchasing'),
 ('cmpri_enseo_assignments','enseo'),
 ('cmpri_enseo_tickets','enseo'),
 ('employment_applications','employment'),
 ('cmpri_personal_hours','hours'),
 ('cmpri_hours_entries','hours'),
 ('cmpri_hours_leave','hours'),
 ('cmpri_hours_clock_events','hours'),
 ('cmpri_winter_items','winter'),
 ('cmpri_winter_preparedness','winter'),
 ('locations','rooms'),
 ('pm_plans','pm'),
 ('cmpri_pm_proposals','pm'),
 ('cmpri_room_pm_history','pm'),
 ('cmpri_pm_source_evidence','pm'),
 ('pm_completions','pm'),
 ('cmpri_drive_po_state','drive'),
 ('cmpri_drive_po_events','drive'),
 ('cmpri_drive_po_channels','drive'),
 ('cmpri_user_notification_schedules','profile'),
 ('cmpri_web_push_subscriptions','profile'),
 ('cmpri_personal_mcp_links','profile'),
 ('cmpri_mcp_oauth_tokens','profile'),
 ('cmpri_web_push_tests','phone-test')
 ) as specs(tbl,resource) loop
   if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=r.tbl and c.relkind='r') then
     execute format('drop trigger if exists cmpri_resource_revision on public.%I',r.tbl);
     execute format('create trigger cmpri_resource_revision after insert or update or delete on public.%I for each row execute function public.cmpri_capture_resource_revision(%L)',r.tbl,r.resource);
   end if;
 end loop;
 if exists(select 1 from pg_publication where pubname='supabase_realtime')
 and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='cmpri_event_signals') then
   alter publication supabase_realtime add table public.cmpri_event_signals;
 end if;
end $$;

-- Durable committed source events, never inferred by repeatedly scanning history.
create table if not exists public.cmpri_notification_events(
 id uuid primary key default gen_random_uuid(), hotel_id uuid not null references public.hotels(id),
 kind text not null, source_id uuid not null, payload jsonb not null,
 created_at timestamptz not null default clock_timestamp(), processed_at timestamptz,
 lease_until timestamptz, lease_token uuid, attempts integer not null default 0,
 unique(kind,source_id)
);
alter table public.cmpri_notification_events enable row level security;
revoke all on public.cmpri_notification_events from anon,authenticated;
grant all on public.cmpri_notification_events to service_role;
create index if not exists cmpri_notification_events_pending on public.cmpri_notification_events(created_at) where processed_at is null;
create or replace function public.cmpri_capture_notification_event()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.cmpri_notification_events(hotel_id,kind,source_id,payload)
 values(new.hotel_id,TG_ARGV[0],new.id,to_jsonb(new)) on conflict(kind,source_id) do nothing;
 return new;
end $$;
revoke all on function public.cmpri_capture_notification_event() from public,anon,authenticated;
drop trigger if exists cmpri_committed_notification on public.cmpri_work_order_history;
create trigger cmpri_committed_notification after insert on public.cmpri_work_order_history for each row execute function public.cmpri_capture_notification_event('history');
drop trigger if exists cmpri_committed_notification on public.cmpri_work_order_technician_views;
create trigger cmpri_committed_notification after insert on public.cmpri_work_order_technician_views for each row execute function public.cmpri_capture_notification_event('view');
drop trigger if exists cmpri_committed_notification on public.user_feedback;
create trigger cmpri_committed_notification after insert on public.user_feedback for each row execute function public.cmpri_capture_notification_event('feedback');

create or replace function public.cmpri_claim_notification_events(p_hotel uuid,p_limit integer default 100)
returns setof public.cmpri_notification_events language sql security definer set search_path='' as $$
 update public.cmpri_notification_events e
 set lease_until=clock_timestamp()+interval '5 minutes',lease_token=gen_random_uuid(),attempts=attempts+1
 where e.id in (select id from public.cmpri_notification_events where hotel_id=p_hotel and processed_at is null
 and (lease_until is null or lease_until<clock_timestamp()) order by created_at,id for update skip locked limit least(greatest(p_limit,1),100))
 returning e.*;
$$;
revoke all on function public.cmpri_claim_notification_events(uuid,integer) from public,anon,authenticated;
grant execute on function public.cmpri_claim_notification_events(uuid,integer) to service_role;

-- Preserve signature/ACL for older callers during release, but never mutate an imported snapshot.
create or replace function public.cmpri_reconcile_room_operations()
returns integer language plpgsql security definer set search_path='' as $$
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 return 0;
end $$;


-- Stable baselines make first subscription/recovery distinguish changed from unchanged.
insert into public.cmpri_resource_revisions(hotel_id,resource,scope)
select h.id,r.resource,'*' from public.hotels h cross join (values ('work-orders'),('notifications'),('mentions'),('pool'),('room-operations'),('feedback'),('documents'),('staff-notes'),('profile'),('access'),('drafts'),('catalog'),('purchasing'),('enseo'),('employment'),('hours'),('winter'),('rooms'),('users'),('pm'),('gss'),('drive'),('phone-test')) as r(resource) on conflict do nothing;

-- Compare source chronology, not upload day. Preserve the existing function ACL and atomic replacement.
create or replace function public.cmpri_replace_room_operations(
  p_hotel_id uuid,
  p_report_date date,
  p_actor_id uuid,
  p_actor_name text,
  p_source_type text,
  p_rows jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_first jsonb;
  v_import_id uuid := pg_catalog.gen_random_uuid();
  v_today date := pg_catalog.timezone('America/Chicago', pg_catalog.now())::date;
  v_status_fingerprint text;
  v_status_printed_time time;
  v_expected_printed_date date;
  v_expected_printed_time time;
  v_departures_fingerprint text;
  v_existing_id uuid;
  v_latest public.cmpri_room_operation_imports%rowtype;
  v_uploaded_at timestamptz := pg_catalog.now();
  v_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_hotel_id is null or not exists (select 1 from public.hotels h where h.id = p_hotel_id) then
    raise exception 'Hotel does not exist';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cmpri-room-operations', 0));
  if p_report_date is null or p_report_date > v_today then
    raise exception 'Room Status Report printed date is missing or in the future';
  end if;
  if p_source_type not in ('paste', 'file') then
    raise exception 'Invalid room-operations source';
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Room rows must be a JSON array';
  end if;
  v_count := pg_catalog.jsonb_array_length(p_rows);
  if v_count < 1 or v_count > 500 then
    raise exception 'Room-operation row count out of range';
  end if;
  v_first := p_rows->0;
  v_status_fingerprint := nullif(v_first->>'status_fingerprint', '');
  v_status_printed_time := nullif(v_first->>'status_printed_time', '')::time;
  v_expected_printed_date := nullif(v_first->>'expected_departures_printed_date', '')::date;
  v_expected_printed_time := nullif(v_first->>'expected_departures_printed_time', '')::time;
  v_departures_fingerprint := coalesce(v_first->>'departures_fingerprint', '');
  if nullif(v_first->>'status_printed_date', '')::date is distinct from p_report_date
     or v_status_fingerprint is null then
    raise exception 'Room Status Report printed identity or fingerprint is missing';
  end if;

  select id into v_existing_id
  from public.cmpri_room_operation_imports
  where hotel_id = p_hotel_id
    and report_date = p_report_date
    and source_type <> 'legacy'
    and status_fingerprint = v_status_fingerprint
    and departures_fingerprint = v_departures_fingerprint
  order by uploaded_at desc
  limit 1;
  if v_existing_id is not null then
    return v_existing_id;
  end if;

  select * into v_latest
  from public.cmpri_room_operation_imports
  where hotel_id = p_hotel_id
  order by report_date desc, status_printed_time desc nulls last, uploaded_at desc
  limit 1;
  if found then
    if v_latest.report_date > p_report_date then
      raise exception 'Room Status Report is older than the latest accepted report';
    end if;
    if v_latest.report_date = p_report_date and v_latest.status_fingerprint is distinct from v_status_fingerprint then
      if v_status_printed_time is null or v_latest.status_printed_time is null then
        raise exception 'Room Status Report printed generation time cannot be verified against the latest accepted version';
      end if;
      if v_status_printed_time <= v_latest.status_printed_time then
        raise exception 'Room Status Report printed generation time is not newer than the latest accepted version';
      end if;
    end if;
  end if;

  if v_expected_printed_date is not null then
    if v_expected_printed_date <> p_report_date then
      raise exception 'Expected Departures printed date must match Room Status';
    end if;
    select * into v_latest
    from public.cmpri_room_operation_imports
    where hotel_id = p_hotel_id
      and source_type <> 'legacy'
      and expected_departures_printed_date is not null
    order by expected_departures_printed_date desc, expected_departures_printed_time desc nulls first, uploaded_at desc
    limit 1;
    if found then
      if v_latest.expected_departures_printed_date > v_expected_printed_date then
        raise exception 'Expected Departures report is older than the latest accepted report';
      end if;
      if v_latest.expected_departures_printed_date = v_expected_printed_date
         and v_latest.departures_fingerprint <> v_departures_fingerprint then
        if v_expected_printed_time is null or v_latest.expected_departures_printed_time is null then
          raise exception 'Expected Departures printed generation time cannot be verified against the latest accepted version';
        end if;
        if v_expected_printed_time <= v_latest.expected_departures_printed_time then
          raise exception 'Expected Departures printed generation time is not newer than the latest accepted version';
        end if;
      end if;
    end if;
  end if;

  perform set_config('cmpri.snapshot_import', 'on', true);
  insert into public.cmpri_room_operation_imports(
    id, hotel_id, report_date, source_type, status_printed_time,
    expected_departures_printed_date, expected_departures_printed_time,
    expected_departures_uploaded_at, status_fingerprint, departures_fingerprint, row_count, source_rows,
    departures_rows, report_pages, imported_by_user_id, imported_by_name, uploaded_at
  ) values (
    v_import_id, p_hotel_id, p_report_date, p_source_type, v_status_printed_time,
    v_expected_printed_date, v_expected_printed_time,
    coalesce(nullif(v_first->>'expected_departures_uploaded_at', '')::timestamptz, v_uploaded_at),
    v_status_fingerprint, v_departures_fingerprint, v_count,
    (select pg_catalog.jsonb_agg(coalesce(item.j->'source_row', item.j) order by item.j->>'room')
      from pg_catalog.jsonb_array_elements(p_rows) as item(j)),
    coalesce(v_first->'expected_departures_rows', '[]'::jsonb),
    coalesce(v_first->'report_pages', '[]'::jsonb),
    p_actor_id, pg_catalog.left(coalesce(p_actor_name, ''), 200), v_uploaded_at
  );

  delete from public.room_operations where hotel_id = p_hotel_id;

  insert into public.room_operations(
    hotel_id, room, reserved, room_status, departure_date, checkout_time,
    default_checkout_time, deadline, arrival_date, checkin_time, default_checkin_time,
    guest_name, guest_arrival_date, stay_nights, report_date, moved_from_room,
    moved_rooms, room_type, guest_code, updated_at, incoming_name, incoming_type,
    incoming_code, incoming_block_indicator, incoming_reserved, source_import_id,
    source_report_date, source_uploaded_at, checkout_source_report_date,
    checkout_source_uploaded_at, checkout_time_explicit, source_page
  )
  select
    p_hotel_id,
    nullif(pg_catalog.btrim(j->>'room'), ''),
    coalesce((j->>'reserved')::boolean, false),
    coalesce(j->>'room_status', ''),
    nullif(j->>'checkout_date', '')::date,
    nullif(j->>'checkout_time', '')::time,
    not coalesce((j->>'checkout_time_explicit')::boolean, false),
    case when nullif(j->>'checkout_date', '') is not null
      then (nullif(j->>'checkout_date', '')::date + nullif(j->>'checkout_time', '')::time) at time zone 'America/Chicago'
      else null end,
    nullif(j->>'arrival_date', '')::date,
    nullif(j->>'arrival_time', '')::time,
    nullif(j->>'arrival_time', '') is null,
    coalesce(j->>'guest_name', ''),
    nullif(j->>'guest_arrival_date', '')::date,
    greatest(0, coalesce((j->>'stay_nights')::integer, 0)),
    p_report_date,
    coalesce(j->>'move_from', ''),
    coalesce(nullif(j->>'move_from', ''), nullif(j->>'move_to', '')) is not null,
    coalesce(j->>'room_type', ''),
    coalesce(j->>'guest_code', ''),
    v_uploaded_at,
    coalesce(j->>'incoming_name', ''),
    coalesce(j->>'incoming_type', ''),
    coalesce(j->>'incoming_code', ''),
    coalesce(j->>'incoming_block_indicator', ''),
    coalesce((j->>'incoming_reserved')::boolean, false),
    v_import_id,
    p_report_date,
    v_uploaded_at,
    nullif(j->>'checkout_source_report_date', '')::date,
    coalesce(nullif(j->>'checkout_source_uploaded_at', '')::timestamptz, v_uploaded_at),
    coalesce((j->>'checkout_time_explicit')::boolean, false),
    coalesce(j->>'source_page', '')
  from pg_catalog.jsonb_array_elements(p_rows) as item(j);

  perform set_config('cmpri.snapshot_import', 'on', true);
  return v_import_id;
end;
$$;

-- Only the complete, validated replacement transaction may mutate the imported room rows.
create or replace function public.cmpri_guard_imported_snapshot()
returns trigger language plpgsql set search_path='' as $$
begin
 if current_setting('cmpri.snapshot_import',true) is distinct from 'on' then
   raise exception 'Daily Ops changes only through a successful complete snapshot import';
 end if;
 return case when TG_OP='DELETE' then old else new end;
end $$;
revoke all on function public.cmpri_guard_imported_snapshot() from public,anon,authenticated;
drop trigger if exists cmpri_guard_imported_snapshot on public.room_operations;
create trigger cmpri_guard_imported_snapshot before insert or update or delete on public.room_operations
for each row execute function public.cmpri_guard_imported_snapshot();

-- 20261027200000_cmpri_ranker_writer_coordination.sql
-- Local coordinated release artifact; does not register any external webhook.
alter table public.cmpri_room_ranker_sync_queue add column if not exists revision uuid not null default gen_random_uuid();
create table if not exists public.cmpri_ranker_writer (
 hotel_id uuid primary key references public.hotels(id), owner uuid, expires_at timestamptz
);
alter table public.cmpri_ranker_writer enable row level security;
revoke all on public.cmpri_ranker_writer from public,anon,authenticated;
grant all on public.cmpri_ranker_writer to service_role;
create or replace function public.cmpri_ranker_claim(p_hotel uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare v uuid := gen_random_uuid(); result uuid;
begin
 insert into public.cmpri_ranker_writer(hotel_id,owner,expires_at) values(p_hotel,v,clock_timestamp()+interval '15 minutes')
 on conflict(hotel_id) do update set owner=v,expires_at=clock_timestamp()+interval '15 minutes'
 where cmpri_ranker_writer.owner is null or cmpri_ranker_writer.expires_at<clock_timestamp()
 returning owner into result;
 return result;
end $$;
create or replace function public.cmpri_ranker_owned(p_hotel uuid,p_owner uuid) returns boolean
language sql security definer set search_path='' as $$
 select exists(select 1 from public.cmpri_ranker_writer where hotel_id=p_hotel and owner=p_owner and expires_at>clock_timestamp()+interval '2 minutes');
$$;
create or replace function public.cmpri_ranker_release(p_hotel uuid,p_owner uuid) returns void
language sql security definer set search_path='' as $$
 update public.cmpri_ranker_writer set owner=null,expires_at=null where hotel_id=p_hotel and owner=p_owner;
$$;
revoke all on function public.cmpri_ranker_claim(uuid),public.cmpri_ranker_owned(uuid,uuid),public.cmpri_ranker_release(uuid,uuid) from public,anon,authenticated;
grant execute on function public.cmpri_ranker_claim(uuid),public.cmpri_ranker_owned(uuid,uuid),public.cmpri_ranker_release(uuid,uuid) to service_role;
-- Each new work-order intent receives a new revision. A previous worker cannot acknowledge it.
create or replace function public.cmpri_enqueue_room_ranker_sync() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if TG_OP='INSERT' or old.room is distinct from new.room or old.issue is distinct from new.issue
 or old.status is distinct from new.status or old.display_id is distinct from new.display_id then
  insert into public.cmpri_room_ranker_sync_queue(hotel_id,work_order_id,attempts,next_attempt_at,processed_at,last_error,created_at,updated_at,revision)
  values(new.hotel_id,new.id,0,now(),null,null,now(),now(),gen_random_uuid())
  on conflict(hotel_id,work_order_id) do update set attempts=0,next_attempt_at=now(),processed_at=null,last_error=null,updated_at=now(),revision=gen_random_uuid();
 end if;
 return new;
end $$;

-- 20261027210000_cmpri_ranker_watch.sql
-- Local artifact; creates no external channel or provider registration.
create table if not exists public.cmpri_ranker_watch_channels(
 id uuid primary key,hotel_id uuid not null references public.hotels(id),file_id text not null,
 status text not null check(status in ('pending','active')),resource_id text,expires_at timestamptz not null,sync_received_at timestamptz
);
create table if not exists public.cmpri_ranker_watch_events(
 channel_id uuid references public.cmpri_ranker_watch_channels(id),message_number text,processed_at timestamptz,
 primary key(channel_id,message_number)
);
create table if not exists public.cmpri_ranker_sheet_versions(
 hotel_id uuid references public.hotels(id),file_id text,version numeric not null,primary key(hotel_id,file_id)
);
alter table public.cmpri_ranker_watch_channels enable row level security;
alter table public.cmpri_ranker_watch_events enable row level security;
alter table public.cmpri_ranker_sheet_versions enable row level security;
revoke all on public.cmpri_ranker_watch_channels,public.cmpri_ranker_watch_events,public.cmpri_ranker_sheet_versions from public,anon,authenticated;
grant all on public.cmpri_ranker_watch_channels,public.cmpri_ranker_watch_events,public.cmpri_ranker_sheet_versions to service_role;
create index if not exists cmpri_ranker_watch_pending on public.cmpri_ranker_watch_events(channel_id) where processed_at is null;
create or replace function public.cmpri_ranker_reserve_watch(p_hotel uuid,p_file text,p_id uuid,p_expiry timestamptz) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||':ranker-watch:'||p_file,0));
 if exists(select 1 from public.cmpri_ranker_watch_channels where hotel_id=p_hotel and file_id=p_file
 and ((status='pending' and expires_at>clock_timestamp()) or (status='active' and expires_at>clock_timestamp()+interval '6 hours'))) then return false; end if;
 insert into public.cmpri_ranker_watch_channels(id,hotel_id,file_id,status,expires_at) values(p_id,p_hotel,p_file,'pending',p_expiry);
 return true;
end $$;
create or replace function public.cmpri_ranker_bind_watch(p_hotel uuid,p_id uuid,p_resource text,p_expiry timestamptz,p_sync boolean default false) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 update public.cmpri_ranker_watch_channels set resource_id=p_resource,status='active',expires_at=p_expiry,sync_received_at=case when p_sync then clock_timestamp() else sync_received_at end
 where hotel_id=p_hotel and id=p_id and (resource_id is null or resource_id=p_resource)
 and p_expiry>clock_timestamp() and p_expiry<=expires_at+interval '1 minute';
 return found;
end $$;
create or replace function public.cmpri_ranker_observe_version(p_hotel uuid,p_file text,p_version text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if p_version!~'^[0-9]{1,40}$' then raise exception 'Invalid version'; end if;
 insert into public.cmpri_ranker_sheet_versions(hotel_id,file_id,version) values(p_hotel,p_file,p_version::numeric)
 on conflict(hotel_id,file_id) do update set version=excluded.version where cmpri_ranker_sheet_versions.version<excluded.version;
 if found then perform public.cmpri_invalidate(p_hotel,'room-ranker'); return true; end if;
 return false;
end $$;
revoke all on function public.cmpri_ranker_reserve_watch(uuid,text,uuid,timestamptz),public.cmpri_ranker_bind_watch(uuid,uuid,text,timestamptz,boolean),public.cmpri_ranker_observe_version(uuid,text,text) from public,anon,authenticated;
grant execute on function public.cmpri_ranker_reserve_watch(uuid,text,uuid,timestamptz),public.cmpri_ranker_bind_watch(uuid,uuid,text,timestamptz,boolean),public.cmpri_ranker_observe_version(uuid,text,text) to service_role;

-- 20261027220000_cmpri_gss_publication.sql
-- Local weekly publication storage; no schedule or provider activation occurs here.
create table if not exists public.cmpri_gss_publications(
 hotel_id uuid references public.hotels(id),report_date date,source_message_id text not null,source_hash text not null,
 report jsonb not null,published_at timestamptz not null default now(),primary key(hotel_id,report_date)
);
create table if not exists public.cmpri_gss_publication_slots(
 hotel_id uuid references public.hotels(id),slot text,owner uuid,lease_until timestamptz,completed_at timestamptz,
 primary key(hotel_id,slot)
);
alter table public.cmpri_gss_publications enable row level security;
alter table public.cmpri_gss_publication_slots enable row level security;
revoke all on public.cmpri_gss_publications,public.cmpri_gss_publication_slots from public,anon,authenticated;
grant all on public.cmpri_gss_publications,public.cmpri_gss_publication_slots to service_role;
create or replace function public.cmpri_gss_claim(p_hotel uuid,p_slot text) returns uuid
language plpgsql security definer set search_path='' as $$
declare v uuid:=gen_random_uuid(); result uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||':gss-publish',0));
 if exists(select 1 from public.cmpri_gss_publication_slots where hotel_id=p_hotel and completed_at is null and lease_until>clock_timestamp()) then return null;end if;
 insert into public.cmpri_gss_publication_slots(hotel_id,slot,owner,lease_until) values(p_hotel,p_slot,v,clock_timestamp()+interval '15 minutes')
 on conflict(hotel_id,slot) do update set owner=v,lease_until=clock_timestamp()+interval '15 minutes'
 where cmpri_gss_publication_slots.completed_at is null and cmpri_gss_publication_slots.lease_until<clock_timestamp()
 returning owner into result;return result;
end $$;
create or replace function public.cmpri_gss_finish(p_hotel uuid,p_slot text,p_owner uuid,p_date date,p_source text,p_hash text,p_report jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.cmpri_gss_publication_slots where hotel_id=p_hotel and slot=p_slot and owner=p_owner and completed_at is null and lease_until>clock_timestamp() for update;
 if not found then return false;end if;
 if p_report is not null then
  if jsonb_typeof(p_report)<>'object' or p_report->>'date'<>p_date::text or jsonb_array_length(p_report->'rankings')<>2 then raise exception 'Invalid report';end if;
  insert into public.cmpri_gss_publications(hotel_id,report_date,source_message_id,source_hash,report) values(p_hotel,p_date,p_source,p_hash,p_report)
  on conflict(hotel_id,report_date) do update set source_message_id=excluded.source_message_id,source_hash=excluded.source_hash,report=excluded.report,published_at=clock_timestamp()
  where cmpri_gss_publications.source_hash<>excluded.source_hash;
  if found then perform public.cmpri_invalidate(p_hotel,'gss');end if;
 elsif not exists(select 1 from public.cmpri_gss_publications where hotel_id=p_hotel and report_date=p_date and source_hash=p_hash) then raise exception 'Unchanged source was not previously saved';end if;
 update public.cmpri_gss_publication_slots set completed_at=clock_timestamp() where hotel_id=p_hotel and slot=p_slot and owner=p_owner;
 return true;
end $$;
revoke all on function public.cmpri_gss_claim(uuid,text),public.cmpri_gss_finish(uuid,text,uuid,date,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.cmpri_gss_claim(uuid,text),public.cmpri_gss_finish(uuid,text,uuid,date,text,text,jsonb) to service_role;

-- 20261029073000_employment_private_resume.sql

create table public.employment_resumes (
 application_id uuid primary key references public.employment_applications(id) on delete cascade,
 file_name text not null check(length(file_name) between 1 and 180),
 original_pdf bytea not null check(octet_length(original_pdf) between 5 and 3145728)
);
alter table public.employment_resumes enable row level security;
revoke all on public.employment_resumes from public,anon,authenticated;
grant select,insert,delete on public.employment_resumes to service_role;
create function public.submit_employment_with_resume(p_id uuid,p_answers jsonb,p_file_name text,p_pdf bytea) returns uuid
language plpgsql security invoker set search_path='' as $$
declare existing jsonb; prior_name text; prior_pdf bytea;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select answers into existing from public.employment_applications where id=p_id;
 if found then
  select file_name,original_pdf into prior_name,prior_pdf from public.employment_resumes where application_id=p_id;
  if existing is distinct from p_answers or prior_name is distinct from p_file_name or prior_pdf is distinct from p_pdf then raise exception 'Submission identity conflict';end if;
  return p_id;
 end if;
 if p_answers->>'department' not in ('maintenance','front') then raise exception 'Invalid department';end if;
 if (p_pdf is null) <> (p_file_name is null) then raise exception 'Incomplete attachment';end if;
 if p_pdf is not null and substring(p_pdf from 1 for 5)<>decode('255044462d','hex') then raise exception 'PDF required';end if;
 perform pg_advisory_xact_lock(hashtextextended(lower(p_answers->>'email'),0));
 if (select count(*) from public.employment_applications where lower(answers->>'email')=lower(p_answers->>'email') and created_at>now()-interval '1 hour')>=3 then raise exception 'Submission limit reached';end if;
 insert into public.employment_applications(id,answers) values(p_id,p_answers);
 if p_pdf is not null then insert into public.employment_resumes values(p_id,p_file_name,p_pdf);end if;
 return p_id;
end $$;
revoke all on function public.submit_employment_with_resume(uuid,jsonb,text,bytea) from public,anon,authenticated;
grant execute on function public.submit_employment_with_resume(uuid,jsonb,text,bytea) to service_role;

-- 20261029074000_pm_historical_item_answers.sql

alter table public.cmpri_room_pm_history add column if not exists item_answers jsonb not null default '{}'::jsonb check(jsonb_typeof(item_answers)='object');
create function public.cmpri_import_room_pm_answers(p_hotel uuid,p_rows jsonb,p_actor uuid) returns integer
language plpgsql security invoker set search_path='' as $$
declare row jsonb; current public.cmpri_room_pm_history; key text; answer jsonb; total integer:=0;
begin
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>245 then raise exception 'Bounded reviewed batch required';end if;
 for row in select value from jsonb_array_elements(p_rows) loop
  select * into current from public.cmpri_room_pm_history where hotel_id=p_hotel and room=row->>'room' and period_start=(row->>'periodStart')::date for update;
  if not found or current.completed_on is distinct from (row->>'completedOn')::date or current.source_id<>'cmpri-room-pm-2026-scott-reconciled-20261028' then raise exception 'Historical identity/date conflict';end if;
  for key,answer in select * from jsonb_each(row->'answers') loop
   if answer->>'value' not in ('complete','follow-up','na') or (answer->>'sourcePage')::integer not between 43 and 150 or length(answer->>'evidence')<1 then raise exception 'Source-supported item answer required';end if;
   if current.item_answers ? key and current.item_answers->key is distinct from answer then raise exception 'Historical answer conflict';end if;
  end loop;
  if current.item_answers is distinct from current.item_answers||(row->'answers') then
   update public.cmpri_room_pm_history set item_answers=item_answers||(row->'answers') where hotel_id=p_hotel and room=current.room and period_start=current.period_start;
   total:=total+1;
  end if;
 end loop;
 if total>0 then perform public.cmpri_invalidate(p_hotel,'pm','*');end if;
 return total;
end $$;
revoke all on function public.cmpri_import_room_pm_answers(uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.cmpri_import_room_pm_answers(uuid,jsonb,uuid) to service_role;

commit;