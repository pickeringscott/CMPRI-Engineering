\set ON_ERROR_STOP on
begin;
set constraints all immediate;
insert into public.locations values ('00000000-0000-0000-0000-000000009901','00000000-0000-0000-0000-000000000001','Test Urgent','Guest Room','9901',true),('00000000-0000-0000-0000-000000009902','00000000-0000-0000-0000-000000000001','Test Escalate','Guest Room','9902',true);
insert into public.work_orders(id,hotel_id,location_id,priority,due_by) values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000009901','Urgent','2030-01-01');
do $$ begin if not exists(select 1 from public.work_orders where id='10000000-0000-0000-0000-000000000001' and due_by=((now() at time zone 'America/Chicago')::date::timestamp at time zone 'UTC')) then raise exception 'urgent insert date wrong'; end if; end $$;
update public.work_orders set due_by='2020-01-01' where id='10000000-0000-0000-0000-000000000001';
update public.work_orders set priority='Urgent',due_by='2020-01-01',issue='unchanged priority save' where id='10000000-0000-0000-0000-000000000001';
do $$ begin if not exists(select 1 from public.work_orders where id='10000000-0000-0000-0000-000000000001' and due_by='2020-01-01') then raise exception 'urgent unchanged reset'; end if; end $$;
update public.work_orders set priority='High' where id='10000000-0000-0000-0000-000000000001';
update public.work_orders set priority='Urgent',due_by='2030-01-01' where id='10000000-0000-0000-0000-000000000001';
do $$ begin if not exists(select 1 from public.work_orders where id='10000000-0000-0000-0000-000000000001' and due_by=((now() at time zone 'America/Chicago')::date::timestamp at time zone 'UTC')) then raise exception 'urgent transition date wrong'; end if; end $$;
insert into public.work_orders(id,hotel_id,location_id,priority,due_by) select ('20000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000009902','Low','2030-01-01' from generate_series(1,4) n;
do $$ begin if (select count(*) from public.work_orders where location_id='00000000-0000-0000-0000-000000009902' and priority='Urgent' and ranker_auto_urgent and due_by=((now() at time zone 'America/Chicago')::date::timestamp at time zone 'UTC')) <> 4 then raise exception 'auto urgent failed'; end if; end $$;
update public.work_orders set due_by='2031-02-03',priority='Urgent' where id='20000000-0000-0000-0000-000000000001';
do $$ begin if not exists(select 1 from public.work_orders where id='20000000-0000-0000-0000-000000000001' and ranker_base_due_by='2031-02-03' and due_by=((now() at time zone 'America/Chicago')::date::timestamp at time zone 'UTC')) then raise exception 'auto urgent due edit failed'; end if; end $$;
update public.work_orders set status='Closed' where id='20000000-0000-0000-0000-000000000004';
do $$ begin if not exists(select 1 from public.work_orders where id='20000000-0000-0000-0000-000000000001' and priority='Medium' and due_by='2031-02-03' and not ranker_auto_urgent) then raise exception 'auto urgent due restoration failed'; end if; end $$;
rollback;
