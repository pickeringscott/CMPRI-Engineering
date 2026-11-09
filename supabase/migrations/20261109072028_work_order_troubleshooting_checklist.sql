begin;

-- Keep troubleshooting checks separate from ticket revisions and PM completion.
create unique index if not exists work_orders_id_hotel_troubleshooting_key
  on public.work_orders (id, hotel_id);

create table public.cmpri_work_order_troubleshooting_checks (
  hotel_id uuid not null,
  work_order_id uuid not null,
  context_key text not null check (context_key ~ '^[a-f0-9]{64}$'),
  task_states jsonb not null default '{}'::jsonb
    check (jsonb_typeof(task_states) = 'object' and octet_length(task_states::text) <= 65536),
  revision bigint not null default 1 check (revision >= 1),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (hotel_id, work_order_id, context_key),
  foreign key (work_order_id, hotel_id) references public.work_orders(id, hotel_id) on delete cascade
);

alter table public.cmpri_work_order_troubleshooting_checks enable row level security;
revoke all on public.cmpri_work_order_troubleshooting_checks from public, anon, authenticated;
grant select on public.cmpri_work_order_troubleshooting_checks to authenticated;
grant all on public.cmpri_work_order_troubleshooting_checks to service_role;
create policy troubleshooting_checks_member_select
  on public.cmpri_work_order_troubleshooting_checks for select to authenticated
  using (
    public.is_hotel_member(hotel_id)
    and exists (
      select 1 from public.work_orders w
      where w.id = work_order_id and w.hotel_id = cmpri_work_order_troubleshooting_checks.hotel_id
    )
  );

create table public.cmpri_work_order_troubleshooting_visits (
  id uuid primary key,
  hotel_id uuid not null,
  work_order_id uuid not null,
  actor_id uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  finalized_at timestamptz,
  last_event_at timestamptz,
  event_count integer not null default 0 check (event_count >= 0),
  note_text text,
  work_order_revision bigint,
  unique (id, hotel_id, work_order_id, actor_id),
  foreign key (work_order_id, hotel_id) references public.work_orders(id, hotel_id) on delete cascade
);
create index troubleshooting_visits_pending_actor
  on public.cmpri_work_order_troubleshooting_visits (hotel_id, work_order_id, actor_id)
  where finalized_at is null;
create sequence public.cmpri_troubleshooting_event_number;
create table public.cmpri_work_order_troubleshooting_events (
  mutation_id uuid primary key,
  event_number bigint not null default nextval('public.cmpri_troubleshooting_event_number') unique,
  visit_id uuid not null,
  hotel_id uuid not null,
  work_order_id uuid not null,
  actor_id uuid not null,
  actor_name text not null,
  actor_role text not null,
  context_key text not null,
  item_id text not null,
  action text not null check (action in ('toggle', 'clear')),
  step_label text not null,
  source jsonb not null,
  before_state jsonb,
  after_state jsonb not null,
  ledger_revision bigint not null,
  request jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (visit_id, hotel_id, work_order_id, actor_id)
    references public.cmpri_work_order_troubleshooting_visits(id, hotel_id, work_order_id, actor_id)
);
create index troubleshooting_events_visit on public.cmpri_work_order_troubleshooting_events (visit_id, event_number);
alter table public.cmpri_work_order_troubleshooting_visits enable row level security;
alter table public.cmpri_work_order_troubleshooting_events enable row level security;
revoke all on public.cmpri_work_order_troubleshooting_visits, public.cmpri_work_order_troubleshooting_events from public, anon, authenticated;
revoke all on sequence public.cmpri_troubleshooting_event_number from public, anon, authenticated;
grant select on public.cmpri_work_order_troubleshooting_visits, public.cmpri_work_order_troubleshooting_events to authenticated;
grant all on public.cmpri_work_order_troubleshooting_visits, public.cmpri_work_order_troubleshooting_events to service_role;
grant usage, select on sequence public.cmpri_troubleshooting_event_number to service_role;
create policy troubleshooting_visits_actor_select on public.cmpri_work_order_troubleshooting_visits
  for select to authenticated using (actor_id = (select auth.uid()) and public.is_hotel_member(hotel_id)
    and exists (select 1 from public.work_orders w where w.id = work_order_id and w.hotel_id = cmpri_work_order_troubleshooting_visits.hotel_id));
create policy troubleshooting_events_actor_select on public.cmpri_work_order_troubleshooting_events
  for select to authenticated using (actor_id = (select auth.uid()) and public.is_hotel_member(hotel_id)
    and exists (select 1 from public.work_orders w where w.id = work_order_id and w.hotel_id = cmpri_work_order_troubleshooting_events.hotel_id));

create function public.cmpri_save_work_order_troubleshooting(
  p_hotel uuid,
  p_work_order uuid,
  p_context_key text,
  p_expected_revision bigint,
  p_work_order_revision bigint,
  p_asset_context jsonb,
  p_task_states jsonb,
  p_actor uuid,
  p_visit_id uuid,
  p_mutation_id uuid,
  p_item_id text,
  p_action text,
  p_step_label text,
  p_source jsonb,
  p_before_state jsonb,
  p_after_state jsonb
)
returns setof public.cmpri_work_order_troubleshooting_checks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  ticket public.work_orders%rowtype;
  equipment public.assets%rowtype;
  asset_snapshot jsonb;
  saved public.cmpri_work_order_troubleshooting_checks%rowtype;
  visit public.cmpri_work_order_troubleshooting_visits%rowtype;
  prior public.cmpri_work_order_troubleshooting_events%rowtype;
  request_body jsonb;
  previous_states jsonb;
  actor_name text;
  actor_role text;
begin
  if p_hotel is null or p_work_order is null or p_actor is null
    or p_context_key is null or p_context_key !~ '^[a-f0-9]{64}$'
    or p_expected_revision is null or p_expected_revision < 0
    or p_work_order_revision is null or p_work_order_revision < 1
    or p_task_states is null or jsonb_typeof(p_task_states) <> 'object'
    or octet_length(p_task_states::text) > 65536 then
    raise exception 'Invalid troubleshooting checklist input.' using errcode = '22023';
  end if;
  if p_visit_id is null or p_mutation_id is null or p_item_id is null or p_item_id !~ '^step-[1-9][0-9]*$'
    or p_action is null or p_action not in ('toggle', 'clear')
    or p_step_label is null or length(btrim(p_step_label)) not between 1 and 3000
    or p_source is null or jsonb_typeof(p_source) <> 'object' or octet_length(p_source::text) > 32768
    or p_after_state is null or jsonb_typeof(p_after_state) <> 'object'
    or p_after_state is distinct from p_task_states->p_item_id then
    raise exception 'Complete troubleshooting visit details are required.' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_each(p_task_states)) > 250
    or exists (select 1 from jsonb_each(p_task_states) s
      where octet_length(s.key) > 512 or s.key = ''
        or jsonb_typeof(s.value) <> 'object'
        or coalesce(s.value->>'status', '') not in ('needs', 'empty', 'approved')
        or (s.value ? 'workerChecked' and jsonb_typeof(s.value->'workerChecked') <> 'boolean')
        or (s.value ? 'workerId' and (
          jsonb_typeof(s.value->'workerId') <> 'string'
          or (s.value->>'workerId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
        or (s.value ? 'workerName' and jsonb_typeof(s.value->'workerName') <> 'string')
        or (s.value ? 'reviewedBy' and jsonb_typeof(s.value->'reviewedBy') <> 'string')) then
    raise exception 'Invalid troubleshooting task states.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles p
    join public.hotel_members m on m.user_id = p.id
    where p.id = p_actor and p.active = true and m.hotel_id = p_hotel and m.active = true
  ) then
    raise exception 'An active property account is required.' using errcode = '42501';
  end if;
  select coalesce(nullif(btrim(p.full_name), ''), 'CMPRI User'), coalesce(p.role::text, '')
    into actor_name, actor_role from public.profiles p where p.id = p_actor;
  request_body := jsonb_build_object(
    'hotel', p_hotel, 'work_order', p_work_order, 'context_key', p_context_key,
    'expected_revision', p_expected_revision, 'work_order_revision', p_work_order_revision,
    'asset_context', p_asset_context, 'task_states', p_task_states, 'actor', p_actor,
    'visit_id', p_visit_id, 'mutation_id', p_mutation_id, 'item_id', p_item_id,
    'action', p_action, 'step_label', p_step_label, 'source', p_source,
    'before_state', p_before_state, 'after_state', p_after_state
  );
  select * into prior from public.cmpri_work_order_troubleshooting_events where mutation_id = p_mutation_id;
  if found then
    if prior.request is distinct from request_body then
      raise exception 'The checklist mutation ID was already used for a different change.' using errcode = '40001';
    end if;
    return query select * from public.cmpri_work_order_troubleshooting_checks
      where hotel_id = p_hotel and work_order_id = p_work_order and context_key = p_context_key;
    return;
  end if;

  -- These shared locks keep association/document changes from racing the save.
  select * into ticket from public.work_orders
    where id = p_work_order and hotel_id = p_hotel for share;
  if not found or ticket.revision is distinct from p_work_order_revision then
    raise exception 'The work order changed. Reload before saving troubleshooting checks.' using errcode = '40001';
  end if;
  if ticket.asset_id is null then
    if p_asset_context is not null and p_asset_context <> 'null'::jsonb then
      raise exception 'The work-order equipment changed.' using errcode = '40001';
    end if;
  else
    select * into equipment from public.assets
      where id = ticket.asset_id and hotel_id = p_hotel for share;
    if not found then
      raise exception 'The work-order equipment changed.' using errcode = '40001';
    end if;
    asset_snapshot := jsonb_build_object(
      'id', equipment.id,
      'manufacturer', to_jsonb(equipment)->'manufacturer',
      'model_family', to_jsonb(equipment)->'model_family',
      'model_number', to_jsonb(equipment)->'model_number',
      'documentation_key', to_jsonb(equipment)->'documentation_key',
      'documentation_revision_id', to_jsonb(equipment)->'documentation_revision_id',
      'documentation_verified_at', to_jsonb(equipment)->'documentation_verified_at',
      'pdf_import_links', to_jsonb(equipment)->'pdf_import_links'
    );
    if p_asset_context is null or jsonb_typeof(p_asset_context) <> 'object'
      or (p_asset_context - 'documentation_verified_at') is distinct from (asset_snapshot - 'documentation_verified_at') then
      raise exception 'Equipment guidance changed. Reload before saving troubleshooting checks.' using errcode = '40001';
    end if;
    begin
      if (p_asset_context->>'documentation_verified_at')::timestamptz
        is distinct from (asset_snapshot->>'documentation_verified_at')::timestamptz then
        raise exception 'Equipment documentation changed.' using errcode = '40001';
      end if;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'Equipment documentation changed.' using errcode = '40001';
    end;
  end if;

  insert into public.cmpri_work_order_troubleshooting_visits(id, hotel_id, work_order_id, actor_id)
    values (p_visit_id, p_hotel, p_work_order, p_actor) on conflict (id) do nothing;
  select * into visit from public.cmpri_work_order_troubleshooting_visits where id = p_visit_id for update;
  if visit.hotel_id is distinct from p_hotel or visit.work_order_id is distinct from p_work_order
    or visit.actor_id is distinct from p_actor or visit.finalized_at is not null then
    raise exception 'This troubleshooting visit is no longer available for changes.' using errcode = '40001';
  end if;
  -- Recheck after acquiring the visit lock: a simultaneous retry may just have committed.
  select * into prior from public.cmpri_work_order_troubleshooting_events where mutation_id = p_mutation_id;
  if found then
    if prior.request is distinct from request_body then
      raise exception 'The checklist mutation ID was already used for a different change.' using errcode = '40001';
    end if;
    return query select * from public.cmpri_work_order_troubleshooting_checks
      where hotel_id = p_hotel and work_order_id = p_work_order and context_key = p_context_key;
    return;
  end if;
  select task_states into previous_states from public.cmpri_work_order_troubleshooting_checks
    where hotel_id = p_hotel and work_order_id = p_work_order and context_key = p_context_key for update;
  previous_states := coalesce(previous_states, '{}'::jsonb);
  if coalesce(previous_states->p_item_id, 'null'::jsonb) is distinct from coalesce(p_before_state, 'null'::jsonb)
    or (previous_states - p_item_id) is distinct from (p_task_states - p_item_id) then
    raise exception 'Troubleshooting checks changed. Reload before saving.' using errcode = '40001';
  end if;
  if p_expected_revision = 0 then
    insert into public.cmpri_work_order_troubleshooting_checks
      (hotel_id, work_order_id, context_key, task_states, updated_by)
      values (p_hotel, p_work_order, p_context_key, p_task_states, p_actor)
      returning * into saved;
  else
    update public.cmpri_work_order_troubleshooting_checks
      set task_states = p_task_states, revision = revision + 1,
          updated_by = p_actor, updated_at = clock_timestamp()
      where hotel_id = p_hotel and work_order_id = p_work_order
        and context_key = p_context_key and revision = p_expected_revision
      returning * into saved;
    if not found then
      raise exception 'Troubleshooting checks changed. Reload before saving.' using errcode = '40001';
    end if;
  end if;
  insert into public.cmpri_work_order_troubleshooting_events
    (mutation_id, visit_id, hotel_id, work_order_id, actor_id, actor_name, actor_role,
     context_key, item_id, action, step_label, source, before_state, after_state, ledger_revision, request)
    values (p_mutation_id, p_visit_id, p_hotel, p_work_order, p_actor, actor_name, actor_role,
      p_context_key, p_item_id, p_action, p_step_label, p_source, p_before_state, p_after_state, saved.revision, request_body);
  update public.cmpri_work_order_troubleshooting_visits
    set last_event_at = clock_timestamp(), event_count = event_count + 1 where id = p_visit_id;
  return next saved;
end;
$$;

revoke all on function public.cmpri_save_work_order_troubleshooting(uuid, uuid, text, bigint, bigint, jsonb, jsonb, uuid, uuid, uuid, text, text, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.cmpri_save_work_order_troubleshooting(uuid, uuid, text, bigint, bigint, jsonb, jsonb, uuid, uuid, uuid, text, text, text, jsonb, jsonb, jsonb)
  to service_role;

create trigger resource_work_order_troubleshooting
  after insert or update or delete on public.cmpri_work_order_troubleshooting_checks
  for each row execute function cmpri_private.signal_resource('orders');

create function public.cmpri_finalize_work_order_troubleshooting(
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
        when e.after_state->>'status' = 'approved' then 'verified' else 'checked' end as action_label
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
revoke all on function public.cmpri_finalize_work_order_troubleshooting(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.cmpri_finalize_work_order_troubleshooting(uuid, uuid, uuid, uuid) to service_role;

commit;
