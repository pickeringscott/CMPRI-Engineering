CREATE TABLE IF NOT EXISTS public.cmpri_mcp_oauth_clients (
  client_id text PRIMARY KEY,
  client_name text NOT NULL,
  redirect_uris jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cmpri_mcp_oauth_clients_redirect_uris_array
    CHECK (jsonb_typeof(redirect_uris) = 'array')
);

CREATE TABLE IF NOT EXISTS public.cmpri_mcp_oauth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES public.cmpri_mcp_oauth_clients(client_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  code_challenge text NOT NULL,
  scope text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cmpri_mcp_oauth_codes_expiry_idx
  ON public.cmpri_mcp_oauth_codes (expires_at);

CREATE TABLE IF NOT EXISTS public.cmpri_mcp_oauth_tokens (
  token_hash text PRIMARY KEY,
  token_family_id uuid NOT NULL,
  client_id text NOT NULL REFERENCES public.cmpri_mcp_oauth_clients(client_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  resource text NOT NULL,
  token_type text NOT NULL CHECK (token_type IN ('access_token', 'refresh_token')),
  scope text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cmpri_mcp_oauth_tokens_user_active_idx
  ON public.cmpri_mcp_oauth_tokens (user_id, token_type, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS cmpri_mcp_oauth_tokens_family_idx
  ON public.cmpri_mcp_oauth_tokens (token_family_id)
  WHERE revoked_at IS NULL;

ALTER TABLE public.cmpri_mcp_oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cmpri_mcp_oauth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cmpri_mcp_oauth_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.cmpri_mcp_oauth_clients FROM anon, authenticated;
REVOKE ALL ON public.cmpri_mcp_oauth_codes FROM anon, authenticated;
REVOKE ALL ON public.cmpri_mcp_oauth_tokens FROM anon, authenticated;
GRANT ALL ON public.cmpri_mcp_oauth_clients TO service_role;
GRANT ALL ON public.cmpri_mcp_oauth_codes TO service_role;
GRANT ALL ON public.cmpri_mcp_oauth_tokens TO service_role;

UPDATE public.profiles
SET personal_ai_connected = false,
    personal_ai_provider = NULL,
    personal_ai_model = NULL,
    personal_ai_api_key_encrypted = NULL,
    personal_ai_status = 'disconnected',
    personal_ai_last_tested_at = NULL,
    personal_ai_error = NULL
WHERE personal_ai_connected = true
   OR personal_ai_api_key_encrypted IS NOT NULL
   OR personal_ai_provider IS NOT NULL
   OR personal_ai_model IS NOT NULL;
