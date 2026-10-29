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
