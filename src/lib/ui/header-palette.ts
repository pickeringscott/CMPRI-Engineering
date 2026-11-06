/** Coral Glow palette and inventory order from approved header v23. */
const names = ["Work Order List", "Daily Room Ops", "Staff Notes", "Pool Log", "Room Ranker", "Preventive Maintenance", "Pool", "Manage Profile", "Connect ChatGPT", "Sign Out", "Front Desk Quick Guides", "Preventative Maintenance", "Manage Rooms", "GSS Reports", "Enseo Assignments", "Room Ranker Old", "Candidate questionnaires", "PO", "Inventory", "Assets", "Manage Users", "Feedback", "Hours Tracker", "Refresh", "All Work Orders"];
const colors = ["#F3BB75", "#CF90FE", "#FE8B9C", "#62B5F1", "#EFE653", "#75DFB4"];
export function headerActionStyle(label: string): Record<string,string> {
  if (label === "Sign Out") return {"background-color":"#2a1721","border-color":"#73333e",color:"#fecaca","--action-rgb":"200,100,115","box-shadow":"none"};
  const index = names.indexOf(label);
  if (index < 0 && !label.includes("Maintenance")) return {};
  const color = label.includes("Maintenance") ? "#00D492" : colors[index % colors.length];
  const rgb = color.match(/[a-f0-9]{2}/gi)!.map(value => parseInt(value,16));
  return {"background-color":`rgba(${rgb.join(',')},0.14)`,"border-color":`rgba(${rgb.join(',')},0.42)`,color:`rgb(${rgb.map(value=>Math.round(value*.18+255*.82)).join(',')})`,"--action-rgb":rgb.join(','),"box-shadow":"none"};
}

/** React style projection shares the exact approved button colors with modal title bars. */
export function modalTitleStyle(title: string) {
  const aliases: Record<string,string> = {"Purchase Orders":"PO","Preventive Maintenance":"Preventive Maintenance","Work Orders":"Work Order List"};
  const palette=headerActionStyle(/^Work Order(?! List)/.test(title)?"Work Order List":aliases[title]||title);
  return {backgroundColor:palette["background-color"],borderColor:palette["border-color"],color:palette.color};
}
