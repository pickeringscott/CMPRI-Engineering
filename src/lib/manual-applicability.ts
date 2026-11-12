/** Applicability is a reviewed assertion about one physical asset, not a model-name guess. */
export type ManualAssetIdentity = {
  id: string;
  manufacturer?: string | null;
  model_number?: string | null;
  model_family?: string | null;
  serial_number?: string | null;
};
export type ManualApplicabilityReview = {
  asset_id: string;
  manufacturer: string;
  model_number: string;
  model_family: string;
  serial_number: string;
  confirmed: true;
};
export type NumericSerialRange = { kind: "numeric"; from: string; to: string };
export function numericSerialRange(value: unknown): NumericSerialRange | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid serial range.");
  const range = value as Record<string, unknown>;
  if (range.kind !== "numeric" || typeof range.from !== "string" || typeof range.to !== "string" || !/^\d{1,32}$/.test(range.from) || !/^\d{1,32}$/.test(range.to) || BigInt(range.from) > BigInt(range.to)) throw new Error("Enter an ascending numeric serial range with up to 32 digits per value.");
  return { kind: "numeric", from: range.from, to: range.to };
}
export function serialRangeStatus(serial: unknown, rangeValue: unknown): "unrestricted" | "match" | "unknown" | "outside" {
  if (rangeValue == null) return "unrestricted";
  let range: NumericSerialRange | null;
  try { range = numericSerialRange(rangeValue); } catch { return "unknown"; }
  const number = text(serial);
  if (!range || !/^\d{1,32}$/.test(number)) return "unknown";
  return BigInt(number) >= BigInt(range.from) && BigInt(number) <= BigInt(range.to) ? "match" : "outside";
}
export type ApplicableManualLink = {
  object_id?: string;
  storage_path?: string;
  title?: string;
  sha256?: string;
  applicability?: string;
  quarantine_acknowledged?: boolean;
  compatibility_basis?: string;
  saved_by?: string;
  applicability_review?: ManualApplicabilityReview | null;
  serial_range?: NumericSerialRange | null;
};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const equal = (left: unknown, right: unknown) => text(left).toUpperCase() === text(right).toUpperCase();
export function manualAssetIdentity(asset: ManualAssetIdentity) {
  return { asset_id: asset.id, manufacturer: text(asset.manufacturer), model_number: text(asset.model_number),
    model_family: text(asset.model_family), serial_number: text(asset.serial_number) };
}
export function validateManualApplicability(asset: ManualAssetIdentity, value: unknown): ManualApplicabilityReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Confirm your manual choice for this physical equipment.');
  const review = value as Record<string, unknown>;
  const identity = manualAssetIdentity(asset);
  if (review.asset_id !== identity.asset_id) throw new Error('This manual choice belongs to a different physical asset.');
  if (review.confirmed !== true) throw new Error('Confirm that you selected this manual for this physical equipment.');
  return { ...identity, confirmed: true };
}
export function eligibleManualLinks<T extends ApplicableManualLink>(asset: ManualAssetIdentity, links: T[]): { eligible: T[]; unresolved: Array<{ link: T; reason: string }>; warnings: Array<{ link: T; reason: string }> } {
  const eligible: T[] = [], unresolved: Array<{ link: T; reason: string }> = [], warnings: Array<{ link: T; reason: string }> = [];
  for (const link of links) {
    try {
      if (!link.object_id || !link.storage_path || !/^[a-f0-9]{64}$/.test(link.sha256 || '')) throw new Error('The original file identity has not been reviewed.');
      if (link.applicability !== 'confirmed_model') throw new Error('This document is a reference; applicability to this equipment has not been confirmed.');
      // Earlier importer saves already required explicit user confirmation.
      // Preserve those choices; do not turn this release into mandatory re-review.
      const priorUserChoice = !link.applicability_review && link.compatibility_basis === 'user_confirmed' && Boolean(link.saved_by);
      if (!priorUserChoice) validateManualApplicability(asset, link.applicability_review);
      const rangeStatus = serialRangeStatus(asset.serial_number, link.serial_range);
      if (rangeStatus === "unknown") throw new Error("Serial range requires a numeric asset serial number and valid reviewed limits.");
      if (rangeStatus === "outside") throw new Error("The asset serial number is outside this manual's reviewed range.");
      eligible.push(link);
      const identity = manualAssetIdentity(asset);
      if (link.applicability_review && !['manufacturer','model_number','model_family','serial_number'].every(key => equal((link.applicability_review as unknown as Record<string, unknown>)[key], identity[key as keyof typeof identity]))) {
        warnings.push({ link, reason: 'Equipment details changed since this manual was chosen. The user-selected association is retained; check any edition or serial restrictions.' });
      }
    } catch (error) {
      unresolved.push({ link, reason: error instanceof Error ? error.message : 'Manual applicability is unresolved.' });
    }
  }
  return { eligible, unresolved, warnings };
}
