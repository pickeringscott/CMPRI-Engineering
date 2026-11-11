export type AssetGuideIdentity = {
  id: string;
  documentation_key?: string | null;
  documentation_revision_id?: string | null;
  documentation_verified_at?: string | null;
  manufacturer?: string | null;
  model_family?: string | null;
  model_number?: string | null;
};

/** Missing optional fields and explicit null both mean no saved identity value. */
export function assetGuideIdentity(asset: AssetGuideIdentity | null | undefined) {
  return asset ? JSON.stringify([
    asset.id, asset.documentation_key ?? null, asset.documentation_revision_id ?? null,
    asset.documentation_verified_at ?? null, asset.manufacturer ?? null,
    asset.model_family ?? null, asset.model_number ?? null,
  ]) : "";
}

/** Reconcile only guide fields, and never overwrite a newer equipment selection/edit. */
export function reconcileAssetGuide<T extends AssetGuideIdentity>(assets: T[], requested: T, source: T): T[] {
  if (source.id !== requested.id || assetGuideIdentity(source) === assetGuideIdentity(requested)) return assets;
  return assets.map(asset => asset.id === requested.id && assetGuideIdentity(asset) === assetGuideIdentity(requested)
    ? { ...asset, documentation_key: source.documentation_key, documentation_revision_id: source.documentation_revision_id,
      documentation_verified_at: source.documentation_verified_at, manufacturer: source.manufacturer,
      model_family: source.model_family, model_number: source.model_number }
    : asset);
}
