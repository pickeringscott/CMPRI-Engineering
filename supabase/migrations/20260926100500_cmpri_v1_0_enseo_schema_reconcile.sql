-- Reconcile the first Enseo draft schema with the current atomic move API.
-- Existing legacy columns and history rows are retained.
begin;
create extension if not exists pgcrypto;

create table if not exists public.cmpri_enseo_assignments (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete restrict,
  device_type text not null check (device_type in ('TV','STB')),
  location_id uuid not null references public.locations(id) on delete restrict,
  room_number text,
  sub_location text not null check (char_length(btrim(sub_location)) between 1 and 120),
  endpoint_code text,
  paired_asset_id uuid references public.assets(id) on delete set null,
  active boolean not null default true,
  revision bigint not null default 1,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, asset_id),
  check (paired_asset_id is null or paired_asset_id <> asset_id),
  check (device_type = 'STB' or endpoint_code is null)
);

create table if not exists public.cmpri_enseo_assignment_history (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  assignment_id uuid not null references public.cmpri_enseo_assignments(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete restrict,
  actor_user_id uuid references auth.users(id) on delete set null,
  reason text,
  from_location_id uuid references public.locations(id) on delete set null,
  from_room_number text,
  from_sub_location text,
  from_endpoint_code text,
  from_paired_asset_id uuid references public.assets(id) on delete set null,
  to_location_id uuid not null references public.locations(id) on delete restrict,
  to_room_number text,
  to_sub_location text not null,
  to_endpoint_code text,
  to_paired_asset_id uuid references public.assets(id) on delete set null,
  moved_at timestamptz not null default now()
);

alter table public.cmpri_enseo_assignments
  add column if not exists asset_id uuid,
  add column if not exists location_id uuid,
  add column if not exists sub_location text,
  add column if not exists endpoint_code text,
  add column if not exists paired_asset_id uuid,
  add column if not exists active boolean not null default true,
  add column if not exists revision bigint not null default 1,
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists sublocation text,
  add column if not exists device_id text;

alter table public.cmpri_enseo_assignments
  alter column room_number drop not null;

update public.cmpri_enseo_assignments
set sub_location = coalesce(nullif(btrim(sub_location), ''), nullif(btrim(sublocation), ''), 'Unspecified')
where sub_location is null or btrim(sub_location) = '';

with unique_locations as (
  select hotel_id, room_number, (array_agg(id))[1] as location_id
  from public.locations
  where room_number is not null and active is distinct from false
  group by hotel_id, room_number
  having count(*) = 1
)
update public.cmpri_enseo_assignments assignments
set location_id = locations.location_id
from unique_locations locations
where assignments.location_id is null
  and assignments.hotel_id = locations.hotel_id
  and assignments.room_number = locations.room_number;

with legacy_asset_candidates as (
  select assignments.id as assignment_id, assignments.hotel_id, assets.id as asset_id
  from public.cmpri_enseo_assignments assignments
  join public.assets assets
    on assets.hotel_id = assignments.hotel_id
   and assets.id = case
     when assignments.device_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       then assignments.device_id::uuid
     else null
   end
  where assignments.asset_id is null
), unique_legacy_assets as (
  select hotel_id, asset_id
  from legacy_asset_candidates
  group by hotel_id, asset_id
  having count(*) = 1
)
update public.cmpri_enseo_assignments assignments
set asset_id = candidates.asset_id
from legacy_asset_candidates candidates
join unique_legacy_assets unique_assets
  on unique_assets.hotel_id = candidates.hotel_id
 and unique_assets.asset_id = candidates.asset_id
where assignments.id = candidates.assignment_id
  and not exists (
    select 1 from public.cmpri_enseo_assignments existing
    where existing.hotel_id = candidates.hotel_id
      and existing.asset_id = candidates.asset_id
  );

alter table public.cmpri_enseo_assignment_history
  add column if not exists batch_id uuid,
  add column if not exists asset_id uuid,
  add column if not exists actor_user_id uuid,
  add column if not exists reason text,
  add column if not exists from_location_id uuid,
  add column if not exists from_room_number text,
  add column if not exists from_sub_location text,
  add column if not exists from_endpoint_code text,
  add column if not exists from_paired_asset_id uuid,
  add column if not exists to_location_id uuid,
  add column if not exists to_room_number text,
  add column if not exists to_sub_location text,
  add column if not exists to_endpoint_code text,
  add column if not exists to_paired_asset_id uuid,
  add column if not exists moved_at timestamptz,
  add column if not exists actor_id uuid,
  add column if not exists action text not null default 'move',
  add column if not exists old_value jsonb,
  add column if not exists new_value jsonb,
  add column if not exists created_at timestamptz not null default now();

alter table public.cmpri_enseo_assignment_history
  alter column action set default 'move';

update public.cmpri_enseo_assignment_history history
set batch_id = coalesce(history.batch_id, gen_random_uuid()),
    asset_id = coalesce(history.asset_id, assignments.asset_id),
    actor_user_id = coalesce(history.actor_user_id, history.actor_id),
    moved_at = coalesce(history.moved_at, history.created_at, now())
from public.cmpri_enseo_assignments assignments
where history.assignment_id = assignments.id;

update public.cmpri_enseo_assignment_history
set batch_id = coalesce(batch_id, gen_random_uuid()),
    moved_at = coalesce(moved_at, created_at, now())
where batch_id is null or moved_at is null;

create index if not exists cmpri_enseo_assignments_location_idx
  on public.cmpri_enseo_assignments(hotel_id, location_id, sub_location)
  where active = true;
create unique index if not exists cmpri_enseo_assignments_asset_unique
  on public.cmpri_enseo_assignments(hotel_id, asset_id)
  where asset_id is not null;
create unique index if not exists cmpri_enseo_stb_endpoint_uidx
  on public.cmpri_enseo_assignments(hotel_id, endpoint_code)
  where active = true and device_type = 'STB' and endpoint_code is not null;
create index if not exists cmpri_enseo_assignment_history_asset_idx
  on public.cmpri_enseo_assignment_history(hotel_id, asset_id, moved_at desc);

alter table public.cmpri_enseo_assignments enable row level security;
alter table public.cmpri_enseo_assignment_history enable row level security;
revoke all on public.cmpri_enseo_assignments from anon, authenticated;
revoke all on public.cmpri_enseo_assignment_history from anon, authenticated;
grant select, insert, update, delete on public.cmpri_enseo_assignments, public.cmpri_enseo_assignment_history to service_role;

create or replace function public.cmpri_apply_enseo_moves(
  p_hotel_id uuid,
  p_actor_user_id uuid,
  p_moves jsonb,
  p_reason text default null
)
returns setof public.cmpri_enseo_assignments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role text;
  v_batch_id uuid := gen_random_uuid();
  v_move jsonb;
  v_asset_id uuid;
  v_device_type text;
  v_location_id uuid;
  v_room_number text;
  v_sub_location text;
  v_endpoint_code text;
  v_paired_asset_id uuid;
  v_existing public.cmpri_enseo_assignments%rowtype;
  v_assignment public.cmpri_enseo_assignments%rowtype;
  v_count integer;
begin
  if p_hotel_id is null or p_actor_user_id is null then
    raise exception 'Hotel and actor are required';
  end if;
  if p_moves is null or jsonb_typeof(p_moves) <> 'array' then
    raise exception 'Moves must be a JSON array';
  end if;
  v_count := jsonb_array_length(p_moves);
  if v_count < 1 or v_count > 20 then
    raise exception 'A move batch must contain 1 to 20 devices';
  end if;

  select regexp_replace(lower(coalesce(p.role,'')), '[^a-z0-9]', '', 'g')
    into v_actor_role
  from public.profiles p
  join public.hotel_members hm on hm.user_id = p.id
  where p.id = p_actor_user_id
    and p.active = true
    and hm.hotel_id = p_hotel_id
    and hm.active = true
  limit 1;

  if v_actor_role is null or v_actor_role not in (
    'chiefengineer','engineeringmanager',
    'maintenancetechnician','technician','engineer','engineering',
    'regionalmaintenance','regionalengineer',
    'systemadmin','systemadministrator','administrator','admin'
  ) then
    raise exception 'CMPRI equipment-management permission is required';
  end if;

  if exists (
    select 1
    from (
      select value->>'asset_id' as asset_id, count(*) as n
      from jsonb_array_elements(p_moves)
      group by value->>'asset_id'
      having count(*) > 1
    ) duplicates
  ) then
    raise exception 'The same device cannot appear twice in one move batch';
  end if;

  perform 1
  from public.cmpri_enseo_assignments a
  where a.hotel_id = p_hotel_id
    and a.asset_id in (
      select (value->>'asset_id')::uuid from jsonb_array_elements(p_moves)
    )
  order by a.asset_id
  for update;

  for v_move in select value from jsonb_array_elements(p_moves)
  loop
    begin
      v_asset_id := nullif(v_move->>'asset_id','')::uuid;
      v_location_id := nullif(v_move->>'location_id','')::uuid;
      v_paired_asset_id := nullif(v_move->>'paired_asset_id','')::uuid;
    exception when invalid_text_representation then
      raise exception 'Move contains an invalid id';
    end;
    v_device_type := upper(btrim(coalesce(v_move->>'device_type','')));
    v_room_number := nullif(btrim(coalesce(v_move->>'room_number','')), '');
    v_sub_location := btrim(coalesce(v_move->>'sub_location',''));
    v_endpoint_code := nullif(upper(btrim(coalesce(v_move->>'endpoint_code',''))), '');

    if v_asset_id is null or v_location_id is null then
      raise exception 'Each move requires an asset and destination location';
    end if;
    if v_device_type not in ('TV','STB') then
      raise exception 'Device type must be TV or STB';
    end if;
    if char_length(v_sub_location) < 1 or char_length(v_sub_location) > 120 then
      raise exception 'Each move requires a room sub-location';
    end if;
    if v_device_type = 'TV' then
      v_endpoint_code := null;
    end if;

    if not exists (
      select 1 from public.assets a
      where a.id = v_asset_id and a.hotel_id = p_hotel_id and coalesce(a.active,true) = true
    ) then
      raise exception 'Every moved device must be an active CMPRI asset';
    end if;
    if not exists (
      select 1 from public.locations l
      where l.id = v_location_id and l.hotel_id = p_hotel_id and coalesce(l.active,true) = true
    ) then
      raise exception 'Every destination must be an active CMPRI location';
    end if;
    if v_paired_asset_id is not null then
      if v_paired_asset_id = v_asset_id then
        raise exception 'A device cannot be paired to itself';
      end if;
      if not exists (
        select 1 from public.assets a
        where a.id = v_paired_asset_id and a.hotel_id = p_hotel_id and coalesce(a.active,true) = true
      ) then
        raise exception 'Paired device must be an active CMPRI asset';
      end if;
    end if;

    select * into v_existing
    from public.cmpri_enseo_assignments
    where hotel_id = p_hotel_id and asset_id = v_asset_id;

    if found then
      update public.cmpri_enseo_assignments
      set device_type = v_device_type,
          location_id = v_location_id,
          room_number = v_room_number,
          sub_location = v_sub_location,
          endpoint_code = v_endpoint_code,
          paired_asset_id = v_paired_asset_id,
          active = true,
          revision = revision + 1,
          updated_by = p_actor_user_id,
          updated_at = now()
      where id = v_existing.id
      returning * into v_assignment;
    else
      insert into public.cmpri_enseo_assignments(
        hotel_id, asset_id, device_type, location_id, room_number, sub_location,
        endpoint_code, paired_asset_id, active, revision, created_by, updated_by
      ) values (
        p_hotel_id, v_asset_id, v_device_type, v_location_id, v_room_number, v_sub_location,
        v_endpoint_code, v_paired_asset_id, true, 1, p_actor_user_id, p_actor_user_id
      ) returning * into v_assignment;
    end if;

    insert into public.cmpri_enseo_assignment_history(
      batch_id, hotel_id, assignment_id, asset_id, actor_user_id, reason,
      from_location_id, from_room_number, from_sub_location, from_endpoint_code, from_paired_asset_id,
      to_location_id, to_room_number, to_sub_location, to_endpoint_code, to_paired_asset_id
    ) values (
      v_batch_id, p_hotel_id, v_assignment.id, v_asset_id, p_actor_user_id, nullif(btrim(coalesce(p_reason,'')),''),
      v_existing.location_id, v_existing.room_number, v_existing.sub_location, v_existing.endpoint_code, v_existing.paired_asset_id,
      v_assignment.location_id, v_assignment.room_number, v_assignment.sub_location, v_assignment.endpoint_code, v_assignment.paired_asset_id
    );
  end loop;

  return query
    select a.*
    from public.cmpri_enseo_assignments a
    where a.hotel_id = p_hotel_id
      and a.asset_id in (select (value->>'asset_id')::uuid from jsonb_array_elements(p_moves))
    order by a.room_number nulls last, a.sub_location, a.device_type, a.asset_id;
end;
$$;

revoke all on function public.cmpri_apply_enseo_moves(uuid, uuid, jsonb, text) from public;
revoke all on function public.cmpri_apply_enseo_moves(uuid, uuid, jsonb, text) from anon;
revoke all on function public.cmpri_apply_enseo_moves(uuid, uuid, jsonb, text) from authenticated;
grant execute on function public.cmpri_apply_enseo_moves(uuid, uuid, jsonb, text) to service_role;

commit;