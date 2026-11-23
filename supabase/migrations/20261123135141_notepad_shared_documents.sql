begin;
set local lock_timeout='5s';

-- Notepad overlays preserve the original personal and staff-note tables verbatim.
-- A legacy note gets an overlay only on its first edit; tombstones hide retired items.
create table public.cmpri_notepad_notes (
 hotel_id uuid not null references public.hotels(id), id uuid not null,
 author_user_id uuid not null references public.profiles(id), author_name text,
 document jsonb, revision bigint not null check(revision>0), change_id uuid not null,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 deleted_at timestamptz, legacy_source text check(legacy_source in ('general','staff')),
 primary key(hotel_id,id),
 check((document is null)=(deleted_at is not null)),
 check(document is null or (jsonb_typeof(document)='object' and octet_length(document::text)<=2097152
   and length(document->>'title')<=120 and jsonb_typeof(document->'content')='string'
   and jsonb_typeof(document->'audience')='object'
   and jsonb_typeof(document->'audience'->'all')='boolean'
   and jsonb_typeof(document->'audience'->'roles')='array'
   and jsonb_typeof(document->'audience'->'people')='array'
   and jsonb_typeof(document->'attachments')='array' and jsonb_typeof(document->'ink')='array'))
);
create index cmpri_notepad_owner on public.cmpri_notepad_notes(hotel_id,author_user_id,updated_at desc);
create table public.cmpri_notepad_order (
 hotel_id uuid not null references public.hotels(id), user_id uuid not null references public.profiles(id) on delete cascade,
 note_ids uuid[] not null default '{}', primary key(hotel_id,user_id), check(cardinality(note_ids)<=5000)
);
create table public.cmpri_notepad_uploads (
 id uuid primary key, hotel_id uuid not null references public.hotels(id), author_user_id uuid not null references public.profiles(id),
 note_id uuid, name text not null check(length(name) between 1 and 255), media_type text not null,
 size_bytes bigint not null check(size_bytes between 1 and 104857600), storage_path text not null unique,
 ready boolean not null default false, created_at timestamptz not null default clock_timestamp(),
 foreign key(hotel_id,note_id) references public.cmpri_notepad_notes(hotel_id,id)
);
-- Authenticated direct Data API access is intentionally closed. Each application API
-- reauthorizes current active property membership and the note's audience on every call.
alter table public.cmpri_notepad_notes enable row level security;
alter table public.cmpri_notepad_order enable row level security;
alter table public.cmpri_notepad_uploads enable row level security;
revoke all on public.cmpri_notepad_notes,public.cmpri_notepad_order,public.cmpri_notepad_uploads from public,anon,authenticated;
grant all on public.cmpri_notepad_notes,public.cmpri_notepad_order,public.cmpri_notepad_uploads to service_role;

-- Existing Staff Notes have no edit revision. A separate counter leaves their
-- content intact and lets first-import CAS include edits anywhere in a thread.
alter table public.cmpri_staff_notes add column notepad_revision bigint not null default 0 check(notepad_revision>=0);
create function cmpri_private.notepad_staff_version(p_hotel uuid,p_root uuid) returns text
language sql stable security invoker set search_path='' as $$
 with recursive branch as (
  select n.id,n.parent_id,n.notepad_revision,array[n.id] as visited
   from public.cmpri_staff_notes n where n.hotel_id=p_hotel and n.id=p_root
  union all
  select n.id,n.parent_id,n.notepad_revision,b.visited||n.id
   from branch b join public.cmpri_staff_notes n on n.parent_id=b.id and n.hotel_id=p_hotel
   where not(n.id=any(b.visited))
 ) select 'staff:'||encode(sha256(convert_to(coalesce(string_agg(id::text||':'||notepad_revision::text,E'\n' order by id),''),'UTF8')),'hex') from branch;
$$;
revoke all on function cmpri_private.notepad_staff_version(uuid,uuid) from public,anon,authenticated;
grant execute on function cmpri_private.notepad_staff_version(uuid,uuid) to service_role;

create function cmpri_private.notepad_role_keys(primary_role text,secondary_roles text[]) returns text[]
language sql immutable set search_path='' as $$
 select coalesce(array_agg(distinct case normalized
  when 'engineer' then 'engineer' when 'engineers' then 'engineer' when 'engineering' then 'engineer' when 'chiefengineer' then 'engineer' when 'engineeringmanager' then 'engineer' when 'regionalmaintenance' then 'engineer' when 'regionalengineer' then 'engineer'
  when 'manager' then 'manager' when 'generalmanager' then 'manager' when 'gm' then 'manager'
  when 'seniormanagement' then 'senior_management' when 'uppermanagement' then 'senior_management' when 'vpfacilities' then 'senior_management' when 'regionaldirectoroperations' then 'senior_management' when 'districtmanager' then 'senior_management'
  when 'technician' then 'technician' when 'maintenancetechnician' then 'technician'
  when 'frontdesk' then 'front_desk' when 'salesmanager' then 'front_desk' when 'frontdeskmanager' then 'front_desk_manager'
  when 'assistantgm' then 'assistant_manager' when 'assistantgeneralmanager' then 'assistant_manager' when 'assistantmanager' then 'assistant_manager'
  when 'housekeeping' then 'housekeeping' when 'leadhousekeeper' then 'housekeeping' when 'executivehousekeeper' then 'housekeeping'
  when 'systemadmin' then 'system_admin' when 'sysadmin' then 'system_admin' when 'systemadministrator' then 'system_admin' when 'administrator' then 'system_admin' when 'admin' then 'system_admin'
  else 'unknown' end),'{}'::text[])
 from unnest(array[primary_role]||coalesce(secondary_roles,'{}'::text[])) r,
 lateral regexp_split_to_table(r,'\s*(/|\+|,|&|\mand\M)\s*','i') label,
 lateral (select regexp_replace(lower(label),'[[:space:]_-]','','g') normalized) n;
$$;
revoke all on function cmpri_private.notepad_role_keys(text,text[]) from public,anon,authenticated;
grant execute on function cmpri_private.notepad_role_keys(text,text[]) to service_role;
create function cmpri_private.notepad_can_read(p_hotel uuid,p_actor uuid,p_owner uuid,p_document jsonb) returns boolean
language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.profiles p join public.hotel_members m on m.user_id=p.id
 where p.id=p_actor and p.active and m.hotel_id=p_hotel and m.active and
 (p_actor=p_owner or p_document->'audience'->'all'='true'::jsonb
 or (p_document->'audience'->'people') ? p_actor::text
 or exists(select 1 from unnest(cmpri_private.notepad_role_keys(p.role::text,p.secondary_roles)) r where (p_document->'audience'->'roles') ? r)));
$$;
revoke all on function cmpri_private.notepad_can_read(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function cmpri_private.notepad_can_read(uuid,uuid,uuid,jsonb) to service_role;

create function public.cmpri_save_notepad(p_hotel uuid,p_actor uuid,p_id uuid,p_expected bigint,p_change uuid,p_document jsonb,p_source text default null,p_legacy_version text default null)
returns public.cmpri_notepad_notes language plpgsql security invoker set search_path='' as $$
declare previous public.cmpri_notepad_notes;result public.cmpri_notepad_notes;owner_id uuid;created timestamptz;display_name text;prior_audience jsonb;legacy_revision bigint;
begin
 if not exists(select 1 from public.profiles p join public.hotel_members m on m.user_id=p.id where p.id=p_actor and p.active and m.hotel_id=p_hotel and m.active) then raise exception 'Inactive member' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||p_id::text,0));
 select * into previous from public.cmpri_notepad_notes where hotel_id=p_hotel and id=p_id for update;
 if found then
  if not cmpri_private.notepad_can_read(p_hotel,p_actor,previous.author_user_id,previous.document) and not(previous.deleted_at is not null and previous.author_user_id=p_actor and previous.change_id=p_change) then raise exception 'Note unavailable' using errcode='42501';end if;
  if previous.change_id=p_change then
   if previous.document is distinct from p_document then raise exception 'Mutation identity reused' using errcode='22023';end if;
   return previous;
  end if;
  if p_expected is distinct from previous.revision or previous.deleted_at is not null then raise exception 'Note changed elsewhere' using errcode='40001';end if;
  if p_actor<>previous.author_user_id and (p_document is null or p_document->'audience' is distinct from previous.document->'audience') then raise exception 'Only the creator can change sharing or delete' using errcode='42501';end if;
  if previous.document is not distinct from p_document then return previous;end if;
  update public.cmpri_notepad_notes set document=p_document,revision=previous.revision+1,change_id=p_change,updated_at=clock_timestamp(),deleted_at=case when p_document is null then clock_timestamp() else null end where hotel_id=p_hotel and id=p_id returning * into result;
 else
  owner_id=p_actor;created=clock_timestamp();
  if p_expected=0 and p_source='general' then
   select user_id,updated_at,revision into owner_id,created,legacy_revision from public.cmpri_general_notes where hotel_id=p_hotel and id=p_id and user_id=p_actor and deleted_at is null;
   if not found then raise exception 'Note unavailable' using errcode='42501';end if;
   if p_legacy_version is distinct from 'general:'||legacy_revision::text then raise exception 'Legacy note changed elsewhere' using errcode='40001';end if;
   prior_audience='{"all":false,"roles":[],"people":[]}'::jsonb;
  elsif p_expected=0 and p_source='staff' then
   select author_user_id,created_at,author_name into owner_id,created,display_name from public.cmpri_staff_notes where hotel_id=p_hotel and id=p_id and parent_id is null;
   if not found then raise exception 'Note unavailable' using errcode='42501';end if;
   if p_legacy_version is distinct from cmpri_private.notepad_staff_version(p_hotel,p_id) then raise exception 'Legacy thread changed elsewhere' using errcode='40001';end if;
   prior_audience='{"all":true,"roles":[],"people":[]}'::jsonb;
  elsif p_expected is not null or p_document is null or p_source is not null then raise exception 'Note changed elsewhere' using errcode='40001';
  else
   if exists(select 1 from public.cmpri_staff_notes where hotel_id=p_hotel and id=p_id) or exists(select 1 from public.cmpri_general_notes where hotel_id=p_hotel and id=p_id) then raise exception 'Note identity already exists' using errcode='40001';end if;
   if (select count(*) from public.cmpri_notepad_notes where hotel_id=p_hotel and author_user_id=p_actor and deleted_at is null)>=500 then raise exception 'Notebook is full' using errcode='54000';end if;
  end if;
  if p_actor<>owner_id and (p_document is null or p_document->'audience' is distinct from prior_audience) then raise exception 'Only the creator can change sharing or delete' using errcode='42501';end if;
  insert into public.cmpri_notepad_notes(hotel_id,id,author_user_id,author_name,document,revision,change_id,created_at,deleted_at,legacy_source)
   values(p_hotel,p_id,owner_id,display_name,p_document,1,p_change,created,case when p_document is null then clock_timestamp() else null end,p_source) returning * into result;
 end if;
 if p_document is not null then
  update public.cmpri_notepad_uploads set note_id=p_id where hotel_id=p_hotel and author_user_id=p_actor and ready and note_id is null and id::text in(select a->>'id' from jsonb_array_elements(p_document->'attachments') a where a->>'kind'='file');
 end if;
 return result;
end $$;
revoke all on function public.cmpri_save_notepad(uuid,uuid,uuid,bigint,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.cmpri_save_notepad(uuid,uuid,uuid,bigint,uuid,jsonb,text,text) to service_role;

-- Cached clients may still call the retired editors' APIs. Serialize those
-- writes with first import, then reject writes hidden by an overlay/tombstone.
-- If a legacy write wins the lock first, first-import CAS above rejects its
-- stale snapshot instead. Neither order silently discards the other draft.
create function cmpri_private.guard_notepad_legacy_write() returns trigger
language plpgsql security invoker set search_path='' as $$
declare property_id uuid;row_id uuid;root_id uuid;parent_id uuid;visited uuid[]='{}';
begin
 if TG_OP='DELETE' then property_id=OLD.hotel_id;row_id=OLD.id;else property_id=NEW.hotel_id;row_id=NEW.id;end if;
 root_id=row_id;
 if TG_TABLE_NAME='cmpri_staff_notes' then
  if TG_OP='UPDATE' and (NEW.id is distinct from OLD.id or NEW.hotel_id is distinct from OLD.hotel_id or NEW.parent_id is distinct from OLD.parent_id) then raise exception 'Legacy note identity cannot move' using errcode='22023';end if;
  if TG_OP='DELETE' then parent_id=OLD.parent_id;else parent_id=NEW.parent_id;end if;
  visited=array[row_id];
  while parent_id is not null loop
   if parent_id=any(visited) then raise exception 'Invalid legacy thread' using errcode='22023';end if;
   root_id=parent_id;visited=visited||root_id;
   select n.parent_id into parent_id from public.cmpri_staff_notes n where n.hotel_id=property_id and n.id=root_id;
  end loop;
 elsif TG_OP='UPDATE' and (NEW.id is distinct from OLD.id or NEW.hotel_id is distinct from OLD.hotel_id or NEW.user_id is distinct from OLD.user_id) then raise exception 'Legacy note identity cannot move' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(property_id::text||root_id::text,0));
 if exists(select 1 from public.cmpri_notepad_notes where hotel_id=property_id and (id=root_id or id=row_id)) then raise exception 'This note has moved to Notepad; retain the draft and reopen Notepad' using errcode='40001';end if;
 if TG_TABLE_NAME='cmpri_staff_notes' and TG_OP<>'DELETE' then
  if TG_OP='INSERT' then NEW.notepad_revision=0;else NEW.notepad_revision=OLD.notepad_revision+1;end if;
 end if;
 if TG_OP='DELETE' then return OLD;else return NEW;end if;
end $$;
revoke all on function cmpri_private.guard_notepad_legacy_write() from public,anon,authenticated;
grant execute on function cmpri_private.guard_notepad_legacy_write() to service_role;
create trigger notepad_legacy_general_guard before insert or update or delete on public.cmpri_general_notes for each row execute function cmpri_private.guard_notepad_legacy_write();
create trigger notepad_legacy_staff_guard before insert or update or delete on public.cmpri_staff_notes for each row execute function cmpri_private.guard_notepad_legacy_write();

-- Only opaque invalidation signals are published. Private note contents never enter
-- a broadly visible realtime table; clients reauthorize their GET after the event.
alter table public.cmpri_resource_signals drop constraint cmpri_resource_signals_topic_check;
alter table public.cmpri_resource_signals add constraint cmpri_resource_signals_topic_check
 check(topic in ('orders','inbox','pool','rooms','feedback','session','reference','notepad'));
create trigger resource_notepad after insert or update on public.cmpri_notepad_notes for each row execute function cmpri_private.signal_resource('notepad');
create trigger resource_notepad_legacy_general after insert or update or delete on public.cmpri_general_notes for each row execute function cmpri_private.signal_resource('notepad');
create trigger resource_notepad_legacy_staff after insert or update or delete on public.cmpri_staff_notes for each row execute function cmpri_private.signal_resource('notepad');
notify pgrst,'reload schema';
commit;
