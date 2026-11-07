/** Coral Glow palette and inventory order from approved header v23. */
import { sitePalette, paletteToken } from './site-palette-defaults';
const names = ["Work Order List", "Daily Room Ops", "Staff Notes", "Pool Log", "Room Ranker", "Preventive Maintenance", "Pool", "Manage Profile", "Connect ChatGPT", "Sign Out", "Front Desk Quick Guides", "Preventative Maintenance", "Manage Rooms", "GSS Reports", "Enseo Assignments", "Room Ranker Old", "Candidate questionnaires", "PO", "Inventory", "Assets", "Manage Users", "Feedback", "Hours Tracker", "Refresh", "All Work Orders"];
export function headerActionStyle(label: string): Record<string,string> {
  label = label.replace(/ \(\d+\)$/,'');
  if (label === 'Manage Locations') label = 'Manage Rooms';
  if (label === "Sign Out") return {"background-color":paletteToken('sign-out-background',sitePalette.signOut.background),"border-color":paletteToken('sign-out-border',sitePalette.signOut.border),color:paletteToken('sign-out-text',sitePalette.signOut.text),"--action-rgb":paletteToken('sign-out-rgb',sitePalette.signOut.rgb),"box-shadow":"none"};
  const index = names.indexOf(label);
  if (index < 0 && !label.includes("Maintenance")) return {};
  const accent = sitePalette.accents[index % sitePalette.accents.length];
  const maintenance = label.includes('Maintenance');
  const raw = maintenance ? sitePalette.maintenance : accent.rgb;
  const rgb = paletteToken(maintenance ? 'maintenance' : accent.name+'-rgb', raw);
  const text = 'rgb('+raw.split(',').map(value=>Math.round(Number(value)*.18+255*.82)).join(',')+')';
  return {"background-color":`rgba(${rgb},0.14)`,"border-color":`rgba(${rgb},0.42)`,color:paletteToken(maintenance?'maintenance-text':accent.name+'-text',text),"--action-rgb":rgb,"box-shadow":"none"};
}

/** Approved work-order modal schemes; dashboard action colors keep their inventory mapping. */
function modalPaletteStyle(action: string): Record<string,string> {
  const name = action === 'Create Work Order' || action === '+ Work Order'
    ? 'create'
    : action === 'Work Order Detail' || action === 'Work Order'
      ? 'detail'
      : action === 'Hours Tracker' ? 'hours' : null;
  if (!name) return headerActionStyle(modalAction(action));
  const defaults = sitePalette.special[name];
  const scheme = { rgb: paletteToken(name+'-rgb', defaults.rgb), base: paletteToken(name+'-base', defaults.base) };
  return {
    '--action-rgb': scheme.rgb,
    '--modal-base': scheme.base,
    'background-color': `color-mix(in srgb, rgb(${scheme.rgb}) 16%, ${scheme.base})`,
    'border-color': `color-mix(in srgb, rgb(${scheme.rgb}) 32%, ${scheme.base})`,
    color: `color-mix(in srgb, rgb(${scheme.rgb}) 12%, ${paletteToken('white',sitePalette.semantic.white)})`,
  };
}

/** React style projection shares the exact approved button colors with modal title bars. */
export function modalTitleStyle(title: string) {
  const palette=modalPaletteStyle(title);
  return {backgroundColor:palette["background-color"],borderColor:palette["border-color"],color:palette.color};
}

function modalAction(title: string) {
  const aliases: Record<string,string> = { 'Purchase Orders':'PO', 'POs':'PO', 'Work Orders':'Work Order List', 'Work Order Detail':'Work Order List', 'Create Work Order':'Work Order List', '+ Work Order':'Work Order List', 'Work Order Approvals':'Work Order List', 'Work Order Notifications':'Work Order List', 'Notifications':'Work Order List' };
  return aliases[title] || (/^Work Order(?! List)/.test(title) ? 'Work Order List' : title);
}

export function modalActionForRoute(href: string, title = '') {
  const path = href.split('?')[0];
  const routes: Record<string,string> = { '/work-orders':'Create Work Order', '/engineering/room-operations':'Daily Room Ops', '/engineering/room-ranking':'Room Ranker', '/engineering/preventive-maintenance':'Preventive Maintenance', '/engineering/pool-log':'Pool Log', '/pool':'Pool', '/staff-notes':'Staff Notes', '/profile':'Manage Profile', '/engineering/hours-tracker':'Hours Tracker', '/management/rooms':'Manage Locations', '/management/users':'Manage Users', '/management/equipment':'Assets', '/engineering/parts':'Inventory', '/engineering/purchasing':'PO', '/engineering/gss':'GSS Reports', '/engineering/enseo-assignments':'Enseo Assignments', '/engineering/employment':'Candidate questionnaires', '/feedback':'Feedback' };
  return routes[path] || (path.startsWith('/work-orders/') ? 'Work Order Detail' : modalAction(title));
}

export function modalThemeStyle(action: string): Record<string,string> {
  const palette = modalPaletteStyle(action);
  const rgb = palette['--action-rgb'] || paletteToken('apricot-rgb',sitePalette.accents[0].rgb);
  const base = palette['--modal-base'] || paletteToken('modal-base',sitePalette.modalBase);
  const text = palette.color || paletteToken('modal-text','rgb(253,243,230)');
  return {
    '--cmpri-action-rgb': rgb,
    '--cmpri-modal-base': base,
    '--cmpri-modal-surface': `color-mix(in srgb, rgb(${rgb}) 5.5%, ${base})`,
    '--cmpri-modal-text': text,
    '--cmpri-modal-muted': `color-mix(in srgb, ${text} 62%, ${base})`,
    '--cmpri-modal-subtle': `color-mix(in srgb, ${text} 45%, ${base})`,
    '--cmpri-outline': `rgba(${rgb},.42)`,
    '--cmpri-scroll-thumb': `rgba(${rgb},.28)`,
    borderColor: `rgba(${rgb},.42)`,
  };
}

export function modalDisplayTitle(href: string, title: string) {
  return href.split(/[?#]/)[0] === '/management/rooms' ? 'Manage Locations' : title;
}
