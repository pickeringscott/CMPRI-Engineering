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
