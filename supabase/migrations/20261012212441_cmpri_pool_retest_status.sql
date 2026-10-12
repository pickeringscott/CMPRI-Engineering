-- Current daily-log status follows new complete tests. No log rows are backfilled.
-- NULL manual_closure on legacy closed logs means unclassified, not permission to reopen.
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS latest_test jsonb;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS retest_submission jsonb;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS manual_closure boolean;
COMMENT ON COLUMN public.pool_daily_logs.latest_test IS 'Database-derived snapshot of the latest submitted test; corrections are not tests.';
COMMENT ON COLUMN public.pool_daily_logs.retest_submission IS 'Explicit shared retest UUID and paired results. Earlier retests remain in immutable audit snapshots.';
COMMENT ON COLUMN public.pool_daily_logs.manual_closure IS 'Independent manual hold. NULL on a legacy closed log requires source classification; a passing test clears only automatic reading closures.';

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
  submitted_test boolean := false;
  reading_failure boolean;
  test_ph numeric;
  test_bromine numeric;
  test_band text;
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
    'frontdeskmanager', 'generalmanager', 'gm', 'assistantmanager',
    'assistantgeneralmanager', 'assistantgm'
  ) THEN
    RAISE EXCEPTION 'An active CMPRI engineering account is required';
  END IF;
  is_system_admin := actor_role IN ('admin', 'administrator', 'systemadmin', 'systemadministrator');

  IF TG_OP = 'UPDATE' AND NOT is_system_admin THEN
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
      RAISE EXCEPTION 'Only System Administrators can change saved pool readings';
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
    -- Unknown legacy closure source stays unknown, unless an administrator explicitly
    -- classifies it. This never reopens by itself (submitted_test is still required).
    IF new.manual_closure IS FALSE AND NOT is_system_admin THEN
      RAISE EXCEPTION 'Only System Administrators can classify a legacy closure source';
    END IF;
  ELSIF old.closure_condition IS NOT TRUE AND new.closure_condition IS TRUE AND NOT reading_failure THEN
    new.manual_closure := true;
  ELSE new.manual_closure := coalesce(new.manual_closure,old.manual_closure,false);
  END IF;
  new.closure_condition := reading_failure OR coalesce(new.manual_closure,true)
    OR (NOT submitted_test AND TG_OP = 'UPDATE' AND old.closure_condition IS TRUE);

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
