create or replace function public.cmpri_bump_work_order_revision()
returns trigger language plpgsql set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    new.revision := 1;
  else
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;
drop trigger if exists cmpri_work_order_revision on public.work_orders;
create trigger cmpri_work_order_revision before insert or update on public.work_orders
for each row execute function public.cmpri_bump_work_order_revision();