begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $preflight$ begin
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_proc where oid=to_regprocedure('cmpri_private.materialize_work_notification()')) is distinct from 'd011ab6eb8a69e72689816bce10ed186' then raise exception 'Live notification behavior changed: materialize_work_notification; recheck before applying'; end if;
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_proc where oid=to_regprocedure('cmpri_private.notify_added_work_order_notes()')) is distinct from '7e2f51f2c54176284096056038d74290' then raise exception 'Live notification behavior changed: notify_added_work_order_notes; recheck before applying'; end if;
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_proc where oid=to_regprocedure('cmpri_private.notify_work_order_collaborators(uuid,uuid,text,text,timestamp with time zone)')) is distinct from '5853d25769bed615e19fa3dc1fc28a38' then raise exception 'Live notification behavior changed: notify_work_order_collaborators; recheck before applying'; end if;
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_proc where oid=to_regprocedure('cmpri_private.notify_work_order_status_team(uuid,uuid,text,text,timestamp with time zone)')) is distinct from 'd4b201cd17ecf2476b2bf56b1a88abe7' then raise exception 'Live notification behavior changed: notify_work_order_status_team; recheck before applying'; end if;
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_proc where oid=to_regprocedure('cmpri_private.room_ranker_recalculate(uuid,uuid,boolean)')) is distinct from 'f08fcc783b11790f741cc938076147fa' then raise exception 'Live notification behavior changed: room_ranker_recalculate; recheck before applying'; end if;
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_proc where oid=to_regprocedure('public.cmpri_commit_guest_reports(uuid,uuid,text,date,uuid,jsonb)')) is distinct from '0156a9fd06aa90ad55702cde97f4e585' then raise exception 'Live notification behavior changed: cmpri_commit_guest_reports; recheck before applying'; end if;
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_proc where oid=to_regprocedure('public.cmpri_pool_reconcile(uuid,uuid,boolean)')) is distinct from '8ad2751ad3d4e480a19f58eb6e7bccf0' then raise exception 'Live notification behavior changed: cmpri_pool_reconcile; recheck before applying'; end if;
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_proc where oid=to_regprocedure('public.cmpri_post_staff_note(uuid,uuid,text,text,uuid,uuid,jsonb)')) is distinct from '8243cdd160ddebcb517b0a1bfce0bae5' then raise exception 'Live notification behavior changed: cmpri_post_staff_note; recheck before applying'; end if;
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_proc where oid=to_regprocedure('public.cmpri_post_staff_note_with_files(uuid,uuid,text,text,uuid,uuid,jsonb,uuid[],text[],jsonb)')) is distinct from 'b2209349b43070da476c6984b9cfbe28' then raise exception 'Live notification behavior changed: cmpri_post_staff_note_with_files; recheck before applying'; end if;
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_proc where oid=to_regprocedure('public.cmpri_save_mentioned_work_order(uuid,uuid,uuid,integer,jsonb,uuid[],boolean)')) is distinct from '8a42130b88ec3215d267d3beb714fd13' then raise exception 'Live notification behavior changed: cmpri_save_mentioned_work_order; recheck before applying'; end if;
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_proc where oid=to_regprocedure('public.cmpri_pool_action(uuid,uuid,uuid,uuid,text,text,bigint)')) is distinct from 'b217c47994ba766360afc7bd27e6fb46' then raise exception 'Live notification behavior changed: cmpri_pool_action; recheck before applying'; end if;
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_proc where oid=to_regprocedure('public.cmpri_pool_status_changed()')) is distinct from '7999c5f441893dfb486bbf822d7038ca' then raise exception 'Live notification behavior changed: cmpri_pool_status_changed; recheck before applying'; end if;
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_proc where oid=to_regprocedure('public.cmpri_capture_work_order_history_actor()')) is distinct from 'd291161f2b7eaa913260b3edd23587f1' then raise exception 'Live notification behavior changed: cmpri_capture_work_order_history_actor; recheck before applying'; end if;
end $preflight$;

alter table public.cmpri_dashboard_notifications add column actor_user_id uuid;

create function cmpri_private.notification_event_actor(p_hotel uuid,p_key text,p_order uuid)
returns uuid language plpgsql volatile security invoker set search_path='' as $actor$
declare token text; event_id uuid; result uuid;
begin
 if p_key like 'new-order:%' then
  token=split_part(p_key,':',2);
 elsif p_key like 'work-order-status:%' or p_key like 'history:%' or p_key like 'report-correction:%'
    or p_key like 'staff-note:%' or p_key like 'room-operations:%' or p_key like 'technician-view:%' then
  token=split_part(p_key,':',2);
 elsif p_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then token=p_key;
 else return null;
 end if;
 if token !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
 event_id=token::uuid;
 if p_key like 'new-order:%' then
  select h.actor_user_id into result from public.cmpri_work_order_history h
   where h.hotel_id=p_hotel and h.work_order_id=event_id and h.event_type='created'
   order by h.recorded_at,h.id limit 1;
  if result is null then select coalesce(w.submitted_by_user_id,w.created_by) into result
   from public.work_orders w where w.hotel_id=p_hotel and w.id=event_id; end if;
 elsif p_key like 'staff-note:%' then
  select n.author_user_id into result from public.cmpri_staff_notes n where n.hotel_id=p_hotel and n.id=event_id;
 elsif p_key like 'room-operations:%' then
  select i.imported_by_user_id into result from public.cmpri_room_operation_imports i where i.hotel_id=p_hotel and i.id=event_id;
 elsif p_key like 'technician-view:%' then
  select v.technician_user_id into result from public.cmpri_work_order_technician_views v where v.hotel_id=p_hotel and v.id=event_id;
 else
  select h.actor_user_id into result from public.cmpri_work_order_history h
   where h.hotel_id=p_hotel and h.id=event_id and (p_order is null or h.work_order_id=p_order);
 end if;
 return result;
end $actor$;
revoke all on function cmpri_private.notification_event_actor(uuid,text,uuid) from public,anon,authenticated;

create function cmpri_private.notification_context_actor(p_hotel uuid)
returns uuid language plpgsql stable security invoker set search_path='' as $actor$
declare actor text;
begin
 if current_setting('cmpri.notification_hotel',true) is distinct from p_hotel::text then return null; end if;
 actor=current_setting('cmpri.notification_actor',true);
 if actor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return actor::uuid; end if;
 return null;
end $actor$;
revoke all on function cmpri_private.notification_context_actor(uuid) from public,anon,authenticated;

create function cmpri_private.suppress_self_notification()
returns trigger language plpgsql security definer set search_path='' as $guard$
begin
 new.actor_user_id=coalesce(new.actor_user_id,
   cmpri_private.notification_event_actor(new.hotel_id,new.notification_key,new.work_order_id),
   cmpri_private.notification_context_actor(new.hotel_id),auth.uid());
 if new.actor_user_id=new.recipient_user_id then return null; end if;
 return new;
end $guard$;
revoke all on function cmpri_private.suppress_self_notification() from public,anon,authenticated;
create trigger aa_suppress_self_notification before insert on public.cmpri_dashboard_notifications
for each row execute function cmpri_private.suppress_self_notification();

CREATE OR REPLACE FUNCTION public.cmpri_capture_work_order_history_actor()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  -- Retain the initiating user through automatic ranker updates in this transaction.
  if coalesce(current_setting('cmpri.room_ranker_internal',true),'') <> 'on' then
    perform set_config('cmpri.notification_actor',coalesce(new.history_actor_user_id::text,''),true);
    perform set_config('cmpri.notification_hotel',new.hotel_id::text,true);
  end if;
  perform set_config('cmpri.history_actor', coalesce(new.history_actor_user_id::text, ''), true);
  perform set_config('cmpri.history_source', coalesce(left(btrim(new.history_source), 60), ''), true);
  new.history_actor_user_id := null;
  new.history_source := null;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.cmpri_pool_action(p_hotel uuid, p_facility uuid, p_actor uuid, p_id uuid, p_action text, p_reason text, p_revision bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare s public.cmpri_pool_control; l public.pool_daily_logs; before_state jsonb; result jsonb; prior public.cmpri_pool_control_history; request_body jsonb; engineering boolean; previous_actor text; previous_hotel text;
begin
 if p_id is null or p_actor is null or p_revision is null or p_action not in ('close','open','clear-manual') then raise exception 'Invalid pool action'; end if;
 select exists(select 1 from unnest(array[p.role]||coalesce(p.secondary_roles,'{}'::text[])) r,
 lateral regexp_split_to_table(r,'\s*(/|\+|,|&|\mand\M)\s*') label
 where regexp_replace(lower(label),'[[:space:]_-]','','g') in ('engineer','engineers','engineering','chiefengineer','engineeringmanager','regionalmaintenance','regionalengineer','manager','generalmanager','gm','assistantmanager','assistantgeneralmanager','assistantgm'))
 into engineering from public.profiles p join public.hotel_members m on m.user_id=p.id
 where p.id=p_actor and p.active=true and m.active=true and m.hotel_id=p_hotel;
 if engineering is null then raise exception 'Active hotel membership required'; end if;
 if p_action in ('open','clear-manual') and not engineering then raise exception 'Engineering, General Manager or Assistant General Manager is required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 perform 1 from public.pool_facilities where hotel_id=p_hotel and id=p_facility and active=true for update;
 if not found then raise exception 'Active pool not found'; end if;
 before_state=public.cmpri_pool_reconcile(p_hotel,p_facility,false);
 if p_action in ('open','close') and (before_state->>'hours_closed')::boolean then raise exception 'Closed 10 PM–7 AM'; end if;
 request_body=jsonb_build_object('action',p_action,'reason',btrim(coalesce(p_reason,'')),'revision',p_revision);
 select * into prior from public.cmpri_pool_control_history where id=p_id;
 if found then
  if prior.hotel_id=p_hotel and prior.facility_id=p_facility and prior.actor_id=p_actor and prior.request=request_body then return public.cmpri_pool_snapshot(p_hotel,p_facility); end if;
  raise exception 'Action key already used for different details';
 end if;
 if (before_state->>'revision')::bigint<>p_revision then raise exception using errcode='40001',message='Pool status changed. Reload before saving.'; end if;
 select * into s from public.cmpri_pool_control where hotel_id=p_hotel and facility_id=p_facility for update;
 select * into l from public.pool_daily_logs where hotel_id=p_hotel and pool_facility_id=p_facility and log_date<=(public.cmpri_pool_clock() at time zone 'America/Chicago')::date order by log_date desc limit 1;
 if p_action='close' then
  if nullif(btrim(p_reason),'') is null or length(p_reason)>1000 then raise exception 'A closure reason is required (maximum 1000 characters)'; end if;
  update public.cmpri_pool_control set manual_closed=true,manual_reason=btrim(p_reason),reopen_pending=true,revision=revision+1 where hotel_id=p_hotel and facility_id=p_facility;
 elsif p_action='clear-manual' then
  if not (before_state->>'manual_closed')::boolean then raise exception 'No classified manual closure is active'; end if;
  update public.cmpri_pool_control set manual_closed=false,manual_reason='',reopen_pending=true,
   resolved_manual_log=case when l.manual_closure is true then l.id else resolved_manual_log end,
   resolved_manual_revision=case when l.manual_closure is true then l.revision else resolved_manual_revision end,revision=revision+1 where hotel_id=p_hotel and facility_id=p_facility;
 else
  if l.id is null or not public.cmpri_pool_test_passes(l)
   or (l.closure_condition is true and not (l.manual_closure is true and l.id=s.resolved_manual_log and l.revision=s.resolved_manual_revision)) then raise exception 'Closed pending pool testing or an unresolved testing-log closure'; end if;
  update public.cmpri_pool_control set manual_closed=false,manual_reason='',reopen_pending=false,revision=revision+1 where hotel_id=p_hotel and facility_id=p_facility;
 end if;
 previous_actor=coalesce(current_setting('cmpri.notification_actor',true),'');
 previous_hotel=coalesce(current_setting('cmpri.notification_hotel',true),'');
 perform set_config('cmpri.notification_actor',p_actor::text,true);
 perform set_config('cmpri.notification_hotel',p_hotel::text,true);
 result=public.cmpri_pool_reconcile(p_hotel,p_facility,p_action<>'clear-manual');
 perform set_config('cmpri.notification_actor',previous_actor,true);
 perform set_config('cmpri.notification_hotel',previous_hotel,true);
 insert into public.cmpri_pool_control_history(id,hotel_id,facility_id,actor_id,action,request,before_state,after_state)
 values(p_id,p_hotel,p_facility,p_actor,p_action,request_body,before_state,result);
 return result;
end $function$
;
CREATE OR REPLACE FUNCTION public.cmpri_pool_status_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare fresh_retest boolean; current_log uuid; last_control_action text; previous_actor text; previous_hotel text;
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
 previous_actor=coalesce(current_setting('cmpri.notification_actor',true),'');
 previous_hotel=coalesce(current_setting('cmpri.notification_hotel',true),'');
 perform set_config('cmpri.notification_actor',coalesce(new.updated_by,new.created_by)::text,true);
 perform set_config('cmpri.notification_hotel',new.hotel_id::text,true);
 perform public.cmpri_pool_reconcile(new.hotel_id,new.pool_facility_id,true);
 perform set_config('cmpri.notification_actor',previous_actor,true);
 perform set_config('cmpri.notification_hotel',previous_hotel,true);
 return new;
end $function$
;
-- Clear only previously materialized, provable self-events. Other recipients remain untouched.
update public.cmpri_dashboard_notifications n set actor_user_id=a.actor,read_at=coalesce(n.read_at,clock_timestamp()),cleared_at=coalesce(n.cleared_at,clock_timestamp()),push_requested=false
from (select id,cmpri_private.notification_event_actor(hotel_id,notification_key,work_order_id) actor from public.cmpri_dashboard_notifications where cleared_at is null) a
where n.id=a.id and a.actor=n.recipient_user_id;
update public.cmpri_web_push_deliveries d set status='suppressed',claimed_at=null
from public.cmpri_dashboard_notifications n where d.inbox_id=n.id and n.actor_user_id=n.recipient_user_id and n.cleared_at is not null and d.status in ('pending','failed','suppressed');
commit;
