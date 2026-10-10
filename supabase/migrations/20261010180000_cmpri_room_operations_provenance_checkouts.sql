create table if not exists public.cmpri_room_operation_imports (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  report_date date not null,
  source_type text not null check (source_type in ('paste', 'file', 'legacy')),
  status_printed_time time,
  expected_departures_printed_date date,
  expected_departures_printed_time time,
  expected_departures_uploaded_at timestamptz,
  status_fingerprint text not null,
  departures_fingerprint text not null default '',
  row_count integer not null check (row_count between 1 and 500),
  source_rows jsonb not null,
  departures_rows jsonb not null default '[]'::jsonb,
  report_pages jsonb not null default '[]'::jsonb,
  imported_by_user_id uuid references auth.users(id) on delete set null,
  imported_by_name text not null default '',
  uploaded_at timestamptz not null default now()
);

do $$
declare
  v_constraint text;
begin
  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.cmpri_room_operation_imports'::regclass
      and contype = 'c'
      and pg_catalog.pg_get_constraintdef(oid) ilike '%source_type%'
  loop
    execute pg_catalog.format(
      'alter table public.cmpri_room_operation_imports drop constraint %I',
      v_constraint
    );
  end loop;
  alter table public.cmpri_room_operation_imports
    add constraint cmpri_room_operation_imports_source_type_check
    check (source_type in ('paste', 'file', 'photo', 'legacy'));
end;
$$;

alter table public.cmpri_room_operation_imports
  add column if not exists status_printed_time time,
  add column if not exists expected_departures_printed_date date,
  add column if not exists expected_departures_printed_time time,
  add column if not exists expected_departures_uploaded_at timestamptz,
  add column if not exists status_fingerprint text not null default '',
  add column if not exists departures_fingerprint text not null default '',
  add column if not exists source_rows jsonb not null default '[]'::jsonb,
  add column if not exists departures_rows jsonb not null default '[]'::jsonb,
  add column if not exists report_pages jsonb not null default '[]'::jsonb,
  add column if not exists uploaded_at timestamptz not null default now();

alter table public.room_operations
  add column if not exists incoming_name text not null default '',
  add column if not exists incoming_type text not null default '',
  add column if not exists incoming_code text not null default '',
  add column if not exists incoming_block_indicator text not null default '',
  add column if not exists incoming_reserved boolean not null default false,
  add column if not exists source_import_id uuid,
  add column if not exists source_report_date date,
  add column if not exists source_uploaded_at timestamptz,
  add column if not exists checkout_source_report_date date,
  add column if not exists checkout_source_uploaded_at timestamptz,
  add column if not exists checkout_time_explicit boolean not null default false,
  add column if not exists source_page text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.room_operations'::regclass
      and conname = 'room_operations_source_import_id_fkey'
  ) then
    alter table public.room_operations
      add constraint room_operations_source_import_id_fkey
      foreign key (source_import_id) references public.cmpri_room_operation_imports(id);
  end if;
end;
$$;

with snapshots as (
  select
    ro.hotel_id,
    ro.report_date,
    count(*)::integer as row_count,
    jsonb_agg(jsonb_build_object(
      'room', ro.room,
      'checkout_date', ro.departure_date,
      'checkout_time', ro.checkout_time,
      'room_status', ro.room_status,
      'arrival_date', ro.arrival_date,
      'arrival_time', ro.checkin_time,
      'move_from', ro.moved_from_room,
      'move_to', case when ro.moved_rooms then ro.room else ''::text end,
      'guest_name', ro.guest_name,
      'room_type', ro.room_type,
      'guest_code', ro.guest_code,
      'guest_arrival_date', ro.guest_arrival_date,
      'stay_nights', ro.stay_nights,
      'reserved', ro.reserved,
      'report_date', ro.report_date,
      'incoming_name', ro.incoming_name,
      'incoming_type', ro.incoming_type,
      'incoming_code', ro.incoming_code,
      'incoming_block_indicator', ro.incoming_block_indicator,
      'incoming_reserved', ro.incoming_reserved,
      'source_import_id', ro.source_import_id,
      'source_report_date', ro.source_report_date,
      'source_uploaded_at', ro.source_uploaded_at,
      'checkout_source_report_date', ro.checkout_source_report_date,
      'checkout_source_uploaded_at', ro.checkout_source_uploaded_at,
      'checkout_time_explicit', ro.checkout_time_explicit,
      'source_page', ro.source_page,
      'imported_at', ro.updated_at
    ) order by ro.room) as source_rows,
    max(ro.updated_at) as uploaded_at
  from public.room_operations ro
  where ro.report_date is not null
  group by ro.hotel_id, ro.report_date
)
insert into public.cmpri_room_operation_imports(
  hotel_id, report_date, source_type, status_fingerprint, departures_fingerprint,
  row_count, source_rows, departures_rows, report_pages, imported_by_name, uploaded_at
)
select
  snapshots.hotel_id,
  snapshots.report_date,
  'legacy',
  md5(snapshots.source_rows::text),
  '',
  snapshots.row_count,
  snapshots.source_rows,
  '[]'::jsonb,
  '[]'::jsonb,
  'Legacy room snapshot; original report metadata unavailable',
  snapshots.uploaded_at
from snapshots
where not exists (
  select 1
  from public.cmpri_room_operation_imports existing
  where existing.hotel_id = snapshots.hotel_id
    and existing.report_date = snapshots.report_date
    and existing.source_type = 'legacy'
);

create table if not exists public.cmpri_room_operation_checkout_transitions (
  id uuid primary key default gen_random_uuid(),
  room_operation_id uuid not null,
  source_import_id uuid,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  room text not null,
  departing_guest_name text not null default '',
  checkout_date date not null,
  checkout_time time not null,
  transitioned_at timestamptz not null default now(),
  unique (room_operation_id)
);

create index if not exists cmpri_room_operation_imports_date_idx
  on public.cmpri_room_operation_imports(hotel_id, report_date desc, uploaded_at desc);

alter table public.cmpri_room_operation_imports enable row level security;
alter table public.cmpri_room_operation_checkout_transitions enable row level security;
revoke all on public.cmpri_room_operation_imports from anon, authenticated;
revoke all on public.cmpri_room_operation_checkout_transitions from anon, authenticated;
grant all on public.cmpri_room_operation_imports to service_role;
grant all on public.cmpri_room_operation_checkout_transitions to service_role;

do $$
begin
  if exists (
    select 1
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'cmpri_room_operations'
      and relation.relkind in ('r', 'p')
  ) then
    if exists (
      select 1
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = 'cmpri_room_operations_legacy_archive'
    ) then
      raise exception 'Cannot preserve legacy room operations: cmpri_room_operations_legacy_archive already exists';
    end if;
    alter table public.cmpri_room_operations rename to cmpri_room_operations_legacy_archive;
  end if;
end;
$$;

create or replace view public.cmpri_room_operations
with (security_invoker = true) as
select
  ro.id,
  ro.hotel_id,
  ro.report_date,
  ro.report_date as operation_date,
  ro.room,
  ro.room as room_number,
  ro.reserved,
  ro.room_status,
  ro.room_status as status,
  ro.departure_date,
  ro.departure_date as checkout_date,
  ro.checkout_time,
  ro.default_checkout_time,
  ro.deadline,
  ro.arrival_date,
  ro.checkin_time,
  ro.checkin_time as arrival_time,
  ro.default_checkin_time,
  ro.guest_name,
  ro.guest_arrival_date,
  ro.stay_nights,
  ro.moved_from_room,
  ro.moved_from_room as move_from,
  case when ro.moved_rooms then ro.room else ''::text end as move_to,
  ro.moved_rooms,
  ro.moved_rooms as is_move,
  case when ro.moved_rooms then jsonb_build_object('from', ro.moved_from_room, 'to', ro.room) else null::jsonb end as move_details,
  ro.room_type,
  ro.guest_code,
  ro.updated_at,
  ro.updated_at as imported_at,
  ro.incoming_name,
  ro.incoming_type,
  ro.incoming_code,
  ro.incoming_block_indicator,
  ro.incoming_reserved,
  ro.source_import_id,
  ro.source_report_date,
  ro.source_uploaded_at,
  ro.checkout_source_report_date,
  ro.checkout_source_uploaded_at,
  ro.checkout_time_explicit,
  ro.source_page
from public.room_operations ro;

alter view public.cmpri_room_operations owner to postgres;
grant select on public.cmpri_room_operations to authenticated, service_role;

create or replace function public.cmpri_reconcile_room_operations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cmpri-room-operations', 0));
  for v_row in
    select id, source_import_id, hotel_id, room, guest_name, departure_date, checkout_time
    from public.room_operations
    where deadline is not null
      and deadline <= pg_catalog.now()
      and departure_date is not null
      and checkout_time is not null
      and room_status ilike '%occupied%'
    for update
  loop
    insert into public.cmpri_room_operation_checkout_transitions(
      room_operation_id, source_import_id, hotel_id, room, departing_guest_name, checkout_date, checkout_time
    ) values (
      v_row.id, v_row.source_import_id, v_row.hotel_id, v_row.room,
      coalesce(v_row.guest_name, ''), v_row.departure_date, v_row.checkout_time
    ) on conflict (room_operation_id) do nothing;

    update public.room_operations
    set room_status = 'Vacant Dirty',
        guest_name = '',
        room_type = '',
        guest_code = '',
        guest_arrival_date = null,
        stay_nights = 0,
        departure_date = null,
        checkout_time = null,
        default_checkout_time = true,
        deadline = null,
        updated_at = pg_catalog.now()
    where id = v_row.id
      and source_import_id is not distinct from v_row.source_import_id
      and departure_date = v_row.departure_date
      and checkout_time = v_row.checkout_time
      and room_status ilike '%occupied%';
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$$;

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
  if p_report_date is distinct from v_today then
    raise exception 'Room Status Report must be printed for the current America/Chicago hotel date';
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
    and source_type <> 'legacy'
  order by report_date desc, status_printed_time desc nulls first, uploaded_at desc
  limit 1;
  if found then
    if v_latest.report_date > p_report_date then
      raise exception 'Room Status Report is older than the latest accepted report';
    end if;
    if v_latest.report_date = p_report_date and v_latest.status_fingerprint <> v_status_fingerprint then
      if v_status_printed_time is null or v_latest.status_printed_time is null then
        raise exception 'Room Status Report printed generation time cannot be verified against the latest accepted version';
      end if;
      if v_status_printed_time <= v_latest.status_printed_time then
        raise exception 'Room Status Report printed generation time is not newer than the latest accepted version';
      end if;
    end if;
  end if;

  if v_expected_printed_date is not null then
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

  perform public.cmpri_reconcile_room_operations();
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

  perform public.cmpri_reconcile_room_operations();
  return v_import_id;
end;
$$;

alter function public.cmpri_reconcile_room_operations() owner to postgres;
revoke all on function public.cmpri_reconcile_room_operations() from public, anon, authenticated;
grant execute on function public.cmpri_reconcile_room_operations() to service_role;
alter function public.cmpri_replace_room_operations(uuid, date, uuid, text, text, jsonb) owner to postgres;
revoke all on function public.cmpri_replace_room_operations(uuid, date, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.cmpri_replace_room_operations(uuid, date, uuid, text, text, jsonb) to service_role;

alter table public.room_operations enable row level security;
revoke all on table public.room_operations from anon, authenticated;
grant select on table public.room_operations to authenticated, service_role;
