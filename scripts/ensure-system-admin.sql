-- Promote the CMPRI system administrator account to the live Google identity.
-- Run this in the Supabase SQL editor for the project that is serving CMPRI.

BEGIN;

DO $$
DECLARE
  target_hotel_id uuid := 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
  admin_id uuid;
  admin_name text;
BEGIN
  SELECT au.id, COALESCE(au.raw_user_meta_data->>'full_name', au.raw_user_meta_data->>'name', 'Scott Pickering')
    INTO admin_id, admin_name
  FROM auth.users au
  WHERE lower(au.email) = lower('pickering.scott@gmail.com')
  LIMIT 1;

  IF admin_id IS NULL THEN
    RAISE EXCEPTION 'No auth user found for pickering.scott@gmail.com';
  END IF;

  INSERT INTO public.profiles (id, email, full_name, role, active, property_scope)
  VALUES (admin_id, 'pickering.scott@gmail.com', admin_name, 'system_admin', true, 'assigned_property')
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email,
        full_name = EXCLUDED.full_name,
        role = 'system_admin',
        active = true,
        property_scope = EXCLUDED.property_scope;

  INSERT INTO public.hotel_members (hotel_id, user_id, role, active)
  VALUES (target_hotel_id, admin_id, 'admin', true)
  ON CONFLICT (hotel_id, user_id) DO UPDATE
    SET role = 'admin',
        active = true;

  UPDATE public.profiles
  SET active = false
  WHERE id <> admin_id
    AND role = 'system_admin';

  UPDATE public.hotel_members
  SET active = false
  WHERE hotel_id = target_hotel_id
    AND user_id <> admin_id
    AND role = 'admin';
END $$;

COMMIT;

-- After running this, the account should be able to create users and manage access.
