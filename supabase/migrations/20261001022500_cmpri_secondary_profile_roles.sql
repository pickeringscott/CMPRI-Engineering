ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS secondary_roles text[] NOT NULL DEFAULT ARRAY[]::text[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND conname = 'profiles_secondary_roles_check'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_secondary_roles_check
      CHECK (secondary_roles <@ ARRAY[
        'engineer',
        'manager',
        'senior_management',
        'technician',
        'front_desk',
        'front_desk_manager',
        'housekeeping'
      ]::text[]);
  END IF;
END $$;

DO $$
DECLARE
  target_user_id uuid;
BEGIN
  SELECT id
    INTO target_user_id
  FROM auth.users
  WHERE lower(email) = lower('maint.cmpri@hawkeyehotels.com')
  LIMIT 1;

  IF target_user_id IS NULL THEN
    RAISE NOTICE 'Skipping account-specific role assignment because the target auth user is not present';
    RETURN;
  END IF;

  UPDATE public.profiles
  SET role = 'system_admin',
      active = true,
      secondary_roles = CASE
        WHEN 'engineer' = ANY(secondary_roles) THEN secondary_roles
        ELSE secondary_roles || ARRAY['engineer']::text[]
      END
  WHERE id = target_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for maint.cmpri@hawkeyehotels.com';
  END IF;

  INSERT INTO public.hotel_members (hotel_id, user_id, role, active)
  VALUES ('c81ad01a-7a9f-4880-ac1c-5e849f30bad6', target_user_id, 'admin', true)
  ON CONFLICT (hotel_id, user_id) DO UPDATE
    SET role = 'admin',
        active = true;
END $$;
