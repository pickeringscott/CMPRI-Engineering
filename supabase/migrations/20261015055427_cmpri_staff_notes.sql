begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table public.cmpri_staff_notes (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id),
  author_user_id uuid not null references public.profiles(id),
  author_name text not null check (length(author_name) between 1 and 100),
  body text not null check (length(btrim(body)) between 1 and 4000),
  parent_id uuid,
  request_id uuid not null,
  created_at timestamptz not null default now(),
  unique(hotel_id,id),
  unique(hotel_id,author_user_id,request_id),
  foreign key(hotel_id,parent_id) references public.cmpri_staff_notes(hotel_id,id)
);
create index cmpri_staff_notes_order on public.cmpri_staff_notes(hotel_id,created_at,id);
alter table public.cmpri_staff_notes enable row level security;
revoke all on public.cmpri_staff_notes from public,anon,authenticated;
grant select on public.cmpri_staff_notes to authenticated;
grant select,insert on public.cmpri_staff_notes to service_role;
create policy staff_notes_member_read on public.cmpri_staff_notes for select to authenticated
  using (public.is_hotel_member(hotel_id));

-- Service-only atomic post + inbox fan-out. No existing data is backfilled.
-- Both retries and concurrent requests return the original post without new alerts.
create function public.cmpri_post_staff_note(p_hotel uuid,p_author uuid,p_name text,p_body text,p_parent uuid,p_request uuid,p_recipients jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_body text; v_parent uuid;
begin
  if not exists(select 1 from public.profiles p join public.hotel_members m on m.user_id=p.id
    where p.id=p_author and p.active and m.hotel_id=p_hotel and m.active) then
    raise exception 'Inactive staff member';
  end if;
  insert into public.cmpri_staff_notes(hotel_id,author_user_id,author_name,body,parent_id,request_id)
    values(p_hotel,p_author,p_name,p_body,p_parent,p_request)
    on conflict(hotel_id,author_user_id,request_id) do nothing returning id into v_id;
  if v_id is null then
    select id,body,parent_id into v_id,v_body,v_parent from public.cmpri_staff_notes
      where hotel_id=p_hotel and author_user_id=p_author and request_id=p_request;
    if v_body is distinct from p_body or v_parent is distinct from p_parent then raise exception 'Request already used'; end if;
    return v_id;
  end if;
  insert into public.cmpri_dashboard_notifications(hotel_id,recipient_user_id,notification_key,target_path,message,recorded_at,push_requested)
    select distinct p_hotel,p.id,'staff-note:'||v_id::text,'/staff-notes#note-'||v_id::text,
      p_name||' posted in Staff Notes.',now(),coalesce((r->>'push')::boolean,false)
    from jsonb_array_elements(p_recipients) r join public.profiles p on p.id=(r->>'user_id')::uuid
    join public.hotel_members m on m.user_id=p.id and m.hotel_id=p_hotel
    where p.active and m.active
    on conflict(hotel_id,recipient_user_id,notification_key) do nothing;
  return v_id;
end;
$$;
revoke all on function public.cmpri_post_staff_note(uuid,uuid,text,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.cmpri_post_staff_note(uuid,uuid,text,text,uuid,uuid,jsonb) to service_role;
-- Row-level security is applied to subscriptions; API reads reauthorize separately.
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.cmpri_staff_notes;
  end if;
end $$;
commit;
