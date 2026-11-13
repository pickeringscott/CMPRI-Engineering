begin;

-- Keep one note per closing visit. Its author identifies the acting technician;
-- a verification must also identify the original worker whose check was reviewed.
create or replace function public.cmpri_finalize_work_order_troubleshooting(
  p_hotel uuid, p_work_order uuid, p_visit_id uuid, p_actor uuid
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  ticket public.work_orders%rowtype;
  visit public.cmpri_work_order_troubleshooting_visits%rowtype;
  actor_name text;
  actor_role text;
  summary text;
  note_line text;
  finalized_time timestamptz;
begin
  if p_hotel is null or p_work_order is null or p_visit_id is null or p_actor is null then
    raise exception 'Complete troubleshooting visit details are required.' using errcode = '22023';
  end if;
  select coalesce(nullif(btrim(p.full_name), ''), 'CMPRI User'), coalesce(p.role::text, '')
    into actor_name, actor_role
    from public.profiles p join public.hotel_members m on m.user_id = p.id
    where p.id = p_actor and p.active = true and m.hotel_id = p_hotel and m.active = true;
  if not found then
    raise exception 'An active property account is required.' using errcode = '42501';
  end if;
  -- Keep the lock order installed by room_ranker_automatic_escalation:
  -- the shared ranker lock must precede the ticket row lock and note UPDATE.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cmpri-room-ranker-global',0));
  -- The exclusive ticket lock serializes exit against every checklist save.
  select * into ticket from public.work_orders where id = p_work_order and hotel_id = p_hotel for update;
  if not found then raise exception 'Work order not found.' using errcode = '42501'; end if;
  -- Even an empty exit creates a tombstone, preventing a delayed first PATCH.
  insert into public.cmpri_work_order_troubleshooting_visits (id, hotel_id, work_order_id, actor_id)
    values (p_visit_id, p_hotel, p_work_order, p_actor) on conflict (id) do nothing;
  select * into visit from public.cmpri_work_order_troubleshooting_visits where id = p_visit_id for update;
  if visit.hotel_id is distinct from p_hotel or visit.work_order_id is distinct from p_work_order or visit.actor_id is distinct from p_actor then
    raise exception 'This troubleshooting visit belongs to another account or work order.' using errcode = '42501';
  end if;
  if visit.finalized_at is not null then
    return jsonb_build_object('finalized', true, 'already_finalized', true,
      'event_count', visit.event_count, 'work_order_revision', visit.work_order_revision, 'note', visit.note_text);
  end if;
  finalized_time := clock_timestamp();

  -- The journal retains full actor/time/source snapshots. The single note uses
  -- its normal attribution header and names each step once with its full action
  -- history. Independent contexts/items/documents retain separate chains.
  with event_sources as (
    select e.*,
      coalesce(nullif(e.source->>'storage_path', ''), nullif(e.source->>'registered_file_id', ''),
        nullif(e.source->>'sha256', ''), nullif(e.source->>'source_file_name', ''), 'attached-manual') as document_key,
      regexp_replace(coalesce(nullif(e.source->>'source_file_name', ''), nullif(e.source->>'storage_path', ''),
        nullif(e.source->>'title', ''), 'Attached manual.pdf'), '^.*/', '') as file_name,
      rtrim(e.step_label, E' .;\r\n\t') as compact_label,
      case when e.after_state->>'status' = 'empty' and coalesce(e.after_state->>'workerChecked', 'false') <> 'true' then 'cleared'
        when e.after_state->>'status' = 'approved'
          and coalesce(e.before_state->>'workerChecked', 'false') <> 'true'
          and e.after_state->>'workerChecked' = 'true' then 'completed and verified'
        when e.after_state->>'status' = 'approved' then 'verified' || case
          when coalesce(e.after_state->>'workerId', e.before_state->>'workerId', '') <> e.actor_id::text
            and coalesce(nullif(e.after_state->>'workerName', ''), nullif(e.before_state->>'workerName', '')) is not null
          then ' (completed by ' || coalesce(nullif(e.after_state->>'workerName', ''), nullif(e.before_state->>'workerName', '')) || ')'
          else '' end
        else 'checked' end as action_label
    from public.cmpri_work_order_troubleshooting_events e where e.visit_id = p_visit_id
  ), first_documents as (
    select distinct on (document_key) document_key, file_name, event_number
      from event_sources order by document_key, event_number
  ), documents as (
    select document_key, file_name, event_number from first_documents
  ), step_chains as (
    select compact_label, context_key, item_id, document_key, min(event_number) as first_event,
      string_agg(action_label, ' → ' order by event_number) as action_history
    from event_sources group by compact_label, context_key, item_id, document_key
  ), labels as (
    select compact_label, min(first_event) as first_event,
      string_agg(action_history, ' / ' order by first_event) as action_history
    from step_chains group by compact_label
  )
  select case when count(*) = 0 then null else 'Troubleshooting: ' || string_agg(
    e.compact_label || ' — ' || e.action_history, '; ' order by e.first_event
  ) || '. ' || (select case when count(*) = 1 then 'Source: ' || max(file_name) || '.'
    else 'Sources: ' || string_agg(file_name, '; ' order by event_number) || '.' end from documents)
    end into summary from labels e;
  if summary is not null then
    note_line := 'CMPRI2|' || to_char(finalized_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|'
      || regexp_replace(actor_name, '[|\r\n]+', '/', 'g') || '|'
      || regexp_replace(actor_role, '[|\r\n]+', '/', 'g') || '|note|'
      || replace(regexp_replace(summary, '[\r\n]+', ' ', 'g'), '|', '/');
    update public.work_orders set
      notes = coalesce(notes, '') || case when coalesce(notes, '') = '' then '' else E'\n' end || note_line,
      history_actor_user_id = p_actor, history_source = 'CMPRI troubleshooting checklist'
      where id = p_work_order and hotel_id = p_hotel returning * into ticket;
  end if;
  update public.cmpri_work_order_troubleshooting_visits set finalized_at = finalized_time,
    note_text = note_line, work_order_revision = ticket.revision where id = p_visit_id;
  return jsonb_build_object('finalized', true, 'already_finalized', false,
    'event_count', visit.event_count, 'work_order_revision', ticket.revision, 'note', note_line);
end;
$$;

commit;
