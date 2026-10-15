import type { SupabaseClient } from "@supabase/supabase-js";

export type RegisteredAssetFile = {
  id: string;
  name: string;
  storage_path: string;
  preferred: boolean;
  created_at: string | null;
  updated_at: string | null;
};

/** Metadata comes from the authoritative CMPRI table. Storage serves bytes only. */
export async function listRegisteredAssetFiles(client: SupabaseClient, assetId: string) {
  const { data, error } = await client.rpc("cmpri_list_asset_files", { p_asset_id: assetId });
  return { data: (data || []) as RegisteredAssetFile[], error };
}

export async function registerAssetFile(client: SupabaseClient, assetId: string, storagePath: string) {
  return client.rpc("cmpri_register_asset_file", { p_asset_id: assetId, p_storage_path: storagePath });
}
