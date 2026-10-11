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
