-- CMPRI v1.0 pool-log guard. Validate in an isolated copy before production.
-- Site-specific recording rule: one physical AM sample and one physical PM
-- sample; each pH+bromine result is written into BOTH Shallow and Deep report
-- cells. This migration does not calculate chemical doses or certify opening.
begin;
alter table public.pool_daily_logs add column if not exists ph_am numeric;
alter table public.pool_daily_logs add column if not exists ph_pm numeric;
alter table public.pool_daily_logs add column if not exists sanitizer_am numeric;
alter table public.pool_daily_logs add column if not exists sanitizer_pm numeric;
alter table public.pool_daily_logs add column if not exists revision bigint not null default 1;
alter table public.pool_daily_logs add column if not exists updated_by uuid;

create unique index if not exists cmpri_pool_daily_log_unique
on public.pool_daily_logs(hotel_id, pool_facility_id, log_date);

create table if not exists public.cmpri_pool_log_history (
  id uuid primary key default gen_random_uuid(),
  pool_log_id uuid not null references public.pool_daily_logs(id),
  hotel_id uuid not null,
  actor_id uuid,
  recorded_at timestamptz not null default now(),
  snapshot jsonb not null
);
alter table public.cmpri_pool_log_history enable row level security;

create or replace function public.cmpri_stamp_pool_log()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := coalesce(auth.uid(), new.updated_by);
  actor_role text;
begin
  select regexp_replace(lower(p.role),'[[:space:]_-]','','g') into actor_role
  from public.profiles p
  join public.hotel_members m on m.user_id=p.id
  where p.id=actor and p.active=true and m.active=true and m.hotel_id=new.hotel_id;

  if actor_role is null or actor_role not in
    ('admin','administrator','systemadmin','systemadministrator','chiefengineer',
     'engineer','engineering','technician','maintenancetechnician','regionalmaintenance') then
    raise exception 'An active CMPRI engineering account is required';
  end if;

  -- A complete sample is a pair. Never save only pH or only bromine for a period.
  if (new.ph_am is null) <> (new.sanitizer_am is null) then
    raise exception 'AM sample requires both pH and bromine';
  end if;
  if (new.ph_pm is null) <> (new.sanitizer_pm is null) then
    raise exception 'PM sample requires both pH and bromine';
  end if;

  -- Site-specific inspector direction: same single result in both report locations.
  new.ph_shallow_am := new.ph_am;
  new.ph_deep_am := new.ph_am;
  new.sanitizer_shallow_am := new.sanitizer_am;
  new.sanitizer_deep_am := new.sanitizer_am;
  new.ph_shallow_pm := new.ph_pm;
  new.ph_deep_pm := new.ph_pm;
  new.sanitizer_shallow_pm := new.sanitizer_pm;
  new.sanitizer_deep_pm := new.sanitizer_pm;

  new.updated_by := actor;
  new.updated_at := now();
  if TG_OP = 'INSERT' then
    new.revision := 1;
    new.created_by := coalesce(auth.uid(), new.created_by);
  else
    new.revision := old.revision + 1;
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;

create or replace function public.cmpri_audit_pool_log()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.cmpri_pool_log_history(pool_log_id,hotel_id,actor_id,snapshot)
  values(new.id,new.hotel_id,new.updated_by,to_jsonb(new));
  return new;
end;
$$;

drop trigger if exists cmpri_pool_log_stamp on public.pool_daily_logs;
create trigger cmpri_pool_log_stamp before insert or update on public.pool_daily_logs
for each row execute function public.cmpri_stamp_pool_log();
drop trigger if exists cmpri_pool_log_audit on public.pool_daily_logs;
create trigger cmpri_pool_log_audit after insert or update on public.pool_daily_logs
for each row execute function public.cmpri_audit_pool_log();
commit;
