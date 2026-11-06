/** Coral Glow palette and inventory order from approved header v23. */
const names = ["Work Order List", "Daily Room Ops", "Staff Notes", "Pool Log", "Room Ranker", "Preventive Maintenance", "Pool", "Manage Profile", "Connect ChatGPT", "Sign Out", "Front Desk Quick Guides", "Preventative Maintenance", "Manage Rooms", "GSS Reports", "Enseo Assignments", "Room Ranker Old", "Candidate questionnaires", "PO", "Inventory", "Assets", "Manage Users", "Feedback", "Hours Tracker", "Refresh", "All Work Orders"];
const colors = ["#F3BB75", "#CF90FE", "#FE8B9C", "#62B5F1", "#EFE653", "#75DFB4"];
export function headerActionStyle(label: string): Record<string,string> {
  label = label.replace(/ \(\d+\)$/,'');
  if (label === "Sign Out") return {"background-color":"#2a1721","border-color":"#73333e",color:"#fecaca","--action-rgb":"200,100,115","box-shadow":"none"};
  const index = names.indexOf(label);
  if (index < 0 && !label.includes("Maintenance")) return {};
  const color = label.includes("Maintenance") ? "#00D492" : colors[index % colors.length];
  const rgb = color.match(/[a-f0-9]{2}/gi)!.map(value => parseInt(value,16));
  return {"background-color":`rgba(${rgb.join(',')},0.14)`,"border-color":`rgba(${rgb.join(',')},0.42)`,color:`rgb(${rgb.map(value=>Math.round(value*.18+255*.82)).join(',')})`,"--action-rgb":rgb.join(','),"box-shadow":"none"};
}

/** React style projection shares the exact approved button colors with modal title bars. */
export function modalTitleStyle(title: string) {
  const palette=headerActionStyle(modalAction(title));
  return {backgroundColor:palette["background-color"],borderColor:palette["border-color"],color:palette.color};
}

function modalAction(title: string) {
  const aliases: Record<string,string> = { 'Purchase Orders':'PO', 'POs':'PO', 'Work Orders':'Work Order List', 'Work Order Detail':'Work Order List', 'Create Work Order':'Work Order List', '+ Work Order':'Work Order List', 'Work Order Approvals':'Work Order List', 'Work Order Notifications':'Work Order List', 'Notifications':'Work Order List' };
  return aliases[title] || (/^Work Order(?! List)/.test(title) ? 'Work Order List' : title);
}

export function modalActionForRoute(href: string, title = '') {
  const path = href.split('?')[0];
  const routes: Record<string,string> = { '/work-orders':'Work Order List', '/engineering/room-operations':'Daily Room Ops', '/engineering/room-ranking':'Room Ranker', '/engineering/preventive-maintenance':'Preventive Maintenance', '/engineering/pool-log':'Pool Log', '/pool':'Pool', '/staff-notes':'Staff Notes', '/profile':'Manage Profile', '/engineering/hours-tracker':'Hours Tracker', '/management/rooms':'Manage Rooms', '/management/users':'Manage Users', '/management/equipment':'Assets', '/engineering/parts':'Inventory', '/engineering/purchasing':'PO', '/engineering/gss':'GSS Reports', '/engineering/enseo-assignments':'Enseo Assignments', '/engineering/employment':'Candidate questionnaires', '/feedback':'Feedback' };
  return routes[path] || (path.startsWith('/work-orders/') ? 'Work Order List' : modalAction(title));
}

export function modalThemeStyle(action: string): Record<string,string> {
  const palette = headerActionStyle(modalAction(action));
  const rgb = palette['--action-rgb'] || '243,187,117';
  return {
    '--cmpri-action-rgb': rgb,
    '--cmpri-modal-base': '#0f172a',
    '--cmpri-modal-surface': `color-mix(in srgb, rgb(${rgb}) 5.5%, #0f172a)`,
    '--cmpri-modal-text': palette.color || 'rgb(253,243,230)',
    '--cmpri-outline': `rgba(${rgb},.42)`,
    '--cmpri-scroll-thumb': `rgba(${rgb},.28)`,
    borderColor: `rgba(${rgb},.42)`,
  };
}
