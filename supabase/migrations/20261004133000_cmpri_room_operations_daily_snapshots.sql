-- Preserve independent room snapshots for today and yesterday.
update public.room_operations
set report_date = timezone('America/Chicago', now())::date
where report_date is null;

alter table public.room_operations
  alter column report_date set not null;

alter table public.room_operations
  drop constraint if exists room_operations_hotel_id_room_key;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.room_operations'::regclass
      and conname = 'room_operations_hotel_report_date_room_key'
  ) then
    alter table public.room_operations
      add constraint room_operations_hotel_report_date_room_key
      unique (hotel_id, report_date, room);
  end if;
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
  v_import_id uuid := pg_catalog.gen_random_uuid();
  v_today date := pg_catalog.timezone('America/Chicago', pg_catalog.now())::date;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_hotel_id is null then
    raise exception 'Hotel id is required';
  end if;
  if p_report_date is null or p_report_date not between v_today - 1 and v_today then
    raise exception 'Only today''s and yesterday''s room-operation snapshots may be saved';
  end if;
  if p_source_type not in ('paste', 'file') then
    raise exception 'Invalid room-operations source';
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Room rows must be a JSON array';
  end if;
  if pg_catalog.jsonb_array_length(p_rows) < 1 or pg_catalog.jsonb_array_length(p_rows) > 500 then
    raise exception 'Room-operation row count out of range';
  end if;
  if not exists (
    select 1
    from public.hotels h
    where h.id = p_hotel_id
  ) then
    raise exception 'Hotel does not exist';
  end if;

  delete from public.room_operations
  where hotel_id = p_hotel_id
    and (report_date = p_report_date or report_date < v_today - 1);

  insert into public.room_operations (
    hotel_id,
    room,
    reserved,
    room_status,
    departure_date,
    checkout_time,
    default_checkout_time,
    deadline,
    arrival_date,
    checkin_time,
    default_checkin_time,
    guest_name,
    guest_arrival_date,
    stay_nights,
    report_date,
    moved_from_room,
    moved_rooms,
    room_type,
    guest_code,
    updated_at
  )
  select
    p_hotel_id,
    nullif(pg_catalog.btrim(j->>'room'), ''),
    coalesce((j->>'reserved')::boolean, false),
    coalesce(j->>'room_status', ''),
    nullif(j->>'checkout_date', '')::date,
    nullif(j->>'checkout_time', '')::time,
    nullif(j->>'checkout_time', '') is null,
    null,
    nullif(j->>'arrival_date', '')::date,
    nullif(j->>'arrival_time', '')::time,
    nullif(j->>'arrival_time', '') is null,
    coalesce(j->>'guest_name', ''),
    nullif(j->>'guest_arrival_date', '')::date,
    greatest(0, coalesce((j->>'stay_nights')::integer, 0)),
    p_report_date,
    coalesce(j->>'move_from', ''),
    (
      coalesce(nullif(j->>'move_from', ''), nullif(j->>'move_to', ''))
      is not null
    ),
    coalesce(j->>'room_type', ''),
    coalesce(j->>'guest_code', ''),
    pg_catalog.now()
  from pg_catalog.jsonb_array_elements(p_rows) as item(j);

  return v_import_id;
end;
$$;

alter function public.cmpri_replace_room_operations(uuid, date, uuid, text, text, jsonb) owner to postgres;
revoke all on function public.cmpri_replace_room_operations(uuid, date, uuid, text, text, jsonb) from public, anon, authenticated;
grant all on function public.cmpri_replace_room_operations(uuid, date, uuid, text, text, jsonb) to service_role;

alter table public.room_operations enable row level security;
revoke all on table public.room_operations from anon, authenticated;
grant select on table public.room_operations to authenticated;

drop policy if exists room_operations_member_access on public.room_operations;
drop policy if exists room_operations_dashboard_select on public.room_operations;
create policy room_operations_dashboard_select
  on public.room_operations
  for select
  to authenticated
  using (
    public.is_hotel_member(hotel_id)
    and public.cmpri_can_view_work_orders(hotel_id)
  );
