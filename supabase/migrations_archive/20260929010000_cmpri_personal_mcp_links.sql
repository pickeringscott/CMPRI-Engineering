CREATE TABLE IF NOT EXISTS public.cmpri_personal_mcp_links (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  resource text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('cmpri:read', 'cmpri:read cmpri:write')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cmpri_personal_mcp_links_expiry_idx
  ON public.cmpri_personal_mcp_links (expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE public.cmpri_personal_mcp_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cmpri_personal_mcp_links FROM anon, authenticated;
GRANT ALL ON public.cmpri_personal_mcp_links TO service_role;
