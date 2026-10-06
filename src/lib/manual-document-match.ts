type EquipmentIdentity = {
  manufacturer?: string | null;
  model_family?: string | null;
  model_number?: string | null;
};

type ManualIdentity = {
  manufacturer?: string | null;
  model_family?: string | null;
  model_number?: string | null;
  equipment?: string | null;
  source?: {
    manufacturer?: string | null;
    model_family?: string | null;
    model_number?: string | null;
    equipment?: string | null;
  } | null;
  document?: {
    manufacturer?: string | null;
    model_family?: string | null;
    model_number?: string | null;
    equipment?: string | null;
  } | null;
};

function exactIdentityValue(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US") : "";
}

export function manualMatchesEquipment(asset: EquipmentIdentity, manual: ManualIdentity) {
  const assetManufacturer = exactIdentityValue(asset.manufacturer);
  const assetFamily = exactIdentityValue(asset.model_family);
  const assetModel = exactIdentityValue(asset.model_number);
  const manualManufacturer = exactIdentityValue(manual.manufacturer) ||
    exactIdentityValue(manual.source?.manufacturer) ||
    exactIdentityValue(manual.document?.manufacturer);
  const manualFamily = exactIdentityValue(manual.model_family) ||
    exactIdentityValue(manual.source?.model_family) ||
    exactIdentityValue(manual.document?.model_family) ||
    exactIdentityValue(manual.equipment) ||
    exactIdentityValue(manual.source?.equipment) ||
    exactIdentityValue(manual.document?.equipment);
  const manualModel = exactIdentityValue(manual.model_number) ||
    exactIdentityValue(manual.source?.model_number) ||
    exactIdentityValue(manual.document?.model_number);

  return Boolean(
    assetManufacturer &&
    manualManufacturer &&
    assetManufacturer === manualManufacturer &&
    ((assetFamily && manualFamily && assetFamily === manualFamily) ||
      (assetModel && manualModel && assetModel === manualModel))
  );
}
