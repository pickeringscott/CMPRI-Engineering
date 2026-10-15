export type AssetForAssignment = {
  id: string;
  location_id: string | null;
  active?: boolean | null;
};

// Manual selection includes catalog templates; choosing one does not confirm its location.
export function assignableAssetsForLocation<T extends AssetForAssignment>(
  assets: readonly T[],
  locationId: string | null | undefined,
  currentAssetId: string | null | undefined,
): T[] {
  return assets.filter((asset) =>
    asset.id === currentAssetId
    || (asset.active !== false && (asset.location_id === null
      || (Boolean(locationId) && asset.location_id === locationId))));
}

// Automatic inference must never treat a catalog template as installed room equipment.
export function roomAssetsForInference<T extends AssetForAssignment>(
  assets: readonly T[],
  locationId: string | null | undefined,
): T[] {
  return assets.filter((asset) =>
    Boolean(locationId) && asset.location_id === locationId && asset.active !== false);
}
