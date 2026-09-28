ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS manage_profile_first_login_complete boolean NOT NULL DEFAULT true;
