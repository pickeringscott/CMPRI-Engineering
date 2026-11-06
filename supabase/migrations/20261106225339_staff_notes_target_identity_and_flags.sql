begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Display-only Front Desk names are not profiles, accounts or push recipients.
create table public.cmpri_staff_note_names (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id),
  name text not null check(length(name) between 1 and 80 and name !~ '[[:cntrl:]]'),
  name_key text generated always as (lower(btrim(regexp_replace(name,'\s+',' ','g')))) stored,
  created_at timestamptz not null default now(),
  unique(hotel_id,id),
  unique(hotel_id,name_key)
);
alter table public.cmpri_staff_note_names enable row level security;
revoke all on public.cmpri_staff_note_names from public,anon,authenticated;
grant select on public.cmpri_staff_note_names to authenticated;
grant select,insert on public.cmpri_staff_note_names to service_role;
create policy staff_note_names_member_read on public.cmpri_staff_note_names for select to authenticated
  using (public.is_hotel_member(hotel_id));
-- Preserve historical author text. Only seed display targets from recorded shared-account names.
insert into public.cmpri_staff_note_names(hotel_id,name,created_at)
select n.hotel_id,(array_agg(n.author_name order by n.created_at,n.id))[1],min(n.created_at)
from public.cmpri_staff_notes n join public.profiles p on p.id=n.author_user_id
where length(n.author_name) between 1 and 80 and n.author_name !~ '[[:cntrl:]]'
  and lower(btrim(n.author_name)) not in ('front desk','staff')
  and exists(select 1 from regexp_split_to_table(concat_ws(',',p.role::text,array_to_string(p.secondary_roles,',')),'\s*(/|\+|,|&|\mand\M)\s*') r
    where lower(regexp_replace(r,'[^a-zA-Z]','','g')) in ('frontdesk','salesmanager'))
group by n.hotel_id,lower(btrim(regexp_replace(n.author_name,'\s+',' ','g')))
on conflict(hotel_id,name_key) do nothing;

alter table public.cmpri_staff_notes add column mentions jsonb not null default '[]'
  check(jsonb_typeof(mentions)='array' and jsonb_array_length(mentions)<=100);
alter table public.cmpri_staff_notes add column author_name_id uuid;
alter table public.cmpri_staff_notes add constraint staff_note_author_name_property
  foreign key(hotel_id,author_name_id) references public.cmpri_staff_note_names(hotel_id,id);
create index cmpri_staff_notes_author_name on public.cmpri_staff_notes(hotel_id,author_name_id)
  where author_name_id is not null;

create function public.cmpri_capture_staff_note_name(p_hotel uuid,p_actor uuid,p_name text)
returns table(id uuid,name text) language plpgsql security invoker set search_path='' as $$
declare v_name text:=btrim(regexp_replace(p_name,'\s+',' ','g'));
begin
  if not exists(select 1 from public.profiles p join public.hotel_members m on m.user_id=p.id
    where p.id=p_actor and p.active and m.hotel_id=p_hotel and m.active) then raise exception 'Inactive staff member'; end if;
  if v_name is null or length(v_name) not between 1 and 80 or v_name ~ '[[:cntrl:]]' then raise exception 'Enter your name'; end if;
  insert into public.cmpri_staff_note_names(hotel_id,name) values(p_hotel,v_name) on conflict(hotel_id,name_key) do nothing;
  return query select t.id,t.name from public.cmpri_staff_note_names t where t.hotel_id=p_hotel and t.name_key=lower(v_name);
end $$;
revoke all on function public.cmpri_capture_staff_note_name(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.cmpri_capture_staff_note_name(uuid,uuid,text) to service_role;

-- Reuse the existing atomic media/notification transaction; keep mention identity in that same transaction.
create function public.cmpri_post_staff_note_with_mentions(
  p_hotel uuid,p_author uuid,p_name text,p_body text,p_parent uuid,p_request uuid,
  p_recipients jsonb,p_uploads uuid[],p_hashtags text[],p_gifs jsonb,p_mentions jsonb,p_name_id uuid default null
) returns uuid language plpgsql security invoker set search_path='' as $$
declare v_previous public.cmpri_staff_notes;v_id uuid;
begin
  if p_mentions is null or jsonb_typeof(p_mentions)<>'array' or jsonb_array_length(p_mentions)>100
    or exists(select 1 from jsonb_array_elements(p_mentions) m where jsonb_typeof(m)<>'object'
      or coalesce(m->>'kind','') not in ('person','role','front_desk_name','location','work_order')
      or coalesce(m->>'id','')='' or coalesce(m->>'label','')=''
      or jsonb_typeof(m->'start') is distinct from 'number' or jsonb_typeof(m->'end') is distinct from 'number'
      or (m->>'start')::numeric<0 or (m->>'end')::numeric<=(m->>'start')::numeric) then raise exception 'Invalid mentions'; end if;
  if p_name_id is not null and not exists(select 1 from public.cmpri_staff_note_names n where n.hotel_id=p_hotel and n.id=p_name_id and n.name=p_name) then raise exception 'Invalid Front Desk name'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||p_author::text||p_request::text,0));
  select * into v_previous from public.cmpri_staff_notes where hotel_id=p_hotel and author_user_id=p_author and request_id=p_request;
  if found and (v_previous.mentions is distinct from p_mentions or v_previous.author_name_id is distinct from p_name_id) then raise exception 'Request already used'; end if;
  v_id:=public.cmpri_post_staff_note_with_files(p_hotel,p_author,p_name,p_body,p_parent,p_request,p_recipients,p_uploads,p_hashtags,p_gifs);
  if v_previous.id is null then update public.cmpri_staff_notes set mentions=p_mentions,author_name_id=p_name_id where id=v_id and hotel_id=p_hotel; end if;
  return v_id;
end $$;
revoke all on function public.cmpri_post_staff_note_with_mentions(uuid,uuid,text,text,uuid,uuid,jsonb,uuid[],text[],jsonb,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.cmpri_post_staff_note_with_mentions(uuid,uuid,text,text,uuid,uuid,jsonb,uuid[],text[],jsonb,jsonb,uuid) to service_role;
-- Only the new wrapper can write these added fields; direct authenticated writes remain forbidden.
grant update(mentions,author_name_id) on public.cmpri_staff_notes to service_role;

do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.cmpri_staff_note_names;
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
