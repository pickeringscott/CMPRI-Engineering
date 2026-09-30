-- Add all pool log columns expected by CMPRI source
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS ph_shallow_am numeric;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS ph_deep_am numeric;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS ph_shallow_pm numeric;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS ph_deep_pm numeric;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS sanitizer_shallow_am numeric;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS sanitizer_deep_am numeric;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS sanitizer_shallow_pm numeric;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS sanitizer_deep_pm numeric;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS flow_rate_gpm numeric;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS temperature_f numeric;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS combined_chlorine_ppm numeric;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS cyanuric_acid_ppm numeric;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS main_drain_visible boolean;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS filter_backwashed boolean;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS requires_attention boolean;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS closure_condition boolean;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS remarks text;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS completed_by_initials text;
ALTER TABLE public.pool_daily_logs ADD COLUMN IF NOT EXISTS pool_facility_id uuid;

-- Add missing columns to pool_facilities
ALTER TABLE public.pool_facilities ADD COLUMN IF NOT EXISTS facility_name text;
ALTER TABLE public.pool_facilities ADD COLUMN IF NOT EXISTS pool_name text;
ALTER TABLE public.pool_facilities ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE public.pool_facilities ADD COLUMN IF NOT EXISTS sanitizer text DEFAULT 'Bromine';
ALTER TABLE public.pool_facilities ADD COLUMN IF NOT EXISTS active boolean DEFAULT true;

-- Create unique index for pool daily log
CREATE UNIQUE INDEX IF NOT EXISTS cmpri_pool_daily_log_unique
  ON public.pool_daily_logs(hotel_id, pool_facility_id, log_date);

-- Create pool log history table if not exists
CREATE TABLE IF NOT EXISTS public.cmpri_pool_log_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_log_id uuid NOT NULL REFERENCES public.pool_daily_logs(id) ON DELETE CASCADE,
  hotel_id uuid NOT NULL,
  actor_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL
);
ALTER TABLE public.cmpri_pool_log_history ENABLE ROW LEVEL SECURITY;

-- Create pool log triggers
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

DROP TRIGGER IF EXISTS cmpri_pool_log_stamp ON public.pool_daily_logs;
CREATE TRIGGER cmpri_pool_log_stamp BEFORE INSERT OR UPDATE ON public.pool_daily_logs
FOR EACH ROW EXECUTE FUNCTION public.cmpri_stamp_pool_log();

CREATE OR REPLACE FUNCTION public.cmpri_audit_pool_log()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.cmpri_pool_log_history(pool_log_id, hotel_id, actor_id, snapshot)
  VALUES(new.id, new.hotel_id, new.updated_by, to_jsonb(new));
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS cmpri_pool_log_audit ON public.pool_daily_logs;
CREATE TRIGGER cmpri_pool_log_audit AFTER INSERT OR UPDATE ON public.pool_daily_logs
FOR EACH ROW EXECUTE FUNCTION public.cmpri_audit_pool_log();