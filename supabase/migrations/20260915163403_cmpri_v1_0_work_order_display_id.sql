-- CMPRI v1.0 authoritative work-order display ids.
create or replace function public.cmpri_assign_work_order_display_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  local_year text;
  prefix text;
  next_number bigint;
begin
  if nullif(btrim(coalesce(new.display_id, '')), '') is not null then
    return new;
  end if;

  local_year := to_char((now() at time zone 'America/Chicago'), 'YY');
  prefix := 'WO-' || local_year || '-';

  perform pg_advisory_xact_lock(hashtext('cmpri-work-order-display-id:' || new.hotel_id::text || ':' || local_year));

  select coalesce(max(substring(w.display_id from '[0-9]+$')::bigint), 0) + 1
    into next_number
  from public.work_orders w
  where w.hotel_id = new.hotel_id
    and w.display_id ~ ('^' || prefix || '[0-9]+$');

  new.display_id := prefix || lpad(next_number::text, 4, '0');
  return new;
end;
$$;

drop trigger if exists cmpri_work_order_display_id on public.work_orders;
create trigger cmpri_work_order_display_id
before insert on public.work_orders
for each row execute function public.cmpri_assign_work_order_display_id();

create unique index if not exists cmpri_work_orders_hotel_display_id_unique
  on public.work_orders(hotel_id, display_id);