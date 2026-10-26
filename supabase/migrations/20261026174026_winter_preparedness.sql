-- Application API verifies active identity, exact hotel membership and checklist-specific roles.
-- No direct browser/MCP access. State and append-only change history commit together.
create table public.cmpri_winter_items (
  hotel_id uuid not null references public.hotels(id),
  year integer not null check (year = 2026),
  item_id text not null check (item_id in ('water-shutoffs','heaters','back-of-house','weather-tight','pipe-insulation','drains','ooo-rooms','dry-sprinklers','fire-pumps','exhaust-fans','louvers','fire-panel','pic-training','lawn-sprinklers','furniture','wet-floor','travel-safety','snow-blowers','storm-recovery','supplies','ice-melt','shovels','car-scrapers','flashlights','blankets','deicer','gloves','battery-charger','snow-agreements','curb-flags','snow-contact','emergency-access')),
  checked boolean not null,
  revision integer not null check (revision > 0),
  changed_by uuid not null references auth.users(id),
  changed_by_name text not null,
  changed_at timestamptz not null default clock_timestamp(),
  primary key (hotel_id, year, item_id)
);
create table public.cmpri_winter_changes (
  hotel_id uuid not null,
  year integer not null,
  item_id text not null,
  revision integer not null,
  checked boolean not null,
  changed_by uuid not null,
  changed_by_name text not null,
  changed_at timestamptz not null,
  primary key (hotel_id, year, item_id, revision),
  foreign key (hotel_id, year, item_id) references public.cmpri_winter_items(hotel_id, year, item_id)
);
alter table public.cmpri_winter_items enable row level security;
alter table public.cmpri_winter_items force row level security;
alter table public.cmpri_winter_changes enable row level security;
alter table public.cmpri_winter_changes force row level security;
revoke all on public.cmpri_winter_items, public.cmpri_winter_changes from public, anon, authenticated, service_role;
grant select, insert, update on public.cmpri_winter_items to service_role;
grant select, insert on public.cmpri_winter_changes to service_role;

create function public.cmpri_winter_stamp() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if TG_OP = 'INSERT' and NEW.revision <> 1 then
    raise exception 'Initial checklist revision must be one';
  end if;
  if TG_OP = 'UPDATE' and (NEW.revision <> OLD.revision + 1
    or NEW.hotel_id <> OLD.hotel_id or NEW.year <> OLD.year or NEW.item_id <> OLD.item_id) then
    raise exception 'Invalid checklist revision or identity';
  end if;
  NEW.changed_at := clock_timestamp();
  return NEW;
end;
$$;
create function public.cmpri_winter_audit() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.cmpri_winter_changes(hotel_id,year,item_id,revision,checked,changed_by,changed_by_name,changed_at)
  values (NEW.hotel_id,NEW.year,NEW.item_id,NEW.revision,NEW.checked,NEW.changed_by,NEW.changed_by_name,NEW.changed_at);
  return NEW;
end;
$$;
revoke all on function public.cmpri_winter_stamp(), public.cmpri_winter_audit() from public, anon, authenticated;
grant execute on function public.cmpri_winter_stamp(), public.cmpri_winter_audit() to service_role;
create trigger cmpri_winter_stamp before insert or update on public.cmpri_winter_items for each row execute function public.cmpri_winter_stamp();
create trigger cmpri_winter_audit after insert or update on public.cmpri_winter_items for each row execute function public.cmpri_winter_audit();
