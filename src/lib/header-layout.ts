export type HeaderLayout = {
  groups: string[];
  buttons: Record<string, string[]>;
  widths: Record<string, number>;
  collapsed: string[];
  positions?: Record<string, number>;
  active?: string | null;
};

function entries(value: unknown): [string, unknown][] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).slice(0, 20).filter(([key]) => key.length <= 160)
    : [];
}

export function normalizeHeaderLayout(value: unknown): HeaderLayout {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const names = (items: unknown) => Array.isArray(items) ? [...new Set(items.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 200))].slice(0, 100) : [];
  const buttons = Object.fromEntries(entries(row.buttons).map(([key, items]) => [key, names(items)]));
  const widths = Object.fromEntries(entries(row.widths).flatMap(([key, width]) =>
    typeof width === "number" && Number.isFinite(width) ? [[key, Math.max(40, Math.min(4000, width))]] : []
  ));
  const result: HeaderLayout = { groups: names(row.groups).slice(0, 20), buttons, widths, collapsed: names(row.collapsed).slice(0, 20) };
  if (row.positions && typeof row.positions === "object" && !Array.isArray(row.positions)) {
    result.positions = Object.fromEntries(entries(row.positions).flatMap(([key, position]) =>
      typeof position === "number" && Number.isFinite(position) ? [[key, Math.max(0, Math.min(4000, position))]] : []
    ));
  }
  if (row.active === null || (typeof row.active === "string" && row.active.length > 0 && row.active.length <= 160)) {
    result.active = row.active;
  }
  return result;
}

/** Keep an existing account arrangement when the same authorized asset group is relabeled. */
export function headerLayoutForGroups(value: unknown, labels: readonly string[]): HeaderLayout {
 const layout=normalizeHeaderLayout(value),titles=new Set(labels);
 const alias=(name:string)=>{
   if (!["Assets & Supply","Assets and Inventory","Assets & Inventory"].includes(name) || titles.has(name)) return name;
   return ["Assets and Inventory","Assets & Inventory","Assets & Supply"].find(title=>titles.has(title)) || name;
 };
 const remap=<T>(values:Record<string,T>)=>Object.fromEntries(Object.entries(values).sort(([a],[b])=>Number(a===alias(a))-Number(b===alias(b))).map(([key,value])=>[alias(key),value]));
 return normalizeHeaderLayout({...layout,groups:layout.groups.map(alias),buttons:remap(layout.buttons),widths:remap(layout.widths),collapsed:layout.collapsed.map(alias),positions:layout.positions&&remap(layout.positions),active:layout.active?alias(layout.active):layout.active});
}

type HeaderAction = { key: string; label: string };
type HeaderGroup<T> = { label: string; items: T[]; centered?: boolean };

function actionLayoutKey(action: HeaderAction) {
  return action.key + "::" + action.label.replace(/ \(\d+\)$/, "");
}

export function allowsAnchoredHeaderPlacement(restricted: boolean, key: string, label: string) {
  if (!restricted) return true;
  if (key === "/previews/cmpri-weather-preview.html") return label === "Safety & Logs";
  return (key === "sign-out") === (label === "Account");
}

/** A saved layout can move only controls already present in the live authorization projection. */
export function anchoredHeaderLayoutForGroups<T extends HeaderAction>(
  value: unknown,
  authorizedGroups: HeaderGroup<T>[],
  restricted: boolean,
): { layout: HeaderLayout; groups: HeaderGroup<T>[] } {
  const labels = authorizedGroups.map(group => group.label);
  const source = headerLayoutForGroups(value, labels);
  const seen = new Set<string>();
  const groups = authorizedGroups.map(group => ({ ...group, items: [] as T[] }));
  const byKey = new Map(authorizedGroups.flatMap(group =>
    group.items.map(action => [actionLayoutKey(action), action] as const)
  ));
  const place = (group: HeaderGroup<T>, key: string, action: T) => {
    if (seen.has(key) || !allowsAnchoredHeaderPlacement(restricted, action.key, group.label)) return;
    seen.add(key);
    group.items.push(action);
  };

  if (source.positions) {
    for (const group of groups) {
      for (const key of source.buttons[group.label] || []) {
        const action = byKey.get(key);
        if (action) place(group, key, action);
      }
    }
  }

  const legacyGroups = [...new Set([...source.groups, ...Object.keys(source.buttons)])];
  const legacyOrder = legacyGroups.flatMap(label => source.buttons[label] || []);
  function priority(action: T) {
    const exact = legacyOrder.indexOf(actionLayoutKey(action));
    const oldKey = legacyOrder.indexOf(action.key);
    return exact >= 0 ? exact : oldKey >= 0 ? oldKey : Number.MAX_SAFE_INTEGER;
  }
  groups.forEach((group, index) => {
    const defaults = authorizedGroups[index].items;
    const items = source.positions ? defaults : [...defaults].sort((a, b) => priority(a) - priority(b));
    for (const action of items) place(group, actionLayoutKey(action), action);
  });

  const collapsed = labels.filter(label => !source.positions || !source.groups.includes(label) || source.collapsed.includes(label));
  const active = source.active && labels.includes(source.active) && !collapsed.includes(source.active) ? source.active : null;
  const positions = Object.fromEntries(labels.flatMap(label =>
    source.positions && Object.hasOwn(source.positions, label) ? [[label, source.positions[label]]] : []
  ));
  const widths = Object.fromEntries(labels.flatMap(label =>
    Object.hasOwn(source.widths, label) ? [[label, source.widths[label]]] : []
  ));
  const buttons = Object.fromEntries(groups.map(group => [group.label, group.items.map(actionLayoutKey)]));
  return { groups, layout: { groups: labels, buttons, widths, collapsed, positions, active } };
}
