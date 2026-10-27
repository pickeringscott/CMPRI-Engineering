-- A new passing retest resolves only the testing-driven reopening latch.
-- No backfill: existing logs, control state and audit attribution stay untouched.
create or replace function public.cmpri_pool_status_changed() returns trigger
 language plpgsql security definer set search_path=public,pg_temp as $$
declare fresh_retest boolean; current_log uuid; last_control_action text;
begin
 fresh_retest=new.retest_submission is not null;
 if TG_OP='UPDATE' then
  fresh_retest=fresh_retest and (new.retest_submission->>'id' is distinct from old.retest_submission->>'id');
 end if;
 select id into current_log from public.pool_daily_logs
 where hotel_id=new.hotel_id and pool_facility_id=new.pool_facility_id
 and log_date<=(public.cmpri_pool_clock() at time zone 'America/Chicago')::date
 order by log_date desc limit 1;
 -- Clearing a manual hold intentionally still needs the existing Open pool action.
 select action into last_control_action from public.cmpri_pool_control_history
 where hotel_id=new.hotel_id and facility_id=new.pool_facility_id
 order by recorded_at desc,id desc limit 1;

 if fresh_retest and current_log=new.id
  and new.closure_condition is false and new.manual_closure is false
  and public.cmpri_pool_test_passes(new)
  and new.flow_rate_gpm is not null and new.filter_backwashed is not null
  and last_control_action is distinct from 'clear-manual' then
  update public.cmpri_pool_control set reopen_pending=false
  where hotel_id=new.hotel_id and facility_id=new.pool_facility_id and manual_closed=false;
 elsif new.closure_condition is true or exists(
  select 1 from public.cmpri_pool_control where hotel_id=new.hotel_id
  and facility_id=new.pool_facility_id and last_closed=true
  and last_reason is distinct from 'Closed 10 PM-7 AM') then
  insert into public.cmpri_pool_control(hotel_id,facility_id,reopen_pending)
  values(new.hotel_id,new.pool_facility_id,true)
  on conflict(hotel_id,facility_id) do update set reopen_pending=true;
 end if;
 -- The existing projection still enforces hours, testing failures and independent holds.
 perform public.cmpri_pool_reconcile(new.hotel_id,new.pool_facility_id,true);
 return new;
end $$;
