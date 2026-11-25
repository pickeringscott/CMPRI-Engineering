begin;
set local lock_timeout = '5s';

create table public.cmpri_notepad_history (
  hotel_id uuid not null,
  note_id uuid not null,
  revision bigint not null,
  actor_id uuid not null,
  actor_name text,
  edited_at timestamptz not null,
  kind text not null check (kind in ('created', 'updated', 'registered')),
  before_audience jsonb,
  after_audience jsonb,
  before_fields jsonb not null,
  after_fields jsonb not null,
  primary key (hotel_id, note_id, revision),
  foreign key (hotel_id, note_id) references public.cmpri_notepad_notes (hotel_id, id) on delete cascade
);
alter table public.cmpri_notepad_history enable row level security;
revoke all on public.cmpri_notepad_history from public, anon, authenticated;
grant select, insert, delete on public.cmpri_notepad_history to service_role;

-- Keep drawing coordinates and storage references out of the history payload.
-- A drawing fingerprint lets the editor report replacements as well as add/erase.
create function cmpri_private.notepad_history_fields(note jsonb)
returns jsonb language sql immutable security invoker set search_path = '' as $$
  select case when note is null then '{}'::jsonb else jsonb_build_object(
    'title', note->'title', 'content', note->'content', 'priority', note->'priority',
    'fontFamily', note->'fontFamily', 'fontSize', note->'fontSize', 'titleFontFamily', note->'titleFontFamily',
    'audience', note->'audience', 'itemThreads', case when jsonb_typeof(note->'itemThreads') = 'object' then note->'itemThreads' else '{}'::jsonb end,
    'attachments', coalesce((select jsonb_agg(item->>'name' order by ord)
      from jsonb_array_elements(snapshot.files) with ordinality as files(item, ord)
      where jsonb_typeof(item->'name') = 'string'), '[]'::jsonb),
    'drawing', jsonb_build_object('strokes', jsonb_array_length(snapshot.ink),
      'fingerprint', encode(sha256(convert_to(snapshot.ink::text, 'UTF8')), 'hex'))
  ) end
  from (select
    case when jsonb_typeof(note->'attachments') = 'array' then note->'attachments' else '[]'::jsonb end as files,
    case when jsonb_typeof(note->'ink') = 'array' then note->'ink' else '[]'::jsonb end as ink
  ) snapshot;
$$;
revoke all on function cmpri_private.notepad_history_fields(jsonb) from public, anon, authenticated;
grant execute on function cmpri_private.notepad_history_fields(jsonb) to service_role;

-- Keep the original save and conflict/permission checks intact. The same
-- transaction lock covers both the previous snapshot and the history insert.
alter function public.cmpri_save_notepad(uuid,uuid,uuid,bigint,uuid,jsonb,text,text) set schema cmpri_private;
create function public.cmpri_save_notepad(
  p_hotel uuid, p_actor uuid, p_id uuid, p_expected bigint, p_change uuid,
  p_document jsonb, p_source text default null, p_legacy_version text default null
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
  saved := cmpri_private.cmpri_save_notepad(p_hotel, p_actor, p_id, p_expected, p_change, p_document, p_source, p_legacy_version);
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
revoke all on function public.cmpri_save_notepad(uuid,uuid,uuid,bigint,uuid,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.cmpri_save_notepad(uuid,uuid,uuid,bigint,uuid,jsonb,text,text) to service_role;

create function public.cmpri_read_notepad_history(p_hotel uuid, p_actor uuid, p_note uuid, p_before bigint)
returns table(revision bigint, actor_id uuid, actor_name text, edited_at timestamptz, kind text, before_fields jsonb, after_fields jsonb)
language sql stable security invoker set search_path = '' as $$
  select h.revision, h.actor_id, h.actor_name, h.edited_at, h.kind, h.before_fields, h.after_fields
  from public.cmpri_notepad_notes n
  join public.cmpri_notepad_history h on h.hotel_id = n.hotel_id and h.note_id = n.id
  where n.hotel_id = p_hotel and n.id = p_note and n.deleted_at is null
    and cmpri_private.notepad_can_read(p_hotel, p_actor, n.author_user_id, n.document)
    and (p_before is null or h.revision < p_before)
    and (h.before_audience is null or cmpri_private.notepad_can_read(
      p_hotel, p_actor, n.author_user_id, jsonb_build_object('audience', h.before_audience)))
    and (h.after_audience is null or cmpri_private.notepad_can_read(
      p_hotel, p_actor, n.author_user_id, jsonb_build_object('audience', h.after_audience)))
  order by h.revision desc
  limit 6;
$$;
revoke all on function public.cmpri_read_notepad_history(uuid,uuid,uuid,bigint) from public, anon, authenticated;
grant execute on function public.cmpri_read_notepad_history(uuid,uuid,uuid,bigint) to service_role;

commit;
