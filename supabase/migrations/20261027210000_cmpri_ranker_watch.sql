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
