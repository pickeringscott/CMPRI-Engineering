-- CMPRI V1.0 remembers the most recent assigned technician so a Chief Engineer
-- can reopen Closed -> In Progress and restore the prior assignment.
alter table public.work_orders add column if not exists last_assigned_technician_name text;

create or replace function public.cmpri_remember_work_order_technician()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if nullif(btrim(coalesce(new.technician_name, '')), '') is not null then
    new.last_assigned_technician_name := btrim(new.technician_name);
  elsif TG_OP = 'UPDATE' then
    if nullif(btrim(coalesce(old.technician_name, '')), '') is not null then
      new.last_assigned_technician_name := btrim(old.technician_name);
    else
      new.last_assigned_technician_name := old.last_assigned_technician_name;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists cmpri_work_order_assignment_memory on public.work_orders;
create trigger cmpri_work_order_assignment_memory
before insert or update of technician_name on public.work_orders
for each row execute function public.cmpri_remember_work_order_technician();
