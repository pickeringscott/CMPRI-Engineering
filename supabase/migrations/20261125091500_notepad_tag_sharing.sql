begin;
set local lock_timeout = '5s';

-- This is receipt metadata for the most recent save. A retry must reproduce
-- the exact confirmed additions as well as the saved document.
alter table public.cmpri_notepad_notes
  add column last_tagged_people uuid[] not null default '{}'::uuid[];

-- Only the authenticated application service may provide verified tag targets.
-- The write transaction independently checks active membership and limits a
-- collaborator's audience changes to the exact addition of those targets.
create function cmpri_private.notepad_check_tagged_people(p_hotel uuid, p_document jsonb, p_tagged_people uuid[])
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if exists (
    select 1 from unnest(coalesce(p_tagged_people, '{}'::uuid[])) tag(id)
    where not coalesce((p_document->'audience'->'people') ? tag.id::text, false)
      or not exists (
        select 1 from public.profiles p join public.hotel_members m on m.user_id = p.id
        where p.id = tag.id and p.active and m.hotel_id = p_hotel and m.active
      )
  ) then raise exception 'Tagged recipient is unavailable' using errcode = '42501'; end if;
end;
$$;
revoke all on function cmpri_private.notepad_check_tagged_people(uuid,jsonb,uuid[]) from public, anon, authenticated;
grant execute on function cmpri_private.notepad_check_tagged_people(uuid,jsonb,uuid[]) to service_role;

create function cmpri_private.notepad_tagged_audience(prior jsonb, targets uuid[])
returns jsonb language sql immutable security invoker set search_path = '' as $$
  select case when coalesce(cardinality(targets),0)=0 then prior else
    jsonb_set(prior, '{people}', (select coalesce(jsonb_agg(id order by id),'[]'::jsonb) from (
      select jsonb_array_elements_text(prior->'people') as id union select unnest(targets)::text
    ) people))
  end;
$$;
revoke all on function cmpri_private.notepad_tagged_audience(jsonb,uuid[]) from public, anon, authenticated;
grant execute on function cmpri_private.notepad_tagged_audience(jsonb,uuid[]) to service_role;

create function cmpri_private.cmpri_save_notepad(p_hotel uuid,p_actor uuid,p_id uuid,p_expected bigint,p_change uuid,p_document jsonb,p_source text,p_legacy_version text,p_tagged_people uuid[])
returns public.cmpri_notepad_notes language plpgsql security invoker set search_path='' as $$
declare previous public.cmpri_notepad_notes;result public.cmpri_notepad_notes;owner_id uuid;created timestamptz;display_name text;prior_audience jsonb;legacy_revision bigint;
begin
 p_tagged_people := array(select distinct tag.id from unnest(coalesce(p_tagged_people,'{}'::uuid[])) tag(id) order by tag.id);
 if not exists(select 1 from public.profiles p join public.hotel_members m on m.user_id=p.id where p.id=p_actor and p.active and m.hotel_id=p_hotel and m.active) then raise exception 'Inactive member' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_hotel::text||p_id::text,0));
 select * into previous from public.cmpri_notepad_notes where hotel_id=p_hotel and id=p_id for update;
 if found then
  if not cmpri_private.notepad_can_read(p_hotel,p_actor,previous.author_user_id,previous.document) and not(previous.deleted_at is not null and previous.author_user_id=p_actor and previous.change_id=p_change) then raise exception 'Note unavailable' using errcode='42501';end if;
  if previous.change_id=p_change then
   if previous.document is distinct from p_document or previous.last_tagged_people is distinct from p_tagged_people then raise exception 'Mutation identity reused' using errcode='22023';end if;
   return previous;
  end if;
  if p_expected is distinct from previous.revision or previous.deleted_at is not null then raise exception 'Note changed elsewhere' using errcode='40001';end if;
  perform cmpri_private.notepad_check_tagged_people(p_hotel, p_document, p_tagged_people);
  if p_actor<>previous.author_user_id and (p_document is null or p_document->'audience' is distinct from
    cmpri_private.notepad_tagged_audience(previous.document->'audience',p_tagged_people)) then raise exception 'Only the creator can change sharing or delete' using errcode='42501';end if;
  if previous.document is not distinct from p_document then return previous;end if;
  update public.cmpri_notepad_notes set document=p_document,revision=previous.revision+1,change_id=p_change,last_tagged_people=p_tagged_people,updated_at=clock_timestamp(),deleted_at=case when p_document is null then clock_timestamp() else null end where hotel_id=p_hotel and id=p_id returning * into result;
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
  perform cmpri_private.notepad_check_tagged_people(p_hotel, p_document, p_tagged_people);
  if p_actor<>owner_id and (p_document is null or p_document->'audience' is distinct from
    cmpri_private.notepad_tagged_audience(prior_audience,p_tagged_people)) then raise exception 'Only the creator can change sharing or delete' using errcode='42501';end if;
  insert into public.cmpri_notepad_notes(hotel_id,id,author_user_id,author_name,document,revision,change_id,last_tagged_people,created_at,deleted_at,legacy_source)
   values(p_hotel,p_id,owner_id,display_name,p_document,1,p_change,p_tagged_people,created,case when p_document is null then clock_timestamp() else null end,p_source) returning * into result;
 end if;
 if p_document is not null then
  update public.cmpri_notepad_uploads set note_id=p_id where hotel_id=p_hotel and author_user_id=p_actor and ready and note_id is null and id::text in(select a->>'id' from jsonb_array_elements(p_document->'attachments') a where a->>'kind'='file');
 end if;
 return result;
end $$;
revoke all on function cmpri_private.cmpri_save_notepad(uuid,uuid,uuid,bigint,uuid,jsonb,text,text,uuid[]) from public,anon,authenticated;
grant execute on function cmpri_private.cmpri_save_notepad(uuid,uuid,uuid,bigint,uuid,jsonb,text,text,uuid[]) to service_role;

-- Keep the history snapshot, audience and edited document in the same
-- revision and transaction. Existing callers may omit the optional tag list.
drop function public.cmpri_save_notepad(uuid,uuid,uuid,bigint,uuid,jsonb,text,text);

create function public.cmpri_save_notepad(
  p_hotel uuid, p_actor uuid, p_id uuid, p_expected bigint, p_change uuid,
  p_document jsonb, p_source text default null, p_legacy_version text default null, p_tagged_people uuid[] default '{}'::uuid[]
)
returns public.cmpri_notepad_notes language plpgsql security invoker set search_path = '' as $$
declare
  previous public.cmpri_notepad_notes;
  saved public.cmpri_notepad_notes;
  before_snapshot jsonb;
  after_snapshot jsonb;
  changed_keys text[];
  editor_name text;
  prior_audience jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_hotel::text || p_id::text, 0));
  select * into previous from public.cmpri_notepad_notes where hotel_id = p_hotel and id = p_id;
  saved := cmpri_private.cmpri_save_notepad(p_hotel, p_actor, p_id, p_expected, p_change, p_document, p_source, p_legacy_version, p_tagged_people);
  if previous.revision is not null and previous.revision = saved.revision then return saved; end if;
  if saved.document is null then
    delete from public.cmpri_notepad_history where hotel_id = p_hotel and note_id = p_id;
    return saved;
  end if;

  before_snapshot := cmpri_private.notepad_history_fields(previous.document);
  after_snapshot := cmpri_private.notepad_history_fields(saved.document);
  select array_agg(key) into changed_keys
    from (select jsonb_object_keys(before_snapshot) as key union select jsonb_object_keys(after_snapshot)) keys
    where before_snapshot->key is distinct from after_snapshot->key;
  if changed_keys is null then return saved; end if;

  select nullif(trim(full_name), '') into editor_name from public.profiles where id = p_actor;
  prior_audience := case p_source
    when 'general' then '{"all":false,"roles":[],"people":[]}'::jsonb
    when 'staff' then '{"all":true,"roles":[],"people":[]}'::jsonb
    else previous.document->'audience' end;
  insert into public.cmpri_notepad_history (
    hotel_id, note_id, revision, actor_id, actor_name, edited_at, kind,
    before_audience, after_audience, before_fields, after_fields
  ) values (
    p_hotel, p_id, saved.revision, p_actor, editor_name, saved.updated_at,
    case when previous.revision is not null then 'updated'
      when p_source is not null then 'registered' else 'created' end,
    prior_audience, saved.document->'audience',
    coalesce((select jsonb_object_agg(key, value) from jsonb_each(before_snapshot) where key = any(changed_keys)), '{}'::jsonb),
    coalesce((select jsonb_object_agg(key, value) from jsonb_each(after_snapshot) where key = any(changed_keys)), '{}'::jsonb)
  );
  return saved;
end;
$$;
revoke all on function public.cmpri_save_notepad(uuid,uuid,uuid,bigint,uuid,jsonb,text,text,uuid[]) from public, anon, authenticated;
grant execute on function public.cmpri_save_notepad(uuid,uuid,uuid,bigint,uuid,jsonb,text,text,uuid[]) to service_role;

notify pgrst, 'reload schema';
commit;
