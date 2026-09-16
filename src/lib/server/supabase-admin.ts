import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "@/lib/supabase/config";

function looksLikeJwt(value: string) {
  return value.split(".").length === 3 && value.startsWith("eyJ");
}

export function createSupabaseAdmin() {
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!service || !looksLikeJwt(service)) return null;
  return createClient(SUPABASE_URL, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
