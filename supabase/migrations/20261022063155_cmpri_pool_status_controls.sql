-- Unified status is a projection of real testing logs, independent manual holds and local hours.
-- No existing logs, stock, memberships or profile assignments are modified.
create table public.cmpri_pool_control (
 hotel_id uuid not null, facility_id uuid not null references public.pool_facilities(id),
 manual_closed boolean not null default false, manual_reason text not null default '',
 reopen_pending boolean not null default false, revision bigint not null default 0,
 resolved_manual_log uuid, resolved_manual_revision bigint,
 last_closed boolean, last_reason text, primary key(hotel_id,facility_id)
);
create table public.cmpri_pool_control_history (
 id uuid primary key, hotel_id uuid not null, facility_id uuid not null,
 actor_id uuid not null, action text not null, request jsonb not null,
 before_state jsonb not null, after_state jsonb not null, recorded_at timestamptz not null default now()
);
alter table public.cmpri_pool_control enable row level security;
alter table public.cmpri_pool_control_history enable row level security;
revoke all on public.cmpri_pool_control,public.cmpri_pool_control_history from anon,authenticated;
grant all on public.cmpri_pool_control,public.cmpri_pool_control_history to service_role;
create function public.cmpri_pool_clock() returns timestamptz language sql stable as $$select now()$$;
-- Same published numeric/range gates as cmpri_stamp_pool_log; no new chemical thresholds.
create function public.cmpri_pool_test_passes(l public.pool_daily_logs) returns boolean language sql immutable as $$
 select coalesce(l.latest_test is not null
 and (l.latest_test->>'ph')::numeric between 7.2 and 7.8
 and (case when l.latest_test->>'sanitizer_band' is not null then l.latest_test->>'sanitizer_band' in ('2-4','3-6','5-10')
 else (l.latest_test->>'sanitizer')::numeric>2 and (l.latest_test->>'sanitizer')::numeric<7.5 end)
 and l.main_drain_visible is true and l.temperature_f<=104,false)
$$;
create function public.cmpri_pool_failure_reason(l public.pool_daily_logs) returns text language plpgsql immutable as $$
declare sample jsonb; period text; ph numeric; bromine numeric; band text; reasons text[]='{}'; samples jsonb;
begin
 if l.latest_test is not null then samples=jsonb_build_array(l.latest_test);
 else samples=jsonb_build_array(jsonb_build_object('period','AM','ph',l.ph_am,'sanitizer',l.sanitizer_am,'sanitizer_band',l.sanitizer_band_am),jsonb_build_object('period','PM','ph',l.ph_pm,'sanitizer',l.sanitizer_pm,'sanitizer_band',l.sanitizer_band_pm)); end if;
 for sample in select value from jsonb_array_elements(samples) loop
  period=upper(sample->>'period');ph=(sample->>'ph')::numeric;bromine=(sample->>'sanitizer')::numeric;band=sample->>'sanitizer_band';
  if ph<7.2 or ph>7.8 then reasons=array_append(reasons,period||' pH '||ph::text||' is outside 7.2-7.8'); end if;
  if band in ('0','1-2','7.5-15','10-20') then reasons=array_append(reasons,period||' bromine '||band||' ppm is outside the safe range');
  elsif bromine<=2 or bromine>=7.5 then reasons=array_append(reasons,period||' bromine '||bromine::text||' ppm is outside 2-7.5 ppm'); end if;
 end loop;
 if l.main_drain_visible is false then reasons=array_append(reasons,'Main drain is not visible'); end if;
 if l.temperature_f>104 then reasons=array_append(reasons,'Water temperature '||l.temperature_f::text||'°F is above 104°F'); end if;
 return array_to_string(reasons,E'\n');
end $$;
create function public.cmpri_pool_snapshot(p_hotel uuid,p_facility uuid) returns jsonb
 language plpgsql security invoker set search_path=public,pg_temp as $$
declare s public.cmpri_pool_control; l public.pool_daily_logs; local_time timestamp; hours_closed boolean; log_closed boolean; missing boolean; why text; manual_resolved boolean;
begin
 local_time=public.cmpri_pool_clock() at time zone 'America/Chicago';
 hours_closed=local_time::time>=time '22:00' or local_time::time<time '07:00';
 select * into s from public.cmpri_pool_control where hotel_id=p_hotel and facility_id=p_facility;
 select * into l from public.pool_daily_logs where hotel_id=p_hotel and pool_facility_id=p_facility and log_date<=local_time::date order by log_date desc limit 1;
 missing=l.id is null or not public.cmpri_pool_test_passes(l);
 manual_resolved=l.id=s.resolved_manual_log and l.revision=s.resolved_manual_revision and l.manual_closure is true and public.cmpri_pool_test_passes(l);
 log_closed=coalesce(l.closure_condition,true) and not coalesce(manual_resolved,false);
 why=case when nullif(public.cmpri_pool_failure_reason(l),'') is not null then public.cmpri_pool_failure_reason(l)
 when coalesce(s.manual_closed,false) then s.manual_reason
 when log_closed and l.closure_condition is true then coalesce(nullif(l.closure_reason,''),'Closed pending pool testing.')
 when hours_closed then 'Closed 10 PM–7 AM'
 when missing then 'Closed pending pool testing.'
 when s.reopen_pending then 'Closed pending Engineering reopening.' else '' end;
 return jsonb_build_object('closed',hours_closed or missing or log_closed or coalesce(s.manual_closed,false) or coalesce(s.reopen_pending,false),
 'reason',why,'hours_closed',hours_closed,'manual_closed',coalesce(s.manual_closed,false) or (l.manual_closure is true and not coalesce(manual_resolved,false)),
 'revision',coalesce(s.revision,0),'log',case when l.id is null then null else to_jsonb(l) end,
 'manual_resolved',coalesce(manual_resolved,false),'manual_reason',s.manual_reason,'reopen_pending',coalesce(s.reopen_pending,false));
end $$;
create function public.cmpri_pool_reconcile(p_hotel uuid,p_facility uuid,p_new_event boolean default false) returns jsonb
 language plpgsql security invoker set search_path=public,pg_temp as $$
declare s public.cmpri_pool_control; result jsonb; event_key text; previous_closed boolean;
begin
 perform 1 from public.pool_facilities where hotel_id=p_hotel and id=p_facility and active=true for update;
 if not found then raise exception 'Active pool not found'; end if;
 insert into public.cmpri_pool_control(hotel_id,facility_id) values(p_hotel,p_facility) on conflict do nothing;
 select * into s from public.cmpri_pool_control where hotel_id=p_hotel and facility_id=p_facility for update;
 result=public.cmpri_pool_snapshot(p_hotel,p_facility);
 previous_closed=s.last_closed;
 if s.last_closed is distinct from (result->>'closed')::boolean or s.last_reason is distinct from result->>'reason' then
  update public.cmpri_pool_control set last_closed=(result->>'closed')::boolean,last_reason=result->>'reason',revision=revision+1 where hotel_id=p_hotel and facility_id=p_facility returning * into s;
  if (result->>'closed')::boolean and (s.last_closed is true) then
   -- Initial reads do not backfill notifications. Each actual transition/reason change is one event.
   if p_new_event or previous_closed is false then
    event_key='pool-closed:status:'||p_facility::text||':'||s.revision::text;
    insert into public.cmpri_dashboard_notifications(hotel_id,recipient_user_id,notification_key,work_order_id,target_path,message,recorded_at,push_requested)
     select p_hotel,p.id,event_key,null,'/pool','Pool closed: '||(result->>'reason'),public.cmpri_pool_clock(),false
     from public.profiles p join public.hotel_members m on m.user_id=p.id
     where p.active=true and m.active=true and m.hotel_id=p_hotel
     and exists(select 1 from unnest(array[p.role]||coalesce(p.secondary_roles,'{}'::text[])) r,
       lateral regexp_split_to_table(r,'\s*(/|\+|,|&|\mand\M)\s*') label
       where regexp_replace(lower(label),'[[:space:]_-]','','g') in ('engineer','engineers','engineering','chiefengineer','engineeringmanager','regionalmaintenance','regionalengineer','technician','maintenancetechnician','maintenance','manager','generalmanager','gm','assistantmanager','assistantgeneralmanager','assistantgm','frontdeskmanager','frontdesk','frontdeskagent'))
     on conflict(hotel_id,recipient_user_id,notification_key) do nothing;
   end if;
  end if;
 end if;
 return public.cmpri_pool_snapshot(p_hotel,p_facility);
end $$;
create function public.cmpri_pool_action(p_hotel uuid,p_facility uuid,p_actor uuid,p_id uuid,p_action text,p_reason text,p_revision bigint) returns jsonb
 language plpgsql security invoker set search_path=public,pg_temp as $$
declare s public.cmpri_pool_control; l public.pool_daily_logs; before_state jsonb; result jsonb; prior public.cmpri_pool_control_history; request_body jsonb; engineering boolean;
begin
 if p_id is null or p_actor is null or p_revision is null or p_action not in ('close','open','clear-manual') then raise exception 'Invalid pool action'; end if;
 select exists(select 1 from unnest(array[p.role]||coalesce(p.secondary_roles,'{}'::text[])) r,
 lateral regexp_split_to_table(r,'\s*(/|\+|,|&|\mand\M)\s*') label
 where regexp_replace(lower(label),'[[:space:]_-]','','g') in ('engineer','engineers','engineering','chiefengineer','engineeringmanager','regionalmaintenance','regionalengineer'))
 into engineering from public.profiles p join public.hotel_members m on m.user_id=p.id
 where p.id=p_actor and p.active=true and m.active=true and m.hotel_id=p_hotel;
 if engineering is null then raise exception 'Active hotel membership required'; end if;
 if p_action in ('open','clear-manual') and not engineering then raise exception 'Engineering is required'; end if;
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
 result=public.cmpri_pool_reconcile(p_hotel,p_facility,p_action<>'clear-manual');
 insert into public.cmpri_pool_control_history(id,hotel_id,facility_id,actor_id,action,request,before_state,after_state)
 values(p_id,p_hotel,p_facility,p_actor,p_action,request_body,before_state,result);
 return result;
end $$;
-- Serialize test writes against manual actions, then reconcile in the same transaction.
create function public.cmpri_pool_status_lock() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin perform 1 from public.pool_facilities where id=new.pool_facility_id and hotel_id=new.hotel_id for update; return new; end $$;
create trigger aa_cmpri_pool_status_lock before insert or update on public.pool_daily_logs for each row execute function public.cmpri_pool_status_lock();
create function public.cmpri_pool_status_changed() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.closure_condition is true or exists(select 1 from public.cmpri_pool_control where hotel_id=new.hotel_id and facility_id=new.pool_facility_id and last_closed=true and last_reason is distinct from 'Closed 10 PM–7 AM') then
  insert into public.cmpri_pool_control(hotel_id,facility_id,reopen_pending) values(new.hotel_id,new.pool_facility_id,true)
  on conflict(hotel_id,facility_id) do update set reopen_pending=true;
 end if;
 perform public.cmpri_pool_reconcile(new.hotel_id,new.pool_facility_id,true); return new;
end $$;
create trigger zz_cmpri_pool_status_changed after insert or update on public.pool_daily_logs for each row execute function public.cmpri_pool_status_changed();
revoke all on function public.cmpri_pool_clock(),public.cmpri_pool_test_passes(public.pool_daily_logs),public.cmpri_pool_snapshot(uuid,uuid),public.cmpri_pool_reconcile(uuid,uuid,boolean),public.cmpri_pool_action(uuid,uuid,uuid,uuid,text,text,bigint),public.cmpri_pool_status_lock(),public.cmpri_pool_status_changed() from public,anon,authenticated;
grant execute on function public.cmpri_pool_clock(),public.cmpri_pool_test_passes(public.pool_daily_logs),public.cmpri_pool_snapshot(uuid,uuid),public.cmpri_pool_reconcile(uuid,uuid,boolean),public.cmpri_pool_action(uuid,uuid,uuid,uuid,text,text,bigint) to service_role;

revoke all on function public.cmpri_pool_failure_reason(public.pool_daily_logs) from public,anon,authenticated;
grant execute on function public.cmpri_pool_failure_reason(public.pool_daily_logs) to service_role;
