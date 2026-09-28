-- CMPRI v1.0 authoritative work-order history and reopen assignment memory.
begin;
create extension if not exists pgcrypto;

alter table public.work_orders
  add column if not exists last_assigned_technician_name text not null default '',
  add column if not exists submitted_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists creator_account_user_id uuid references auth.users(id) on delete set null;

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
  snapshot jsonb not null,
  recorded_at timestamptz not null default now()
);
create index if not exists cmpri_work_order_history_ticket_idx
  on public.cmpri_work_order_history(hotel_id, work_order_id, recorded_at);
alter table public.cmpri_work_order_history enable row level security;

drop policy if exists cmpri_work_order_history_member_read on public.cmpri_work_order_history;
create policy cmpri_work_order_history_member_read on public.cmpri_work_order_history
for select using (
  exists (
    select 1
    from public.hotel_members m
    join public.profiles p on p.id = auth.uid()
    where m.user_id = auth.uid()
      and m.hotel_id = cmpri_work_order_history.hotel_id
      and m.active = true
      and p.active = true
      and lower(regexp_replace(p.role, '[^a-z0-9]', '', 'g')) in (
        'chiefengineer','engineeringmanager',
        'maintenancetechnician','technician','engineer','engineering',
        'regionalmaintenance','regionalengineer',
        'generalmanager','gm',
        'seniormanagement','uppermanagement','vpfacilities','regionaldirectoroperations','districtmanager',
        'systemadmin','systemadministrator','administrator','admin'
      )
  )
);

create or replace function public.cmpri_record_work_order_history()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    if coalesce(new.technician_name,'') <> '' then
      new.last_assigned_technician_name := new.technician_name;
    end if;
    return new;
  end if;

  if coalesce(new.technician_name,'') <> '' then
    new.last_assigned_technician_name := new.technician_name;
  elsif new.status = 'In Progress' and coalesce(old.last_assigned_technician_name,'') <> '' then
    new.technician_name := old.last_assigned_technician_name;
    new.last_assigned_technician_name := old.last_assigned_technician_name;
  else
    new.last_assigned_technician_name := old.last_assigned_technician_name;
  end if;
  return new;
end;
$$;

drop trigger if exists cmpri_work_order_assignment_memory on public.work_orders;
create trigger cmpri_work_order_assignment_memory
before insert or update on public.work_orders
for each row execute function public.cmpri_record_work_order_history();

create or replace function public.cmpri_audit_work_order_history()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := coalesce(auth.uid(), new.submitted_by_user_id, new.creator_account_user_id, new.created_by);
  actor_label text := '';
  changed jsonb := '{}'::jsonb;
  event_name text := 'updated';
begin
  if actor is not null then
    select coalesce(nullif(btrim(p.full_name),''), '') into actor_label
    from public.profiles p where p.id = actor;
  end if;
  if actor_label = '' then
    actor_label := coalesce(nullif(btrim(new.creator_name),''), 'System');
  end if;

  if TG_OP = 'INSERT' then
    event_name := 'created';
    changed := to_jsonb(new);
  else
    if old.status is distinct from new.status then
      event_name := case
        when old.status = 'Closed' and new.status in ('In Progress','Completed') then 'reopened'
        when new.status = 'Closed' then 'closed'
        else 'status_changed'
      end;
    end if;
    changed := jsonb_strip_nulls(jsonb_build_object(
      'issue', case when old.issue is distinct from new.issue then to_jsonb(new.issue) end,
      'asset_id', case when old.asset_id is distinct from new.asset_id then to_jsonb(new.asset_id) end,
      'asset_name', case when old.asset_name is distinct from new.asset_name then to_jsonb(new.asset_name) end,
      'category', case when old.category is distinct from new.category then to_jsonb(new.category) end,
      'priority', case when old.priority is distinct from new.priority then to_jsonb(new.priority) end,
      'technician_name', case when old.technician_name is distinct from new.technician_name then to_jsonb(new.technician_name) end,
      'status', case when old.status is distinct from new.status then to_jsonb(new.status) end,
      'notes', case when old.notes is distinct from new.notes then to_jsonb(new.notes) end,
      'action_root_cause', case when old.action_root_cause is distinct from new.action_root_cause then to_jsonb(new.action_root_cause) end,
      'parts', case when old.parts is distinct from new.parts then to_jsonb(new.parts) end,
      'cost', case when old.cost is distinct from new.cost then to_jsonb(new.cost) end,
      'hours', case when old.hours is distinct from new.hours then to_jsonb(new.hours) end,
      'due_by', case when old.due_by is distinct from new.due_by then to_jsonb(new.due_by) end
    ));
  end if;

  insert into public.cmpri_work_order_history(
    hotel_id, work_order_id, actor_user_id, actor_name, event_type,
    old_status, new_status, changed_fields, snapshot
  ) values (
    new.hotel_id, new.id, actor, actor_label, event_name,
    case when TG_OP='UPDATE' then old.status::text else null end,
    new.status::text, changed, to_jsonb(new)
  );
  return new;
end;
$$;

drop trigger if exists cmpri_work_order_history_audit on public.work_orders;
create trigger cmpri_work_order_history_audit
after insert or update on public.work_orders
for each row execute function public.cmpri_audit_work_order_history();
commit;
