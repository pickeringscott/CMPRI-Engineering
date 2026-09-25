ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{"language":"en","appearance":"dark","notifications":{"new_work_orders":true,"status_changes":true,"mentions":true}}'::jsonb;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS personal_ai_connected boolean NOT NULL DEFAULT false;
