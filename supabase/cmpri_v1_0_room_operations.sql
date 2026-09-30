-- CMPRI v1.0 shared daily room-operations snapshot.
-- Manual Room Status and Expected Departures uploads replace one daily snapshot atomically.

create table if not exists public.cmpri_room_operation_imports (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  report_date date not null,
  source_type text not null check (source_type in ('paste', 'file', 'photo')),
  row_count integer not null check (row_count >= 0),
  imported_by_user_id uuid references auth.users(id) on delete set null,
  imported_by_name text not null default '',
  imported_at timestamptz not null default now()
);

create table if not exists public.cmpri_room_operations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  import_id uuid not null references public.cmpri_room_operation_imports(id) on delete cascade,
  report_date date not null,
  room text not null,
  checkout_date date,
  checkout_time text not null default '',
  room_status text not null default '',
  arrival_date date,
  arrival_time text not null default '',
  move_from text not null default '',
  move_to text not null default '',
  guest_name text not null default '',
  room_type text not null default '',
  guest_code text not null default '',
  guest_arrival_date date,
  stay_nights integer not null default 0 check (stay_nights >= 0 and stay_nights <= 3650),
  reserved boolean not null default false,
  imported_at timestamptz not null default now(),
  unique (hotel_id, report_date, room)
);

alter table public.cmpri_room_operations
  add column if not exists guest_name text not null default '',
  add column if not exists room_type text not null default '',
  add column if not exists guest_code text not null default '',
  add column if not exists guest_arrival_date date,
  add column if not exists stay_nights integer not null default 0,
  add column if not exists reserved boolean not null default false;

create index if not exists cmpri_room_operations_report_idx
  on public.cmpri_room_operations(hotel_id, report_date, room);
create index if not exists cmpri_room_operation_imports_date_idx
  on public.cmpri_room_operation_imports(hotel_id, report_date, imported_at desc);

alter table public.cmpri_room_operation_imports enable row level security;
alter table public.cmpri_room_operations enable row level security;
revoke all on public.cmpri_room_operation_imports from anon, authenticated;
revoke all on public.cmpri_room_operations from anon, authenticated;

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
  v_import_id uuid;
  v_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_report_date not between (timezone('America/Chicago', now())::date - 1) and timezone('America/Chicago', now())::date then
    raise exception 'Only today''s and yesterday''s room-operation snapshots may be saved';
  end if;
  if p_source_type not in ('paste', 'file') then
    raise exception 'Invalid room-operations source';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Room-operations rows must be an array';
  end if;
  v_count := jsonb_array_length(p_rows);
  if v_count < 1 or v_count > 500 then
    raise exception 'Room-operations row count out of range';
  end if;

  delete from public.cmpri_room_operation_imports
  where hotel_id = p_hotel_id
    and (report_date = p_report_date
      or report_date < timezone('America/Chicago', now())::date - 1);

  insert into public.cmpri_room_operation_imports(
    hotel_id, report_date, source_type, row_count, imported_by_user_id, imported_by_name
  ) values (
    p_hotel_id, p_report_date, p_source_type, v_count, p_actor_id, left(coalesce(p_actor_name, ''), 200)
  ) returning id into v_import_id;

  insert into public.cmpri_room_operations(
    hotel_id, import_id, report_date, room, checkout_date, checkout_time,
    room_status, arrival_date, arrival_time, move_from, move_to,
    guest_name, room_type, guest_code, guest_arrival_date, stay_nights, reserved
  )
  select
    p_hotel_id,
    v_import_id,
    p_report_date,
    left(btrim(r.room), 20),
    nullif(r.checkout_date, '')::date,
    left(coalesce(r.checkout_time, ''), 80),
    left(coalesce(r.room_status, ''), 200),
    nullif(r.arrival_date, '')::date,
    left(coalesce(r.arrival_time, ''), 80),
    left(coalesce(r.move_from, ''), 20),
    left(coalesce(r.move_to, ''), 20),
    left(coalesce(r.guest_name, ''), 200),
    left(coalesce(r.room_type, ''), 80),
    left(coalesce(r.guest_code, ''), 80),
    nullif(r.guest_arrival_date, '')::date,
    least(greatest(coalesce(r.stay_nights, 0), 0), 3650),
    coalesce(r.reserved, false)
  from jsonb_to_recordset(p_rows) as r(
    room text,
    checkout_date text,
    checkout_time text,
    room_status text,
    arrival_date text,
    arrival_time text,
    move_from text,
    move_to text,
    guest_name text,
    room_type text,
    guest_code text,
    guest_arrival_date text,
    stay_nights integer,
    reserved boolean
  );

  return v_import_id;
end;
$$;

revoke all on function public.cmpri_replace_room_operations(uuid,date,uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.cmpri_replace_room_operations(uuid,date,uuid,text,text,jsonb) to service_role;
