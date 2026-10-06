ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS model_family text;
