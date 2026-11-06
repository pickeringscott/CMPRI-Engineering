begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.cmpri_staff_notes add column attachments jsonb not null default '[]';
alter table public.cmpri_staff_notes add column gif_ids jsonb not null default '[]' check(jsonb_typeof(gif_ids)='array' and jsonb_array_length(gif_ids)<=20);
alter table public.cmpri_staff_notes add column hashtags text[] not null default '{}';
alter table public.cmpri_staff_notes drop constraint cmpri_staff_notes_body_check;
alter table public.cmpri_staff_notes add constraint cmpri_staff_notes_body_check
  check (length(body) <= 4000 and (length(btrim(body)) > 0 or jsonb_array_length(attachments) > 0 or jsonb_array_length(gif_ids) > 0));
alter table public.cmpri_staff_notes add constraint staff_note_attachments_array
  check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 20);
create index staff_notes_hashtags on public.cmpri_staff_notes using gin(hashtags);

create table public.cmpri_staff_note_uploads (
  id uuid primary key,
  hotel_id uuid not null references public.hotels(id),
  author_user_id uuid not null references public.profiles(id),
  note_id uuid,
  name text not null check(length(name) between 1 and 255),
  media_type text not null,
  size_bytes bigint not null check(size_bytes between 1 and 104857600),
  storage_path text not null unique,
  ready boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key(hotel_id,note_id) references public.cmpri_staff_notes(hotel_id,id)
);
alter table public.cmpri_staff_note_uploads enable row level security;
revoke all on public.cmpri_staff_note_uploads from public,anon,authenticated;
grant select,insert,update,delete on public.cmpri_staff_note_uploads to service_role;
insert into storage.buckets(id,name,public,file_size_limit)
  values('staff-note-files','staff-note-files',false,104857600)
  on conflict(id) do nothing;

-- Only the reauthorizing server API can attach uploads and fan out existing recipients.
create function public.cmpri_post_staff_note_with_files(
  p_hotel uuid,p_author uuid,p_name text,p_body text,p_parent uuid,p_request uuid,
  p_recipients jsonb,p_uploads uuid[],p_hashtags text[],p_gifs jsonb default '[]'
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_previous public.cmpri_staff_notes; v_files jsonb;
begin
  if not exists(select 1 from public.profiles p join public.hotel_members m on m.user_id=p.id
    where p.id=p_author and p.active and m.hotel_id=p_hotel and m.active) then raise exception 'Inactive staff member'; end if;
  if p_gifs is null or jsonb_typeof(p_gifs)<>'array' then raise exception 'Invalid GIFs'; end if;
  if cardinality(p_uploads)+jsonb_array_length(p_gifs)>20 or exists(select 1 from jsonb_array_elements(p_gifs) g where jsonb_typeof(g)<>'string' or (g#>>'{}') !~ '^[a-zA-Z0-9_-]{1,200}$') then raise exception 'Invalid GIFs'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||p_author::text||p_request::text,0));
  select * into v_previous from public.cmpri_staff_notes
    where hotel_id=p_hotel and author_user_id=p_author and request_id=p_request;
  if found then
    if v_previous.body is distinct from p_body or v_previous.parent_id is distinct from p_parent
      or v_previous.author_name is distinct from p_name or v_previous.gif_ids is distinct from p_gifs
      or array(select (v->>'id')::uuid from jsonb_array_elements(v_previous.attachments) v order by v->>'id')
        is distinct from array(select distinct unnest(p_uploads) order by 1) then raise exception 'Request already used'; end if;
    return v_previous.id;
  end if;
  if cardinality(p_uploads)>20 or cardinality(p_uploads)<> (select count(distinct x) from unnest(p_uploads) x) then raise exception 'Invalid attachments'; end if;
  perform 1 from public.cmpri_staff_note_uploads where id=any(p_uploads) order by id for update;
  if (select count(*) from public.cmpri_staff_note_uploads where id=any(p_uploads) and hotel_id=p_hotel
    and author_user_id=p_author and ready and note_id is null) <> cardinality(p_uploads) then raise exception 'Unverified attachments'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'type',media_type,'size',size_bytes) order by id),'[]')
    into v_files from public.cmpri_staff_note_uploads where id=any(p_uploads);
  insert into public.cmpri_staff_notes(hotel_id,author_user_id,author_name,body,parent_id,request_id,attachments,hashtags,gif_ids)
    values(p_hotel,p_author,p_name,p_body,p_parent,p_request,v_files,p_hashtags,p_gifs) returning id into v_id;
  update public.cmpri_staff_note_uploads set note_id=v_id where id=any(p_uploads);
  insert into public.cmpri_dashboard_notifications(hotel_id,recipient_user_id,notification_key,target_path,message,recorded_at,push_requested)
    select distinct p_hotel,p.id,'staff-note:'||v_id::text,'/staff-notes#note-'||v_id::text,
      p_name||' posted in Staff Notes.',now(),coalesce((r->>'push')::boolean,false)
    from jsonb_array_elements(p_recipients) r join public.profiles p on p.id=(r->>'user_id')::uuid
    join public.hotel_members m on m.user_id=p.id and m.hotel_id=p_hotel
    where p.active and m.active on conflict(hotel_id,recipient_user_id,notification_key) do nothing;
  return v_id;
end $$;
revoke all on function public.cmpri_post_staff_note_with_files(uuid,uuid,text,text,uuid,uuid,jsonb,uuid[],text[],jsonb) from public,anon,authenticated;
grant execute on function public.cmpri_post_staff_note_with_files(uuid,uuid,text,text,uuid,uuid,jsonb,uuid[],text[],jsonb) to service_role;

create function public.cmpri_staff_note_tags(p_hotel uuid)
returns table(tag text, count bigint) language sql stable security invoker set search_path='' as $$
 select t,count(*) from public.cmpri_staff_notes n cross join lateral unnest(n.hashtags) t
 where n.hotel_id=p_hotel group by t order by count(*) desc,t;
$$;
revoke all on function public.cmpri_staff_note_tags(uuid) from public,anon,authenticated;
grant execute on function public.cmpri_staff_note_tags(uuid) to service_role;
-- Serialize optional supplements against the exact guest snapshot they were prepared from.
create function public.cmpri_commit_guest_reports(p_hotel uuid,p_actor uuid,p_actor_name text,p_date date,p_previous uuid,p_rows jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_latest uuid; v_result uuid; v_moves text;
begin
  if not exists(select 1 from public.hotel_members m join public.profiles p on p.id=m.user_id
    where m.hotel_id=p_hotel and m.user_id=p_actor and m.active and p.active) then raise exception 'Inactive staff member'; end if;
  perform pg_advisory_xact_lock(hashtextextended('cmpri-room-operations',0));
  select id into v_latest from public.cmpri_room_operation_imports where hotel_id=p_hotel
    order by report_date desc,status_printed_time desc nulls last,uploaded_at desc limit 1;
  if v_latest is distinct from p_previous then raise exception 'A newer room report was accepted. Review this import again.'; end if;
  select public.cmpri_replace_room_operations(p_hotel,p_date,p_actor,p_actor_name,'file',p_rows) into v_result;
  select string_agg((r->>'guest_name')||': Room '||(r->>'move_from')||' to '||(r->>'room'),'; ' order by r->>'room') into v_moves
    from jsonb_array_elements(p_rows) r where coalesce(r->>'move_from','')<>'';
  if v_moves is not null then
    insert into public.cmpri_dashboard_notifications(hotel_id,recipient_user_id,notification_key,target_path,message,recorded_at,push_requested)
      select p_hotel,p.id,'room-operations:'||v_result::text,'/engineering/room-operations','Room Moves: '||v_moves,now(),true
      from public.profiles p join public.hotel_members m on m.user_id=p.id and m.hotel_id=p_hotel
      where p.active and m.active and (lower(replace(p.role::text,' ','_')) in ('engineer','chief_engineer')
        or exists(select 1 from unnest(p.secondary_roles) role where lower(replace(role,' ','_')) in ('engineer','chief_engineer')))
      on conflict(hotel_id,recipient_user_id,notification_key) do nothing;
  end if;
  return v_result;
end $$;
revoke all on function public.cmpri_commit_guest_reports(uuid,uuid,text,date,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.cmpri_commit_guest_reports(uuid,uuid,text,date,uuid,jsonb) to service_role;
commit;
