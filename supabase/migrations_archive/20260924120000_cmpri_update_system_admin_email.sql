/* Promote the existing Google account to CMPRI system administrator. */
ALTER TABLE public.hotel_members
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
DECLARE
  old_admin_id uuid;
  google_user_id uuid;
  google_name text;
BEGIN
  SELECT id INTO old_admin_id
  FROM public.profiles
  WHERE role = 'system_admin'
  ORDER BY id
  LIMIT 1;

  IF old_admin_id IS NULL THEN
    RAISE EXCEPTION 'No existing system_admin profile was found';
  END IF;

  SELECT id, COALESCE(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', 'Scott Pickering')
  INTO google_user_id, google_name
  FROM auth.users
  WHERE lower(email) = lower('pickering.scott@gmail.com')
  LIMIT 1;

  IF google_user_id IS NULL THEN
    RAISE EXCEPTION 'The Google auth user pickering.scott@gmail.com does not exist';
  END IF;

  IF google_user_id = old_admin_id THEN
    UPDATE public.profiles
    SET email = 'pickering.scott@gmail.com', active = true
    WHERE id = old_admin_id;
  ELSE
    INSERT INTO public.profiles (id, email, full_name, role, active, property_scope)
    VALUES (google_user_id, 'pickering.scott@gmail.com', google_name, 'system_admin', true, 'assigned_property')
    ON CONFLICT (id) DO UPDATE
      SET email = excluded.email,
          role = 'system_admin',
          active = true;

    INSERT INTO public.hotel_members (hotel_id, user_id, role, active)
    VALUES ('c81ad01a-7a9f-4880-ac1c-5e849f30bad6', google_user_id, 'admin', true)
    ON CONFLICT (hotel_id, user_id) DO UPDATE
      SET role = 'admin', active = true;

    UPDATE public.profiles SET active = false WHERE id = old_admin_id;
    UPDATE public.hotel_members
    SET active = false
    WHERE hotel_id = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'
      AND user_id = old_admin_id;
  END IF;
END $$;
