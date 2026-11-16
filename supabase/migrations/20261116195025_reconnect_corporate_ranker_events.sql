begin;

-- One durable revision per committed transaction. Nothing polls this table.
create table public.cmpri_corporate_ranker_state (
  hotel_id uuid primary key,
  revision bigint not null default 0,
  delivered_revision bigint not null default 0,
  source_txid bigint,
  owner uuid,
  lease_until timestamptz,
  last_error text,
  last_delivered_at timestamptz,
  updated_at timestamptz not null default now(),
  check (delivered_revision <= revision)
);
alter table public.cmpri_corporate_ranker_state enable row level security;
revoke all on public.cmpri_corporate_ranker_state from public, anon, authenticated;
grant all on public.cmpri_corporate_ranker_state to service_role;

create or replace function cmpri_private.wake_corporate_ranker(p_hotel uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare dispatch_secret text;
begin
  select decrypted_secret into dispatch_secret from vault.decrypted_secrets
    where name = 'cmpri_corporate_ranker_dispatch';
  if dispatch_secret is null then return; end if;
  perform net.http_post(url := 'https://www.cmpri-engineering.com/api/integrations/room-ranker/sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || dispatch_secret),
    body := jsonb_build_object('event', 'corporate_ranker_changed', 'hotel_id', p_hotel),
    timeout_milliseconds := 65000);
exception when others then
  -- A delivery outage cannot roll back a saved work order. Intent stays durable.
  update public.cmpri_corporate_ranker_state set last_error = 'Change webhook could not be queued.' where hotel_id = p_hotel;
end $$;
revoke all on function cmpri_private.wake_corporate_ranker(uuid) from public, anon, authenticated;

create or replace function cmpri_private.mark_corporate_ranker(p_hotel uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare marked uuid;
begin
  if p_hotel is distinct from 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'::uuid then return; end if;
  insert into public.cmpri_corporate_ranker_state(hotel_id,revision,source_txid)
    values(p_hotel,1,txid_current())
    on conflict(hotel_id) do update set revision = cmpri_corporate_ranker_state.revision + 1,
      source_txid = txid_current(), updated_at = now()
    where cmpri_corporate_ranker_state.source_txid is distinct from txid_current()
    returning hotel_id into marked;
  if marked is not null then perform cmpri_private.wake_corporate_ranker(marked); end if;
end $$;
revoke all on function cmpri_private.mark_corporate_ranker(uuid) from public, anon, authenticated;

create or replace function cmpri_private.corporate_ranker_order_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and
    (old.hotel_id,old.location_id,old.room,old.display_id,old.issue,old.status,old.priority,old.ranker_base_priority)
    is not distinct from
    (new.hotel_id,new.location_id,new.room,new.display_id,new.issue,new.status,new.priority,new.ranker_base_priority)
    then return null; end if;
  if tg_op <> 'INSERT' then
    if exists(select 1 from public.locations l where l.hotel_id=old.hotel_id and l.active and l.location_type='Guest Room'
      and (l.id=old.location_id or (old.location_id is null and l.name=old.room)))
      then perform cmpri_private.mark_corporate_ranker(old.hotel_id); end if;
  end if;
  if tg_op <> 'DELETE' then
    if exists(select 1 from public.locations l where l.hotel_id=new.hotel_id and l.active and l.location_type='Guest Room'
      and (l.id=new.location_id or (new.location_id is null and l.name=new.room)))
      then perform cmpri_private.mark_corporate_ranker(new.hotel_id); end if;
  end if;
  return null;
end $$;
revoke all on function cmpri_private.corporate_ranker_order_changed() from public, anon, authenticated;
create trigger corporate_ranker_order_changed after insert or update or delete on public.work_orders
  for each row execute function cmpri_private.corporate_ranker_order_changed();

create or replace function cmpri_private.corporate_ranker_location_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and
    (old.hotel_id,old.name,old.room_number,old.location_type,old.active) is not distinct from
    (new.hotel_id,new.name,new.room_number,new.location_type,new.active) then return null; end if;
  if tg_op <> 'INSERT' and old.location_type='Guest Room' then perform cmpri_private.mark_corporate_ranker(old.hotel_id); end if;
  if tg_op <> 'DELETE' and new.location_type='Guest Room' then perform cmpri_private.mark_corporate_ranker(new.hotel_id); end if;
  return null;
end $$;
revoke all on function cmpri_private.corporate_ranker_location_changed() from public, anon, authenticated;
create trigger corporate_ranker_location_changed after insert or update or delete on public.locations
  for each row execute function cmpri_private.corporate_ranker_location_changed();

-- Service-only RPCs. Claims serialize workers; their expiry is crash recovery
-- on the NEXT EVENT, never a scheduled fetch or timed retry.
create or replace function public.cmpri_corporate_ranker_claim(p_hotel uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare claimed public.cmpri_corporate_ranker_state;
begin
  update public.cmpri_corporate_ranker_state set owner = gen_random_uuid(), lease_until = now() + interval '5 minutes'
    where hotel_id=p_hotel and revision>delivered_revision and (owner is null or lease_until < now())
    returning * into claimed;
  if claimed.hotel_id is null then return null; end if;
  return jsonb_build_object('owner',claimed.owner,'revision',claimed.revision);
end $$;

create or replace function public.cmpri_corporate_ranker_finish(p_hotel uuid, p_owner uuid, p_revision bigint, p_error text default null) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare finished public.cmpri_corporate_ranker_state;
begin
  update public.cmpri_corporate_ranker_state set
    delivered_revision = case when p_error is null then greatest(delivered_revision,least(p_revision,revision)) else delivered_revision end,
    last_delivered_at = case when p_error is null then now() else last_delivered_at end,
    last_error = left(p_error,2000), owner = null, lease_until = null
    where hotel_id=p_hotel and owner=p_owner returning * into finished;
  if finished.hotel_id is null then return false; end if;
  -- A newer committed change arrived during this delivery. Continue immediately
  -- from that event. A failure alone never starts a recurring retry loop.
  if finished.revision > p_revision then perform cmpri_private.wake_corporate_ranker(p_hotel); end if;
  return true;
end $$;

create or replace function public.cmpri_corporate_ranker_request(p_hotel uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  -- Explicit initial reconciliation or operator retry, using CURRENT data.
  perform cmpri_private.mark_corporate_ranker(p_hotel);
end $$;
revoke all on function public.cmpri_corporate_ranker_claim(uuid) from public, anon, authenticated;
revoke all on function public.cmpri_corporate_ranker_finish(uuid,uuid,bigint,text) from public, anon, authenticated;
revoke all on function public.cmpri_corporate_ranker_request(uuid) from public, anon, authenticated;
grant execute on function public.cmpri_corporate_ranker_claim(uuid) to service_role;
grant execute on function public.cmpri_corporate_ranker_finish(uuid,uuid,bigint,text) to service_role;
grant execute on function public.cmpri_corporate_ranker_request(uuid) to service_role;
grant usage on schema cmpri_private to service_role;
grant execute on function cmpri_private.wake_corporate_ranker(uuid) to service_role;
grant execute on function cmpri_private.mark_corporate_ranker(uuid) to service_role;

commit;
