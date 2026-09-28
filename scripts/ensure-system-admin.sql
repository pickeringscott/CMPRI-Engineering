-- Promote the two approved CMPRI system administrator accounts.
-- Run this in the Supabase SQL editor for the project that is serving CMPRI.

BEGIN;

DO $$
DECLARE
  target_hotel_id uuid := 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
  admin_email text;
  admin_id uuid;
  admin_name text;
BEGIN
  FOREACH admin_email IN ARRAY ARRAY['pickering.scott@gmail.com', 'maint.cmpri@hawkeyehotels.com'] LOOP
    SELECT au.id, COALESCE(au.raw_user_meta_data->>'full_name', au.raw_user_meta_data->>'name', admin_email)
      INTO admin_id, admin_name
    FROM auth.users au
    WHERE lower(au.email) = lower(admin_email)
    LIMIT 1;

    IF admin_id IS NULL THEN
      RAISE EXCEPTION 'No auth user found for %', admin_email;
    END IF;

    INSERT INTO public.profiles (id, email, full_name, role, active, property_scope)
    VALUES (admin_id, admin_email, admin_name, 'system_admin', true, 'assigned_property')
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
  END LOOP;
END $$;

COMMIT;

-- After running this, both accounts should be able to create users and manage access.
