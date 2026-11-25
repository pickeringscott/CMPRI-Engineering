begin;
set local lock_timeout = '5s';

create or replace function public.cmpri_read_notepad_history(
  p_hotel uuid, p_actor uuid, p_note uuid, p_before bigint
)
returns table(
  revision bigint, actor_id uuid, actor_name text, edited_at timestamptz,
  kind text, before_fields jsonb, after_fields jsonb
)
language sql stable security invoker set search_path = '' as $$
  select h.revision, h.actor_id, h.actor_name, h.edited_at, h.kind,
    case when h.before_audience is null or cmpri_private.notepad_can_read(
      p_hotel, p_actor, n.author_user_id, jsonb_build_object('audience', h.before_audience)
    ) then h.before_fields else '{}'::jsonb end,
    h.after_fields
  from public.cmpri_notepad_notes n
  join public.cmpri_notepad_history h on h.hotel_id = n.hotel_id and h.note_id = n.id
  where n.hotel_id = p_hotel and n.id = p_note and n.deleted_at is null
    and cmpri_private.notepad_can_read(p_hotel, p_actor, n.author_user_id, n.document)
    and (p_before is null or h.revision < p_before)
    -- The share revision is visible, including when it is the only available edit.
    -- Its before-side remains private to the audience that could read it then.
    and (h.after_audience is null or cmpri_private.notepad_can_read(
      p_hotel, p_actor, n.author_user_id, jsonb_build_object('audience', h.after_audience)
    ))
  order by h.revision desc
  limit 6;
$$;

commit;
