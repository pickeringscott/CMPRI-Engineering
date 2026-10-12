-- One-time, explicitly approved policy reconciliation. No new sample is submitted.
-- Execute only after the retest policy migration and application deployment.
BEGIN;
DO $guard$
DECLARE current_log jsonb; evidence jsonb;
BEGIN
  SELECT to_jsonb(p) INTO STRICT current_log FROM public.pool_daily_logs p
    WHERE id='eb3437c4-6edc-493c-93c8-76714dec6355' FOR UPDATE;
  SELECT snapshot INTO STRICT evidence FROM public.cmpri_pool_log_history
    WHERE id='a9ee3285-6a8f-4212-91cd-548f535d8b5f'
      AND pool_log_id='eb3437c4-6edc-493c-93c8-76714dec6355' AND hotel_id='c81ad01a-7a9f-4880-ac1c-5e849f30bad6'
      AND actor_id='750f77bf-7d5d-4ca6-8421-e025edea87ba'
      AND recorded_at='2026-10-12T20:00:54.910027Z';
  IF evidence IS DISTINCT FROM '{"id":"eb3437c4-6edc-493c-93c8-76714dec6355","ph_am":7.6,"ph_pm":7.4,"remarks":"","hotel_id":"c81ad01a-7a9f-4880-ac1c-5e849f30bad6","log_date":"2026-10-12","revision":2,"created_at":"2026-10-12T16:48:58.264699+00:00","created_by":"750f77bf-7d5d-4ca6-8421-e025edea87ba","ph_deep_am":7.6,"ph_deep_pm":7.4,"updated_at":"2026-10-12T20:00:54.910027+00:00","updated_by":"750f77bf-7d5d-4ca6-8421-e025edea87ba","ph_middle_am":null,"ph_middle_pm":null,"sanitizer_am":0,"sanitizer_pm":null,"flow_rate_gpm":55,"ph_shallow_am":7.6,"ph_shallow_pm":7.4,"temperature_f":84,"closure_reason":"Bromine 0 ppm; pool closed pending sanitizer restoration and retest.","pool_facility_id":"d4f10bdd-880f-4b92-b5ee-62bdcc017c77","closure_condition":true,"cyanuric_acid_ppm":null,"filter_backwashed":false,"sanitizer_band_am":null,"sanitizer_band_pm":"3-6","sanitizer_deep_am":0,"sanitizer_deep_pm":null,"main_drain_visible":true,"requires_attention":false,"sample_location_am":"shallow","sample_location_pm":"shared","sanitizer_middle_am":null,"sanitizer_middle_pm":null,"linked_work_order_id":null,"sanitizer_shallow_am":0,"sanitizer_shallow_pm":null,"combined_chlorine_ppm":null,"completed_by_initials":"SPCE-C"}'::jsonb
    OR current_log - ARRAY['latest_test','retest_submission','manual_closure'] IS DISTINCT FROM evidence
    OR current_log->'latest_test' IS DISTINCT FROM 'null'::jsonb
    OR current_log->'retest_submission' IS DISTINCT FROM 'null'::jsonb
    OR current_log->'manual_closure' IS DISTINCT FROM 'null'::jsonb
    OR (SELECT count(*) FROM public.cmpri_pool_log_history WHERE pool_log_id='eb3437c4-6edc-493c-93c8-76714dec6355') <> 2
    OR NOT EXISTS (SELECT 1 FROM public.cmpri_pool_log_history
      WHERE id='f22c0708-f51e-40f1-b74b-9cc1af8f2f66' AND pool_log_id='eb3437c4-6edc-493c-93c8-76714dec6355'
        AND snapshot->>'revision'='1' AND snapshot->>'closure_reason'=evidence->>'closure_reason')
    OR NOT EXISTS (SELECT 1 FROM public.profiles p JOIN public.hotel_members m ON m.user_id=p.id
      WHERE p.id='750f77bf-7d5d-4ca6-8421-e025edea87ba' AND p.active AND m.active
        AND m.hotel_id='c81ad01a-7a9f-4880-ac1c-5e849f30bad6' AND p.role='system_admin')
  THEN RAISE EXCEPTION 'Reconciliation preconditions changed; no pool status was changed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.pool_daily_logs'::regclass
      AND tgname='cmpri_pool_log_stamp' AND tgenabled='O')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.pool_daily_logs'::regclass
      AND tgname='cmpri_pool_log_audit' AND tgenabled='O')
  THEN RAISE EXCEPTION 'Normal pool validation and audit must remain enabled'; END IF;
END;
$guard$;

-- This transaction-local helper runs after normal validation/stamping and before
-- the unchanged audit trigger. It is removed before commit and affects one exact row.
CREATE FUNCTION public.cmpri_reconcile_20261012_pm_once() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $one_row$
BEGIN
  IF OLD.id <> 'eb3437c4-6edc-493c-93c8-76714dec6355'::uuid THEN RETURN NEW; END IF;
  IF OLD.revision <> 2 OR NEW.revision <> 3 OR NEW.updated_by <> '750f77bf-7d5d-4ca6-8421-e025edea87ba'::uuid
    OR NEW.manual_closure IS DISTINCT FROM false
    OR to_jsonb(NEW) - ARRAY['revision','updated_at','manual_closure']
       IS DISTINCT FROM to_jsonb(OLD) - ARRAY['revision','updated_at','manual_closure']
    OR NEW.ph_pm IS DISTINCT FROM 7.4 OR NEW.sanitizer_band_pm IS DISTINCT FROM '3-6'
    OR NEW.main_drain_visible IS DISTINCT FROM true OR NEW.temperature_f IS DISTINCT FROM 84
    OR NEW.flow_rate_gpm IS DISTINCT FROM 55 OR NEW.filter_backwashed IS DISTINCT FROM false
  THEN RAISE EXCEPTION 'Only the approved unchanged PM evidence can be reconciled'; END IF;
  NEW.latest_test := jsonb_build_object(
    'period','pm','ph',NEW.ph_pm,'sanitizer',NEW.sanitizer_pm,
    'sanitizer_band',NEW.sanitizer_band_pm,'sample_location',NEW.sample_location_pm,
    'recorded_at','2026-10-12T20:00:54.910027Z',
    'source_history_id','a9ee3285-6a8f-4212-91cd-548f535d8b5f',
    'policy_reconciliation',jsonb_build_object(
      'reason','Owner-approved reconciliation of existing PM evidence; no new measurement',
      'performed_at',now(),'actor_id',NEW.updated_by));
  NEW.closure_condition := false;
  RETURN NEW;
END;
$one_row$;
CREATE TRIGGER zzz_cmpri_reconcile_20261012_pm_once
  BEFORE UPDATE ON public.pool_daily_logs
  FOR EACH ROW EXECUTE FUNCTION public.cmpri_reconcile_20261012_pm_once();

UPDATE public.pool_daily_logs SET manual_closure=false, updated_by='750f77bf-7d5d-4ca6-8421-e025edea87ba'
WHERE id='eb3437c4-6edc-493c-93c8-76714dec6355' AND hotel_id='c81ad01a-7a9f-4880-ac1c-5e849f30bad6' AND revision=2;

DROP TRIGGER zzz_cmpri_reconcile_20261012_pm_once ON public.pool_daily_logs;
DROP FUNCTION public.cmpri_reconcile_20261012_pm_once();

DO $verify$
DECLARE current_log jsonb; evidence jsonb;
BEGIN
  SELECT to_jsonb(p) INTO STRICT current_log FROM public.pool_daily_logs p WHERE id='eb3437c4-6edc-493c-93c8-76714dec6355';
  SELECT snapshot INTO STRICT evidence FROM public.cmpri_pool_log_history WHERE id='a9ee3285-6a8f-4212-91cd-548f535d8b5f';
  IF current_log->>'revision' <> '3' OR current_log->'closure_condition' IS DISTINCT FROM 'false'::jsonb
    OR current_log - ARRAY['revision','updated_at','closure_condition','manual_closure','latest_test','retest_submission']
       IS DISTINCT FROM evidence - ARRAY['revision','updated_at','closure_condition']
    OR current_log->'retest_submission' IS DISTINCT FROM 'null'::jsonb
    OR (SELECT count(*) FROM public.cmpri_pool_log_history WHERE pool_log_id='eb3437c4-6edc-493c-93c8-76714dec6355') <> 3
    OR NOT EXISTS (SELECT 1 FROM public.cmpri_pool_log_history WHERE pool_log_id='eb3437c4-6edc-493c-93c8-76714dec6355'
      AND snapshot=current_log AND actor_id='750f77bf-7d5d-4ca6-8421-e025edea87ba')
  THEN RAISE EXCEPTION 'Reconciliation verification failed; transaction rolled back'; END IF;
END;
$verify$;
COMMIT;

