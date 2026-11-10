-- A single authorized Open resolves manual holds only after a passing test.
-- Historical reading and control-audit rows remain unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
-- Stop rather than replace a function whose deployed behavior has diverged
-- from the last reviewed pool/notification migration.
do $preflight$ begin
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_proc where oid=to_regprocedure('public.cmpri_pool_action(uuid,uuid,uuid,uuid,text,text,bigint)')) is distinct from 'b75828b48dd769a8a161bcaa022102b6' then
  raise exception 'Pool action behavior changed; review before applying';
 end if;
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_proc where oid=to_regprocedure('public.cmpri_pool_status_changed()')) is distinct from 'a64764fb5cc6161eb1d5469e9be3214b' then
  raise exception 'Pool status trigger behavior changed; review before applying';
 end if;
 if (select md5(btrim(replace(prosrc,E'\r',''),E' \n\t')) from pg_proc where oid=to_regprocedure('public.cmpri_stamp_pool_log()')) is distinct from '575ab8ac390af9a2ea314caaabe75bc4' then
  raise exception 'Pool log stamp behavior changed; review before applying';
 end if;
end $preflight$;
CREATE OR REPLACE FUNCTION public.cmpri_pool_action(p_hotel uuid, p_facility uuid, p_actor uuid, p_id uuid, p_action text, p_reason text, p_revision bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare s public.cmpri_pool_control; l public.pool_daily_logs; before_state jsonb; result jsonb; prior public.cmpri_pool_control_history; request_body jsonb; engineering boolean; previous_actor text; previous_hotel text;
begin
 if p_id is null or p_actor is null or p_revision is null or p_action is null or p_action not in ('close','open','clear-manual') then raise exception 'Invalid pool action'; end if;
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
 else
  -- A confirmed passing current test is required before resolving any manual
  -- hold. An unclassified or non-manual log closure must not be overridden.
  if l.id is null or not public.cmpri_pool_test_passes(l)
   or (l.closure_condition is true and l.manual_closure is distinct from true) then
   raise exception 'Closed pending pool testing or an unresolved testing-log closure';
  end if;
  if p_action='clear-manual' and not (before_state->>'manual_closed')::boolean then
   raise exception 'No classified manual closure is active';
  end if;
  -- Keep the legacy Clear Manual endpoint migration-safe for older clients.
  -- It can only clear a classified hold after a safe test and never opens the pool.
  -- The current UI uses Open, which clears both holds in this one transaction.
  update public.cmpri_pool_control set manual_closed=false,manual_reason='',reopen_pending=(p_action='clear-manual'),
   resolved_manual_log=case when l.manual_closure is true then l.id else resolved_manual_log end,
   resolved_manual_revision=case when l.manual_closure is true then l.revision else resolved_manual_revision end,
   revision=revision+1 where hotel_id=p_hotel and facility_id=p_facility;
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
  -- Preserve a previously resolved manual hold across benign updates. A new
  -- closure reason or unsafe sample invalidates the resolution and closes the pool.
  if old.manual_closure is true and new.manual_closure is true
   and new.closure_reason is not distinct from old.closure_reason
   and public.cmpri_pool_test_passes(new) then
   update public.cmpri_pool_control set resolved_manual_revision=new.revision
    where hotel_id=new.hotel_id and facility_id=new.pool_facility_id
    and resolved_manual_log=old.id and resolved_manual_revision=old.revision;
  end if;
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
 elsif (new.closure_condition is true and not exists(
  select 1 from public.cmpri_pool_control where hotel_id=new.hotel_id and facility_id=new.pool_facility_id
  and resolved_manual_log=new.id and resolved_manual_revision=new.revision and new.manual_closure is true
  and public.cmpri_pool_test_passes(new))) or exists(
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


CREATE OR REPLACE FUNCTION public.cmpri_stamp_pool_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid := coalesce(auth.uid(), new.updated_by);
  actor_role text;
  is_system_admin boolean;
  can_edit_saved boolean;
  submitted_test boolean := false;
  reading_failure boolean;
  test_ph numeric;
  test_bromine numeric;
  test_band text;
  automatic_reason text;
BEGIN
  SELECT regexp_replace(lower(p.role), '[[:space:]_-]', '', 'g') INTO actor_role
  FROM public.profiles p
  JOIN public.hotel_members m ON m.user_id = p.id
  WHERE p.id = actor
    AND p.active = true
    AND m.active = true
    AND m.hotel_id = new.hotel_id;

  IF actor_role IS NULL OR actor_role NOT IN (
    'admin', 'administrator', 'systemadmin', 'systemadministrator', 'chiefengineer',
    'engineer', 'engineering', 'technician', 'maintenancetechnician', 'regionalmaintenance',
    'frontdeskmanager', 'manager', 'generalmanager', 'gm', 'assistantmanager',
    'assistantgeneralmanager', 'assistantgm'
  ) THEN
    RAISE EXCEPTION 'An active CMPRI engineering account is required';
  END IF;
  is_system_admin := actor_role IN ('admin', 'administrator', 'systemadmin', 'systemadministrator');

  can_edit_saved := is_system_admin OR actor_role IN ('manager', 'generalmanager', 'gm', 'assistantmanager', 'assistantgeneralmanager', 'assistantgm');

  IF TG_OP = 'UPDATE' AND NOT can_edit_saved THEN
    IF (old.ph_am IS NOT NULL AND new.ph_am IS DISTINCT FROM old.ph_am)
      OR (old.sanitizer_am IS NOT NULL AND new.sanitizer_am IS DISTINCT FROM old.sanitizer_am)
      OR (old.sanitizer_band_am IS NOT NULL AND new.sanitizer_band_am IS DISTINCT FROM old.sanitizer_band_am)
      OR (old.sample_location_am IS NOT NULL AND new.sample_location_am IS DISTINCT FROM old.sample_location_am)
      OR (old.ph_pm IS NOT NULL AND new.ph_pm IS DISTINCT FROM old.ph_pm)
      OR (old.sanitizer_pm IS NOT NULL AND new.sanitizer_pm IS DISTINCT FROM old.sanitizer_pm)
      OR (old.sanitizer_band_pm IS NOT NULL AND new.sanitizer_band_pm IS DISTINCT FROM old.sanitizer_band_pm)
      OR (old.sample_location_pm IS NOT NULL AND new.sample_location_pm IS DISTINCT FROM old.sample_location_pm)
      OR (old.flow_rate_gpm IS NOT NULL AND new.flow_rate_gpm IS DISTINCT FROM old.flow_rate_gpm)
      OR (old.temperature_f IS NOT NULL AND new.temperature_f IS DISTINCT FROM old.temperature_f)
      OR (old.main_drain_visible IS NOT NULL AND new.main_drain_visible IS DISTINCT FROM old.main_drain_visible)
      OR (old.filter_backwashed IS NOT NULL AND new.filter_backwashed IS DISTINCT FROM old.filter_backwashed)
      OR (old.manual_closure IS TRUE AND new.manual_closure IS DISTINCT FROM true)
      OR (old.requires_attention IS TRUE AND new.requires_attention IS DISTINCT FROM true)
      OR (nullif(old.closure_reason, '') IS NOT NULL AND left(coalesce(new.closure_reason, ''), length(old.closure_reason)) <> old.closure_reason)
      OR (nullif(old.remarks, '') IS NOT NULL AND left(coalesce(new.remarks, ''), length(old.remarks)) <> old.remarks) THEN
      RAISE EXCEPTION 'Only System Administrators, General Managers or Assistant General Managers can change saved pool readings';
    END IF;
  END IF;

  IF (new.ph_am IS NULL) <> (new.sanitizer_am IS NULL AND new.sanitizer_band_am IS NULL)
    OR (new.ph_pm IS NULL) <> (new.sanitizer_pm IS NULL AND new.sanitizer_band_pm IS NULL) THEN
    RAISE EXCEPTION 'Each AM/PM sample requires both pH and bromine';
  END IF;
  IF (new.sanitizer_am IS NOT NULL AND new.sanitizer_band_am IS NOT NULL)
    OR (new.sanitizer_pm IS NOT NULL AND new.sanitizer_band_pm IS NOT NULL) THEN
    RAISE EXCEPTION 'Use either a numeric bromine reading or a selected range, not both';
  END IF;
  -- New samples are shared; NULL on existing samples keeps unknown historical attribution.
  IF new.ph_am IS NOT NULL AND new.sample_location_am IS NULL
    AND (TG_OP = 'INSERT' OR old.ph_am IS NULL) THEN new.sample_location_am := 'shared'; END IF;
  IF new.ph_pm IS NOT NULL AND new.sample_location_pm IS NULL
    AND (TG_OP = 'INSERT' OR old.ph_pm IS NULL) THEN new.sample_location_pm := 'shared'; END IF;
  IF (new.sample_location_am = 'middle' AND (TG_OP = 'INSERT' OR old.sample_location_am IS DISTINCT FROM 'middle'))
    OR (new.sample_location_pm = 'middle' AND (TG_OP = 'INSERT' OR old.sample_location_pm IS DISTINCT FROM 'middle')) THEN
    RAISE EXCEPTION 'Sample location must be shallow or deep';
  END IF;
  IF new.main_drain_visible IS NULL OR new.filter_backwashed IS NULL
    OR new.temperature_f IS NULL OR new.flow_rate_gpm IS NULL THEN
    RAISE EXCEPTION 'Daily checks are required: water temperature, flow rate, main drain visibility and filter backwash status';
  END IF;
  IF new.ph_am IS NULL THEN new.sample_location_am := NULL; END IF;
  IF new.ph_pm IS NULL THEN new.sample_location_pm := NULL; END IF;

  -- Preserve historical location readings when this period is unchanged.
  IF TG_OP = 'UPDATE'
    AND new.ph_am IS NOT DISTINCT FROM old.ph_am
    AND new.sanitizer_am IS NOT DISTINCT FROM old.sanitizer_am
    AND new.sanitizer_band_am IS NOT DISTINCT FROM old.sanitizer_band_am
    AND new.sample_location_am IS NOT DISTINCT FROM old.sample_location_am THEN
    new.ph_shallow_am := old.ph_shallow_am;
    new.sanitizer_shallow_am := old.sanitizer_shallow_am;
    new.ph_deep_am := old.ph_deep_am;
    new.sanitizer_deep_am := old.sanitizer_deep_am;
    new.ph_middle_am := old.ph_middle_am;
    new.sanitizer_middle_am := old.sanitizer_middle_am;
  ELSE
    new.ph_shallow_am := new.ph_am;
    new.sanitizer_shallow_am := new.sanitizer_am;
    new.ph_deep_am := new.ph_am;
    new.sanitizer_deep_am := new.sanitizer_am;
    new.ph_middle_am := CASE WHEN new.sample_location_am = 'middle' THEN new.ph_am ELSE NULL END;
    new.sanitizer_middle_am := CASE WHEN new.sample_location_am = 'middle' THEN new.sanitizer_am ELSE NULL END;
  END IF;
  -- Preserve historical location readings when this period is unchanged.
  IF TG_OP = 'UPDATE'
    AND new.ph_pm IS NOT DISTINCT FROM old.ph_pm
    AND new.sanitizer_pm IS NOT DISTINCT FROM old.sanitizer_pm
    AND new.sanitizer_band_pm IS NOT DISTINCT FROM old.sanitizer_band_pm
    AND new.sample_location_pm IS NOT DISTINCT FROM old.sample_location_pm THEN
    new.ph_shallow_pm := old.ph_shallow_pm;
    new.sanitizer_shallow_pm := old.sanitizer_shallow_pm;
    new.ph_deep_pm := old.ph_deep_pm;
    new.sanitizer_deep_pm := old.sanitizer_deep_pm;
    new.ph_middle_pm := old.ph_middle_pm;
    new.sanitizer_middle_pm := old.sanitizer_middle_pm;
  ELSE
    new.ph_shallow_pm := new.ph_pm;
    new.sanitizer_shallow_pm := new.sanitizer_pm;
    new.ph_deep_pm := new.ph_pm;
    new.sanitizer_deep_pm := new.sanitizer_pm;
    new.ph_middle_pm := CASE WHEN new.sample_location_pm = 'middle' THEN new.ph_pm ELSE NULL END;
    new.sanitizer_middle_pm := CASE WHEN new.sample_location_pm = 'middle' THEN new.sanitizer_pm ELSE NULL END;
  END IF;

  -- Only initial AM/PM submissions and a new, explicitly identified retest are tests.
  -- Administrator corrections, remarks, and date navigation never become tests.
  IF TG_OP = 'UPDATE' THEN new.latest_test := old.latest_test;
  ELSE new.latest_test := NULL; END IF;
  IF new.latest_test->>'period' = 'am' THEN
    new.latest_test := new.latest_test || jsonb_build_object('ph',new.ph_am,'sanitizer',new.sanitizer_am,'sanitizer_band',new.sanitizer_band_am);
  ELSIF new.latest_test->>'period' = 'pm' THEN
    new.latest_test := new.latest_test || jsonb_build_object('ph',new.ph_pm,'sanitizer',new.sanitizer_pm,'sanitizer_band',new.sanitizer_band_pm);
  END IF;
  IF new.ph_am IS NOT NULL AND (TG_OP = 'INSERT' OR (old.ph_am IS NULL AND old.ph_shallow_am IS NULL AND old.ph_middle_am IS NULL AND old.ph_deep_am IS NULL))
    AND (TG_OP = 'INSERT' OR old.ph_pm IS NULL)
    AND coalesce(new.latest_test->>'period', '') <> 'retest' THEN
    new.latest_test := jsonb_build_object('period','am','ph',new.ph_am,
      'sanitizer',new.sanitizer_am,'sanitizer_band',new.sanitizer_band_am,
      'sample_location',new.sample_location_am);
    submitted_test := true;
  END IF;
  IF new.ph_pm IS NOT NULL AND (TG_OP = 'INSERT' OR (old.ph_pm IS NULL AND old.ph_shallow_pm IS NULL AND old.ph_middle_pm IS NULL AND old.ph_deep_pm IS NULL))
    AND coalesce(new.latest_test->>'period', '') <> 'retest' THEN
    new.latest_test := jsonb_build_object('period','pm','ph',new.ph_pm,
      'sanitizer',new.sanitizer_pm,'sanitizer_band',new.sanitizer_band_pm,
      'sample_location',new.sample_location_pm);
    submitted_test := true;
  END IF;

  IF new.retest_submission IS NOT NULL THEN
    IF jsonb_typeof(new.retest_submission) IS DISTINCT FROM 'object'
      OR coalesce(new.retest_submission->>'id','') !~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
      OR jsonb_typeof(new.retest_submission->'ph') IS DISTINCT FROM 'number'
      OR (new.retest_submission->>'ph')::numeric NOT BETWEEN 0 AND 14
      OR coalesce(new.retest_submission->>'sanitizer_band','') NOT IN ('0','1-2','2-4','3-6','5-10','7.5-15','10-20') THEN
      RAISE EXCEPTION 'A retest needs a UUID, valid pH and accepted bromine range';
    END IF;
    IF TG_OP = 'UPDATE' AND new.retest_submission->>'id' = old.retest_submission->>'id' THEN
      IF new.retest_submission IS DISTINCT FROM old.retest_submission THEN
        RAISE EXCEPTION 'Retest submission id already has different readings';
      END IF;
    ELSE
      IF EXISTS (SELECT 1 FROM public.cmpri_pool_log_history h WHERE h.pool_log_id = new.id
        AND h.snapshot->'retest_submission'->>'id' = new.retest_submission->>'id') THEN
        RAISE EXCEPTION 'Retest submission id was already recorded; reload the current log';
      END IF;
      new.latest_test := jsonb_build_object('period','retest','ph',(new.retest_submission->>'ph')::numeric,
        'sanitizer',NULL,'sanitizer_band',new.retest_submission->>'sanitizer_band','sample_location','shared');
      submitted_test := true;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN new.retest_submission := old.retest_submission;
  END IF;

  IF new.latest_test IS NULL THEN
    reading_failure := coalesce(new.ph_am < 7.2 OR new.ph_am > 7.8
    OR new.ph_pm < 7.2 OR new.ph_pm > 7.8
    OR new.sanitizer_band_am IN ('0', '1-2', '7.5-15', '10-20')
    OR new.sanitizer_band_pm IN ('0', '1-2', '7.5-15', '10-20')
    OR new.sanitizer_am <= 2 OR new.sanitizer_am >= 7.5
    OR new.sanitizer_pm <= 2 OR new.sanitizer_pm >= 7.5
    OR new.main_drain_visible IS FALSE
    OR new.temperature_f > 104, false);
  ELSE
    test_ph := (new.latest_test->>'ph')::numeric;
    test_bromine := (new.latest_test->>'sanitizer')::numeric;
    test_band := new.latest_test->>'sanitizer_band';
    reading_failure := coalesce(test_ph IS NULL OR (test_bromine IS NULL AND test_band IS NULL) OR test_ph < 7.2 OR test_ph > 7.8
      OR test_band IN ('0','1-2','7.5-15','10-20')
      OR test_bromine <= 2 OR test_bromine >= 7.5
      OR new.main_drain_visible IS FALSE OR new.temperature_f > 104, false);
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Explicit manual holds remain independent of chemistry. Backward-compatible writers
    -- that mark an otherwise passing new log closed are also recording a manual hold.
    new.manual_closure := coalesce(new.manual_closure, new.closure_condition IS TRUE AND NOT reading_failure);
  ELSIF old.manual_closure IS NULL AND old.closure_condition IS TRUE THEN
    -- Unknown legacy closure source stays unknown, unless an authorized pool-log editor explicitly
    -- classifies it. This never reopens by itself (submitted_test is still required).
    IF new.manual_closure IS FALSE AND NOT can_edit_saved THEN
      RAISE EXCEPTION 'Only System Administrators, General Managers or Assistant General Managers can classify a legacy closure source';
    END IF;
  ELSIF old.closure_condition IS NOT TRUE AND new.closure_condition IS TRUE AND NOT reading_failure THEN
    new.manual_closure := true;
  ELSE new.manual_closure := coalesce(new.manual_closure,old.manual_closure,false);
  END IF;
  new.closure_condition := reading_failure OR coalesce(new.manual_closure,true)
    OR (NOT submitted_test AND TG_OP = 'UPDATE' AND old.closure_condition IS TRUE);

  -- A new independent manual hold still requires a user-supplied reason.
  IF new.manual_closure IS TRUE AND (TG_OP = 'INSERT' OR old.manual_closure IS DISTINCT FROM true)
    AND nullif(btrim(new.closure_reason),'') IS NULL THEN
    RAISE EXCEPTION 'A reason is required for a manual pool closure';
  END IF;

  -- Unsafe test readings have a database-generated reason even when the user
  -- submits no narrative. Preserve previously recorded manual/automatic reasons.
  IF reading_failure THEN
    automatic_reason := coalesce(nullif(btrim(public.cmpri_pool_failure_reason(new)),''),
      'Pool testing is incomplete or outside safe limits.');
    IF nullif(btrim(new.closure_reason),'') IS NULL THEN
      new.closure_reason := automatic_reason;
    ELSIF position(automatic_reason in new.closure_reason) = 0 THEN
      new.closure_reason := new.closure_reason || E'\n' || automatic_reason;
    END IF;
  END IF;

  -- Reasons are historical evidence even after the current status becomes open.
  IF TG_OP = 'UPDATE' AND nullif(btrim(old.closure_reason),'') IS NOT NULL THEN
    IF nullif(btrim(new.closure_reason),'') IS NULL THEN new.closure_reason := old.closure_reason;
    ELSIF left(new.closure_reason,length(old.closure_reason)) <> old.closure_reason THEN
      new.closure_reason := old.closure_reason || E'\n' || new.closure_reason;
    END IF;
  END IF;

  new.closure_reason := nullif(btrim(new.closure_reason), '');
  IF new.closure_condition IS TRUE AND new.closure_reason IS NULL THEN
    RAISE EXCEPTION 'The pool must be closed: a reason is required whenever the pool is closed';
  END IF;

  new.updated_by := actor;
  new.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    new.revision := 1;
    new.created_by := coalesce(auth.uid(), new.created_by);
  ELSE
    new.revision := old.revision + 1;
    new.created_by := old.created_by;
  END IF;
  RETURN new;
END;
$$;
commit;
