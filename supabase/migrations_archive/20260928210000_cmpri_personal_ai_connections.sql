ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS personal_ai_provider text,
  ADD COLUMN IF NOT EXISTS personal_ai_model text,
  ADD COLUMN IF NOT EXISTS personal_ai_api_key_encrypted text,
  ADD COLUMN IF NOT EXISTS personal_ai_status text NOT NULL DEFAULT 'disconnected',
  ADD COLUMN IF NOT EXISTS personal_ai_last_tested_at timestamptz,
  ADD COLUMN IF NOT EXISTS personal_ai_error text;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_personal_ai_status_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_personal_ai_status_check
  CHECK (personal_ai_status IN ('active', 'disconnected', 'error'));

UPDATE public.profiles
SET personal_ai_status = 'error',
    personal_ai_error = 'Reconnect OpenAI with your personal API key.'
WHERE personal_ai_connected = true
  AND personal_ai_api_key_encrypted IS NULL
  AND personal_ai_status = 'disconnected';
