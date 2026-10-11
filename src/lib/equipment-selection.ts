/** Identical inference inputs for the creation preview and the submission route. */
export const EQUIPMENT_SELECTION_COLUMNS = "id, location_id, name, asset_type, manufacturer, model_number, generation, asset_tag, documentation_key, active, status, binder_tag, quantity";

export function equipmentOptionLabel(asset: {
  name: string; asset_tag?: string | null; binder_tag?: string | null; quantity?: number | null;
}) {
  const tags = [...new Set([asset.asset_tag, asset.binder_tag].filter((tag): tag is string => Boolean(tag?.trim())))];
  return [asset.name, ...tags, asset.quantity == null ? "" : `Qty ${asset.quantity}`].filter(Boolean).join(" · ");
}
