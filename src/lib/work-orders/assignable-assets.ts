export type AssetForAssignment = {
  id: string;
  location_id: string | null;
  active?: boolean | null;
};

export function assignableAssetsForLocation<T extends AssetForAssignment>(
  assets: readonly T[],
  locationId: string | null | undefined,
  currentAssetId: string | null | undefined,
): T[] {
  return assets.filter((asset) =>
    asset.id === currentAssetId
    || (Boolean(locationId) && asset.location_id === locationId && asset.active !== false));
}
