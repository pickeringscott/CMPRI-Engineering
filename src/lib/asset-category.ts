type EquipmentIdentity = { asset_type?: string | null; name?: string | null; manufacturer?: string | null };

/** Keep category inference identical in creation and the engineering editor. */
export function classifyAsset(asset: EquipmentIdentity): string {
  const type = String(asset.asset_type || "").toLowerCase();
  const name = String(asset.name || "").toLowerCase();
  const combined = `${type} ${name}`;

  // Explicit equipment type takes precedence over incidental location words.
  if (/\b(hvac|vtac|ptac|vpak|air condition|heat pump|water heating|energy management|rtu)\b/.test(type)) return "HVAC";
  if (/\b(door lock|lockset|saflok|dormakaba|keycard|key card)\b/.test(combined)) return "Doors/Locks";
  if (/\b(camera|surveillance|cctv|fire|access control|sprinkler|alarm)\b/.test(type)) return "Safety";
  if (/\b(tv|television|av|stb|set.top|enseo)\b/.test(type)) return "TV / AV";
  if (/plumbing|faucet|shower valve|toilet|drain/.test(type)) return "Plumbing";
  if (/\b(lighting|light|lamp|bulb|electrical|breaker|outlet)\b/.test(type)) return "Electrical";
  if (/washer|dryer|laundry/.test(type)) return "Laundry";
  if (/refrigerator|fridge|dishwasher|microwave|ice maker|ice machine|appliance|exercise equipment|shop tools/.test(type)) return "Appliances";
  if (/pool|spa|bromine/.test(type)) return "Pool/Spa";
  if (/chair|table|desk|sofa|couch|bed|furniture|cabinet/.test(type)) return "Furniture";

  if (/\b(vtac|ptac|vpak|hvac|friedrich|carrier|navien|verdant|heat pump|rtu)\b/.test(name)) return "HVAC";
  if (/saflok|dormakaba|door lock|keycard|key card/.test(name)) return "Doors/Locks";
  if (/pool|spa|hayward|bromine/.test(name)) return "Pool/Spa";
  if (/washer|dryer|laundry/.test(name)) return "Laundry";
  if (/refrigerator|fridge|dishwasher|microwave|ice maker|ice machine/.test(name)) return "Appliances";
  if (/shower valve|faucet|drain|toilet|sink/.test(name)) return "Plumbing";
  if (/\b(lighting|light|lamp|bulb|outlet|breaker|electrical)\b/.test(name)) return "Electrical";
  if (/fire|camera|surveillance|cctv|sprinkler|alarm/.test(name)) return "Safety";
  if (/\b(tv|television|enseo|stb)\b|set.top|network|phone|demarc/.test(name)) return "TV / AV";
  if (/chair|table|desk|sofa|couch|bed|furniture|cabinet/.test(name)) return "Furniture";
  return "General";
}
