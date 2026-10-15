import { frontDeskCommonArea, type CommonAreaLocation } from "../cmpri-location-groups";
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

/** New tickets use committed location mapping; Front Desk also includes hotel common areas. */
export function creationAssetsForLocation<T extends AssetForAssignment>(
  assets: readonly T[], locationId: string | null | undefined, currentAssetId: string | null | undefined, locations: readonly CommonAreaLocation[] = [],
): T[] {
  if (!locationId) return [];
  const ticket = locations.find(location => location.id === locationId);
  return assets.filter(asset => asset.active !== false && (asset.location_id === locationId
    || (asset.location_id !== null && frontDeskCommonArea(ticket, locations.find(location => location.id === asset.location_id)))
    || (asset.location_id === null && asset.id === currentAssetId)));
}
