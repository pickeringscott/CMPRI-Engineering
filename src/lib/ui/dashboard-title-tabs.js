// Reserve one layout step beyond the 2px hitbox gap when CSS positions round up.
const GAP = 2 + 1 / 64;
const TAIL = 8;
const ceil = value => Math.ceil(value * 64) / 64;
const floor = value => Math.floor(value * 64) / 64;
const round = value => Math.round(value * 64) / 64;

/** The raised part of the native outline; its wide content row is excluded. */
export function titleTabOutline(width) {
  return { left: 11, right: 11 + width + 6 };
}

/**
 * Resolve title hitboxes only. Preferred positions are immutable; a crowded
 * rail gains horizontal overflow instead of allowing captions to intersect.
 * @template T
 * @param {{item:T,left:number,width:number,minimum?:number,anchor?:boolean}[]} tabs
 * @param {number} [gap]
 */
export function resolveTitleTabIntervals(tabs, gap = GAP) {
  const occupied = [], resolved = new Map();
  const ordered = tabs.map((tab, index) => ({ ...tab, index }))
    .sort((a, b) => Number(Boolean(b.anchor)) - Number(Boolean(a.anchor)) || a.left - b.left || a.index - b.index);
  for (const tab of ordered) {
    const minimum = Math.max(0, tab.minimum || 0);
    const desired = Math.max(minimum, tab.left);
    const free = left => left >= minimum && occupied.every(other =>
      left + tab.width + gap <= other.left || left >= other.left + other.width + gap);
    const candidates = [ceil(desired), ceil(minimum), ...occupied.flatMap(other => [
      floor(other.left - tab.width - gap), ceil(other.left + other.width + gap),
    ])].filter(free).sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired) || a - b);
    const left = candidates[0] ?? ceil(Math.max(minimum, ...occupied.map(other => other.left + other.width + gap)));
    const placed = { ...tab, left };
    occupied.push(placed);
    resolved.set(tab.item, left);
  }
  return resolved;
}

function measureTitleTabs(bar) {
  return [...bar.children].flatMap(field => {
    const title = field.querySelector(':scope > legend');
    const ask = field.hasAttribute('data-ask-launcher-tab');
    if (!title || ask && field.titleTabVisible === false) return [];
    const width = title.offsetWidth;
    if (width <= 0) return [];
    // Layout dimensions stay fixed during press transforms. offsetWidth rounds
    // to whole pixels, so reserve another half pixel for a fractional border box.
    let left = field.clientLeft + title.offsetLeft;
    let right = left + width + 0.5;
    const edge = field.querySelector(':scope > .tab-resize-edge');
    if (edge?.offsetWidth) {
      left = Math.min(left, field.clientLeft + edge.offsetLeft);
      right = Math.max(right, field.clientLeft + edge.offsetLeft + edge.offsetWidth);
    }
    if (!field.classList.contains('collapsed') && field.querySelector(':scope > .group-outline')) {
      const cap = titleTabOutline(width);
      // The SVG starts at -1px inside the field border. Include each 3px
      // shoulder and half of its 1px stroke, even before the first path draw.
      const origin = field.clientLeft - 1;
      left = Math.min(left, origin + cap.left - 3.5);
      right = Math.max(right, origin + cap.right + 3.5);
    }
    left = round(left);
    right = round(right);
    return [{ item: field, left: (field.positionX || 0) + left, inset: left, minimum: Math.max(0, left), width: right - left, anchor: ask }];
  });
}

function nominalWidth(root, tabs) {
  const viewport = root.clientWidth || root.getBoundingClientRect().width;
  return Math.ceil(Math.max(viewport, tabs.reduce((sum, tab) => sum + tab.width, 0)
    + Math.max(0, tabs.length - 1) * GAP + Math.max(0, ...tabs.map(tab => tab.inset)) + TAIL));
}

/** Stable movement bounds must not depend on a previous collision-expanded rail. */
export function titleTabRailWidth(root, bar) {
  return nominalWidth(root, measureTitleTabs(bar));
}

/** Both native menus and Ask use this same synchronous, idempotent placement. */
export function placeDashboardTitleTabs(root, bar) {
  const tabs = measureTitleTabs(bar);
  const positions = resolveTitleTabIntervals(tabs);
  let extent = nominalWidth(root, tabs), changed = false;
  for (const tab of tabs) {
    const left = positions.get(tab.item);
    const renderedLeft = ceil(left - tab.inset);
    const cssLeft = renderedLeft + 'px';
    if (tab.item.style.left !== cssLeft) {
      tab.item.style.left = cssLeft;
      changed = true;
    }
    extent = Math.max(extent, Math.ceil(renderedLeft + tab.inset + tab.width + TAIL));
  }
  const minWidth = extent + 'px';
  if (bar.style.minWidth !== minWidth) {
    bar.style.minWidth = minWidth;
    changed = true;
  }
  return { changed, extent };
}
