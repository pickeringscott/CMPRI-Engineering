-- Temporary go-live deactivation for the system admin account.
-- This keeps the historical records intact while removing access.

BEGIN;

UPDATE public.profiles
SET active = false
WHERE lower(email) = lower('pickering.scott@gmail.com');

UPDATE public.hotel_members
SET active = false
WHERE user_id = (
  SELECT id FROM public.profiles WHERE lower(email) = lower('pickering.scott@gmail.com') LIMIT 1
)
  AND hotel_id = 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6';

COMMIT;

-- Reactivate later with:
-- UPDATE public.profiles SET active = true WHERE lower(email) = lower('pickering.scott@gmail.com');
-- UPDATE public.hotel_members SET active = true WHERE user_id = (SELECT id FROM public.profiles WHERE lower(email) = lower('pickering.scott@gmail.com') LIMIT 1);
