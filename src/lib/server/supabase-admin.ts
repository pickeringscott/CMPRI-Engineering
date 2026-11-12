import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "@/lib/supabase/config";
import {manualPreviewFetch,manualPreviewReadOnly} from './manual-preview';

export function createSupabaseAdmin() {
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!service) return null;
  return createClient(SUPABASE_URL, service, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(manualPreviewReadOnly()?{global:{fetch:manualPreviewFetch()}}:{}),
  });
}
