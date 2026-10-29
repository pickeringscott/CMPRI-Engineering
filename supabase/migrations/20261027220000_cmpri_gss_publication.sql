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
