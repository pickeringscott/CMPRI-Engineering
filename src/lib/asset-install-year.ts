export function maximumAssetInstallYear(now = new Date()) {
  return now.getUTCFullYear() + 1;
}

export function parseAssetInstallYear(value: unknown, now = new Date()): number | null {
  if (value === undefined || value === null || value === "") return null;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1900 || year > maximumAssetInstallYear(now)) {
    throw new Error("Install year is invalid.");
  }
  return year;
}
