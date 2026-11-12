/** Advance only the version produced by our own PDF save; keep any edits intact. */
export function afterDocumentSave<T extends { id: string; updated_at?: string }>(asset: T, assetId: string, previous: string, saved: string): T {
  return asset.id === assetId && asset.updated_at === previous ? { ...asset, updated_at: saved } : asset;
}
