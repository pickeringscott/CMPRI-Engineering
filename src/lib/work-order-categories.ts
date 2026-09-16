export const WORK_ORDER_CATEGORIES = [
  "General",
  "HVAC",
  "Plumbing",
  "Electrical",
  "Appliances",
  "Doors/Locks",
  "Pool/Spa",
  "Laundry",
  "Public Area",
  "Safety",
  "TV / AV",
  "Furniture",
] as const;

export type WorkOrderCategory = typeof WORK_ORDER_CATEGORIES[number];

const LEGACY_CATEGORY_MAP: Readonly<Record<string, WorkOrderCategory>> = {
  appliance: "Appliances",
  appliances: "Appliances",
  pool: "Pool/Spa",
  "pool/spa": "Pool/Spa",
  "doors/locks": "Doors/Locks",
  "door/lock": "Doors/Locks",
  "doors & locks": "Doors/Locks",
  laundry: "Laundry",
  "public area": "Public Area",
  "public areas": "Public Area",
};

export function normalizeWorkOrderCategory(value: unknown): WorkOrderCategory | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const exact = WORK_ORDER_CATEGORIES.find((category) => category.toLowerCase() === text.toLowerCase());
  if (exact) return exact;
  return LEGACY_CATEGORY_MAP[text.toLowerCase()] || null;
}

export function categoryOptions(current?: string | null) {
  const values = [...WORK_ORDER_CATEGORIES] as string[];
  const existing = typeof current === "string" ? current.trim() : "";
  if (existing && !values.includes(existing)) values.unshift(existing);
  return values.map((value) => ({ value, label: value }));
}
