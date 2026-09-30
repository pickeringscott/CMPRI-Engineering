-- Permanent work-order history for the "Technician Notes & Ticket History" panel.
-- A trigger records creation, every status change, and every claim/assignment.
-- Rows are written only by the trigger (security definer); the API can read them,
-- but nobody can edit or delete them through the API, so the entries are permanent.

create table if not exists public.cmpri_work_order_history (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_name text not null default '',
  event_type text not null,
  old_status text,
  new_status text,
  changed_fields jsonb not null default '{}'::jsonb,
  snapshot jsonb not null default '{}'::jsonb,
  source text not null default '',
  recorded_at timestamptz not null default clock_timestamp(),
  constraint cmpri_work_order_history_event_type_check check (event_type in (
    'created', 'status_changed', 'closed', 'reopened', 'claimed', 'assigned', 'unassigned'
  ))
);

create index if not exists cmpri_work_order_history_ticket_idx
  on public.cmpri_work_order_history (hotel_id, work_order_id, recorded_at);
create index if not exists cmpri_work_order_history_recorded_idx
  on public.cmpri_work_order_history (hotel_id, recorded_at);

alter table public.cmpri_work_order_history enable row level security;
revoke all on table public.cmpri_work_order_history from anon, authenticated, service_role;
grant select on table public.cmpri_work_order_history to service_role;

-- Server-only hint naming who made a change when the API writes with the service
-- role (ChatGPT connections). A signed-in user's own token always wins over it.
alter table public.work_orders add column if not exists history_actor_user_id uuid;
alter table public.work_orders add column if not exists history_source text;

create or replace function public.cmpri_capture_work_order_history_actor()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform set_config('cmpri.history_actor', coalesce(new.history_actor_user_id::text, ''), true);
  perform set_config('cmpri.history_source', coalesce(left(btrim(new.history_source), 60), ''), true);
  new.history_actor_user_id := null;
  new.history_source := null;
  return new;
end;
$$;

drop trigger if exists cmpri_work_order_history_actor on public.work_orders;
create trigger cmpri_work_order_history_actor
before insert or update on public.work_orders
for each row execute function public.cmpri_capture_work_order_history_actor();

create or replace function public.cmpri_log_work_order_history()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_hint text := nullif(current_setting('cmpri.history_actor', true), '');
  v_profile_name text;
  v_actor_name text;
  v_source text := nullif(current_setting('cmpri.history_source', true), '');
  v_old_tech text;
  v_new_tech text;
  v_snapshot jsonb := jsonb_build_object(
    'display_id', new.display_id,
    'technician_name', new.technician_name,
    'status', new.status::text
  );
begin
  if v_actor is null and v_hint ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_actor := v_hint::uuid;
  end if;
  v_source := coalesce(v_source, case when auth.uid() is not null then 'CMPRI app' when TG_OP = 'INSERT' then 'CMPRI server' else 'Direct database change' end);
  if v_actor is null and TG_OP = 'INSERT' then
    v_actor := coalesce(new.created_by, new.submitted_by_user_id);
  end if;
  if v_actor is not null then
    select nullif(btrim(p.full_name), '') into v_profile_name from public.profiles p where p.id = v_actor;
    if not exists (select 1 from auth.users u where u.id = v_actor) then
      v_actor := null;
    end if;
  end if;
  v_actor_name := coalesce(
    v_profile_name,
    case when TG_OP = 'INSERT' then nullif(btrim(new.creator_name), '') end,
    'System'
  );

  if TG_OP = 'INSERT' then
    insert into public.cmpri_work_order_history
      (hotel_id, work_order_id, actor_user_id, actor_name, event_type, old_status, new_status, changed_fields, snapshot, source)
    values
      (new.hotel_id, new.id, v_actor, v_actor_name, 'created', null, new.status::text, '{}'::jsonb, v_snapshot, v_source);
    return new;
  end if;

  v_old_tech := btrim(coalesce(old.technician_name, ''));
  v_new_tech := btrim(coalesce(new.technician_name, ''));
  if v_old_tech is distinct from v_new_tech then
    insert into public.cmpri_work_order_history
      (hotel_id, work_order_id, actor_user_id, actor_name, event_type, old_status, new_status, changed_fields, snapshot, source)
    values (
      new.hotel_id, new.id, v_actor, v_actor_name,
      case
        when v_new_tech = '' then 'unassigned'
        when v_old_tech = '' and v_profile_name is not null and lower(v_new_tech) = lower(v_profile_name) then 'claimed'
        else 'assigned'
      end,
      new.status::text, new.status::text,
      jsonb_build_object('technician_name', v_new_tech, 'previous_technician_name', v_old_tech),
      v_snapshot, v_source
    );
  end if;

  if old.status is distinct from new.status then
    insert into public.cmpri_work_order_history
      (hotel_id, work_order_id, actor_user_id, actor_name, event_type, old_status, new_status, changed_fields, snapshot, source)
    values (
      new.hotel_id, new.id, v_actor, v_actor_name,
      case
        when old.status::text = 'Closed' then 'reopened'
        when new.status::text = 'Closed' then 'closed'
        else 'status_changed'
      end,
      old.status::text, new.status::text,
      jsonb_build_object('status', new.status::text),
      v_snapshot, v_source
    );
  end if;
  return new;
end;
$$;

revoke all on function public.cmpri_log_work_order_history() from public, anon, authenticated;
revoke all on function public.cmpri_capture_work_order_history_actor() from public, anon, authenticated;

drop trigger if exists cmpri_work_order_history_log on public.work_orders;
create trigger cmpri_work_order_history_log
after insert or update of status, technician_name on public.work_orders
for each row execute function public.cmpri_log_work_order_history();
