import { createClient } from "@supabase/supabase-js";

function looksLikeJwt(value: string) {
  return value.split(".").length === 3 && value.startsWith("eyJ");
}

export function createSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) return null;
  if (!looksLikeJwt(service)) return null;
  return createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
}
