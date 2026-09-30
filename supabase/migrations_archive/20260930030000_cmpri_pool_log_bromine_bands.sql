BEGIN;

ALTER TABLE public.pool_daily_logs
  ADD COLUMN IF NOT EXISTS sanitizer_band_am text,
  ADD COLUMN IF NOT EXISTS sanitizer_band_pm text,
  ADD COLUMN IF NOT EXISTS sample_location_am text,
  ADD COLUMN IF NOT EXISTS sample_location_pm text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pool_daily_logs_sanitizer_band_am_check') THEN
    ALTER TABLE public.pool_daily_logs
      ADD CONSTRAINT pool_daily_logs_sanitizer_band_am_check
      CHECK (sanitizer_band_am IS NULL OR sanitizer_band_am IN ('0', '1-2', '2-4', '3-6', '5-10', '7.5-15', '10-20'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pool_daily_logs_sanitizer_band_pm_check') THEN
    ALTER TABLE public.pool_daily_logs
      ADD CONSTRAINT pool_daily_logs_sanitizer_band_pm_check
      CHECK (sanitizer_band_pm IS NULL OR sanitizer_band_pm IN ('0', '1-2', '2-4', '3-6', '5-10', '7.5-15', '10-20'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pool_daily_logs_sample_location_am_check') THEN
    ALTER TABLE public.pool_daily_logs
      ADD CONSTRAINT pool_daily_logs_sample_location_am_check
      CHECK (sample_location_am IS NULL OR sample_location_am IN ('shallow', 'deep'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pool_daily_logs_sample_location_pm_check') THEN
    ALTER TABLE public.pool_daily_logs
      ADD CONSTRAINT pool_daily_logs_sample_location_pm_check
      CHECK (sample_location_pm IS NULL OR sample_location_pm IN ('shallow', 'deep'));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.cmpri_stamp_pool_log()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  actor uuid := coalesce(auth.uid(), new.updated_by);
  actor_role text;
BEGIN
  SELECT regexp_replace(lower(p.role),'[[:space:]_-]','','g') INTO actor_role
  FROM public.profiles p
  JOIN public.hotel_members m ON m.user_id=p.id
  WHERE p.id=actor AND p.active=true AND m.active=true AND m.hotel_id=new.hotel_id;

  IF actor_role IS NULL OR actor_role NOT IN
    ('admin','administrator','systemadmin','systemadministrator','chiefengineer',
     'engineer','engineering','technician','maintenancetechnician','regionalmaintenance',
     'generalmanager','gm','assistantmanager','assistantgeneralmanager','assistantgm') THEN
    RAISE EXCEPTION 'An active CMPRI engineering account is required';
  END IF;

  IF (new.ph_am IS NULL) <> (new.sanitizer_am IS NULL AND new.sanitizer_band_am IS NULL) THEN
    RAISE EXCEPTION 'AM sample requires both pH and bromine';
  END IF;
  IF (new.ph_pm IS NULL) <> (new.sanitizer_pm IS NULL AND new.sanitizer_band_pm IS NULL) THEN
    RAISE EXCEPTION 'PM sample requires both pH and bromine';
  END IF;
  IF new.sanitizer_am IS NOT NULL AND new.sanitizer_band_am IS NOT NULL THEN
    RAISE EXCEPTION 'AM sample cannot contain both numeric bromine and a selected range';
  END IF;
  IF new.sanitizer_pm IS NOT NULL AND new.sanitizer_band_pm IS NOT NULL THEN
    RAISE EXCEPTION 'PM sample cannot contain both numeric bromine and a selected range';
  END IF;
  IF new.ph_am IS NOT NULL AND new.sample_location_am IS NULL THEN
    RAISE EXCEPTION 'AM sample requires a shallow or deep location';
  END IF;
  IF new.ph_pm IS NOT NULL AND new.sample_location_pm IS NULL THEN
    RAISE EXCEPTION 'PM sample requires a shallow or deep location';
  END IF;
  IF new.ph_am IS NULL THEN new.sample_location_am := NULL; END IF;
  IF new.ph_pm IS NULL THEN new.sample_location_pm := NULL; END IF;

  new.ph_shallow_am := CASE WHEN new.sample_location_am = 'shallow' THEN new.ph_am ELSE NULL END;
  new.ph_deep_am := CASE WHEN new.sample_location_am = 'deep' THEN new.ph_am ELSE NULL END;
  new.sanitizer_shallow_am := CASE WHEN new.sample_location_am = 'shallow' THEN new.sanitizer_am ELSE NULL END;
  new.sanitizer_deep_am := CASE WHEN new.sample_location_am = 'deep' THEN new.sanitizer_am ELSE NULL END;
  new.ph_shallow_pm := CASE WHEN new.sample_location_pm = 'shallow' THEN new.ph_pm ELSE NULL END;
  new.ph_deep_pm := CASE WHEN new.sample_location_pm = 'deep' THEN new.ph_pm ELSE NULL END;
  new.sanitizer_shallow_pm := CASE WHEN new.sample_location_pm = 'shallow' THEN new.sanitizer_pm ELSE NULL END;
  new.sanitizer_deep_pm := CASE WHEN new.sample_location_pm = 'deep' THEN new.sanitizer_pm ELSE NULL END;

  IF new.ph_am < 7.2 OR new.ph_am > 7.8
    OR new.ph_pm < 7.2 OR new.ph_pm > 7.8
    OR new.sanitizer_band_am IN ('0', '1-2', '7.5-15', '10-20')
    OR new.sanitizer_band_pm IN ('0', '1-2', '7.5-15', '10-20')
    OR new.sanitizer_am <= 2 OR new.sanitizer_am >= 7.5
    OR new.sanitizer_pm <= 2 OR new.sanitizer_pm >= 7.5 THEN
    new.closure_condition := true;
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

COMMIT;
