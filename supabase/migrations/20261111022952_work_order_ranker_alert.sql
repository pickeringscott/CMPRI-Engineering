-- Remember room-driven escalation until this work order closes, even if the room rank later falls.
alter table public.work_orders add column ranker_alert_active boolean not null default false;

create function cmpri_private.retain_work_order_ranker_alert() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status::text in ('Closed','Will Not Do') then
    new.ranker_alert_active := false;
  elsif (new.ranker_auto_urgent or (new.ranker_base_priority = 'Low' and new.priority in ('Medium','High','Urgent')) or (new.ranker_base_priority = 'Medium' and new.priority in ('High','Urgent'))) then
    new.ranker_alert_active := true;
  elsif tg_op = 'UPDATE' then
    new.ranker_alert_active := old.ranker_alert_active;
  end if;
  return new;
end $$;
revoke all on function cmpri_private.retain_work_order_ranker_alert() from public, anon, authenticated;
create trigger ab_retain_work_order_ranker_alert before insert or update on public.work_orders
for each row execute function cmpri_private.retain_work_order_ranker_alert();
update public.work_orders set ranker_alert_active = true
where status::text not in ('Closed','Will Not Do') and (ranker_auto_urgent or (ranker_base_priority = 'Low' and priority in ('Medium','High','Urgent')) or (ranker_base_priority = 'Medium' and priority in ('High','Urgent')));

-- Each fresh troubleshooting session gets a distinct ledger while older checks and notes remain intact.
alter table public.work_orders add column troubleshooting_run_id uuid;
