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
      OR (old.closure_condition IS TRUE AND new.closure_condition IS DISTINCT FROM true)
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
  IF (new.ph_am IS NOT NULL AND new.sample_location_am IS NULL)
    OR (new.ph_pm IS NOT NULL AND new.sample_location_pm IS NULL) THEN
    RAISE EXCEPTION 'Each sample requires a shallow or deep sample location';
  END IF;
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

  new.ph_shallow_am := new.ph_am;
  new.ph_deep_am := new.ph_am;
  new.sanitizer_shallow_am := new.sanitizer_am;
  new.sanitizer_deep_am := new.sanitizer_am;
  new.ph_shallow_pm := new.ph_pm;
  new.ph_deep_pm := new.ph_pm;
  new.sanitizer_shallow_pm := new.sanitizer_pm;
  new.sanitizer_deep_pm := new.sanitizer_pm;
  new.ph_middle_am := CASE WHEN new.sample_location_am = 'middle' THEN new.ph_am ELSE NULL END;
  new.sanitizer_middle_am := CASE WHEN new.sample_location_am = 'middle' THEN new.sanitizer_am ELSE NULL END;
  new.ph_middle_pm := CASE WHEN new.sample_location_pm = 'middle' THEN new.ph_pm ELSE NULL END;
  new.sanitizer_middle_pm := CASE WHEN new.sample_location_pm = 'middle' THEN new.sanitizer_pm ELSE NULL END;

  IF new.ph_am < 7.2 OR new.ph_am > 7.8
    OR new.ph_pm < 7.2 OR new.ph_pm > 7.8
    OR new.sanitizer_band_am IN ('0', '1-2', '7.5-15', '10-20')
    OR new.sanitizer_band_pm IN ('0', '1-2', '7.5-15', '10-20')
    OR new.sanitizer_am <= 2 OR new.sanitizer_am >= 7.5
    OR new.sanitizer_pm <= 2 OR new.sanitizer_pm >= 7.5
    OR new.main_drain_visible IS FALSE
    OR new.temperature_f > 104 THEN
    new.closure_condition := true;
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
