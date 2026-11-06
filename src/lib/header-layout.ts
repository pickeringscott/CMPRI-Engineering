export type HeaderLayout = { groups: string[]; buttons: Record<string, string[]>; widths: Record<string, number>; collapsed: string[] };

export function normalizeHeaderLayout(value: unknown): HeaderLayout {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const names = (items: unknown) => Array.isArray(items) ? [...new Set(items.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 200))].slice(0, 100) : [];
  const buttons: Record<string, string[]> = {}, widths: Record<string, number> = {};
  for (const [key, items] of Object.entries(row.buttons && typeof row.buttons === 'object' ? row.buttons : {}).slice(0, 20)) if (key.length <= 160) buttons[key] = names(items);
  for (const [key, width] of Object.entries(row.widths && typeof row.widths === 'object' ? row.widths : {}).slice(0, 20)) if (key.length <= 160 && typeof width === 'number' && Number.isFinite(width)) widths[key] = Math.max(40, Math.min(4000, width));
  return { groups: names(row.groups).slice(0, 20), buttons, widths, collapsed: names(row.collapsed).slice(0, 20) };
}
