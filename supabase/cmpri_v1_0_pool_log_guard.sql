-- CMPRI v1.0 pool-log guard. Validate in an isolated copy before production.
-- Site-specific recording rule: one physical AM sample and one physical PM
-- sample; each pH+bromine result is written at its selected report location.
-- This migration does not calculate chemical doses or certify opening.
begin;
alter table public.pool_daily_logs add column if not exists ph_am numeric;
alter table public.pool_daily_logs add column if not exists ph_pm numeric;
alter table public.pool_daily_logs add column if not exists sanitizer_am numeric;
alter table public.pool_daily_logs add column if not exists sanitizer_pm numeric;
alter table public.pool_daily_logs add column if not exists sanitizer_band_am text
  check (sanitizer_band_am in ('0', '1-2', '2-4', '3-6', '5-10', '7.5-15', '10-20'));
alter table public.pool_daily_logs add column if not exists sanitizer_band_pm text
  check (sanitizer_band_pm in ('0', '1-2', '2-4', '3-6', '5-10', '7.5-15', '10-20'));
alter table public.pool_daily_logs add column if not exists sample_location_am text
  check (sample_location_am in ('shallow', 'deep'));
alter table public.pool_daily_logs add column if not exists sample_location_pm text
  check (sample_location_pm in ('shallow', 'deep'));
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
     'engineer','engineering','technician','maintenancetechnician','regionalmaintenance',
     'frontdeskmanager','generalmanager','gm','assistantmanager','assistantgeneralmanager','assistantgm') THEN
    raise exception 'An active CMPRI engineering account is required';
  end if;

  -- A complete sample is a pH result plus one numeric or range bromine result.
  if (new.ph_am is null) <> (new.sanitizer_am is null and new.sanitizer_band_am is null) then
    raise exception 'AM sample requires both pH and bromine';
  end if;
  if (new.ph_pm is null) <> (new.sanitizer_pm is null and new.sanitizer_band_pm is null) then
    raise exception 'PM sample requires both pH and bromine';
  end if;
  if (new.sanitizer_am is not null and new.sanitizer_band_am is not null)
    or (new.sanitizer_pm is not null and new.sanitizer_band_pm is not null) then
    raise exception 'Use either a numeric bromine reading or a selected range, not both';
  end if;
  if (new.ph_am is not null and new.sample_location_am is null)
    or (new.ph_pm is not null and new.sample_location_pm is null) then
    raise exception 'Each sample requires a shallow or deep location';
  end if;
  if new.ph_am is null then new.sample_location_am := null; end if;
  if new.ph_pm is null then new.sample_location_pm := null; end if;

  new.ph_shallow_am := case when new.sample_location_am = 'shallow' then new.ph_am else null end;
  new.ph_deep_am := case when new.sample_location_am = 'deep' then new.ph_am else null end;
  new.sanitizer_shallow_am := case when new.sample_location_am = 'shallow' then new.sanitizer_am else null end;
  new.sanitizer_deep_am := case when new.sample_location_am = 'deep' then new.sanitizer_am else null end;
  new.ph_shallow_pm := case when new.sample_location_pm = 'shallow' then new.ph_pm else null end;
  new.ph_deep_pm := case when new.sample_location_pm = 'deep' then new.ph_pm else null end;
  new.sanitizer_shallow_pm := case when new.sample_location_pm = 'shallow' then new.sanitizer_pm else null end;
  new.sanitizer_deep_pm := case when new.sample_location_pm = 'deep' then new.sanitizer_pm else null end;

  if new.ph_am < 7.2 or new.ph_am > 7.8
    or new.ph_pm < 7.2 or new.ph_pm > 7.8
    or new.sanitizer_band_am in ('0', '1-2', '7.5-15', '10-20')
    or new.sanitizer_band_pm in ('0', '1-2', '7.5-15', '10-20')
    or new.sanitizer_am <= 2 or new.sanitizer_am >= 7.5
    or new.sanitizer_pm <= 2 or new.sanitizer_pm >= 7.5 then
    new.closure_condition := true;
  end if;

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
