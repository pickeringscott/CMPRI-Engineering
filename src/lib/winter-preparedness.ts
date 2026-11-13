/** Transcribed from both pages of the supplied Winter Preparedness Checklist; only the year changes. */
export const WINTER_YEAR = 2026;
export type WinterTask = { id: string; text: string; children?: readonly WinterTask[] };
export const WINTER_TASKS: readonly WinterTask[] = [
  { id: 'water-shutoffs', text: 'Training on where the water shutoffs are and how to shut them off. Photos and drawings/maps posted near timeclocks, BOH, and in the emergency manual.' },
  { id: 'heaters', text: 'Make sure all stairwell and vestibule heaters are working properly.' },
  { id: 'back-of-house', text: 'Make sure there is adequate heat in all back of house areas. Please have maintenance staff check all back of house areas daily for cold spots. All BOH areas must be maintained above 40°F.' },
  { id: 'weather-tight', text: 'Ensure all buildings are “weather tight.” Close all windows, doors, vents, etc., and seal any openings in exterior walls, ceilings/roofs, and floors to prevent exposure to outside air.' },
  { id: 'pipe-insulation', text: 'Insulating piping and installing heat tracing lines on critical piping will substantially decrease the risk of a potential pipe freeze up. Be sure that facilities personnel inspect hard-to-heat areas.' },
  { id: 'drains', text: 'Verify all roof drains, drainpipes and gutters are free of debris and will provide adequate water drainage. Complete Fall Clean Up of all planting beds and planters' },
  { id: 'ooo-rooms', text: 'Ensure any extended OOO rooms are checked regularly to ensure adequate heating levels are maintained.' },
  { id: 'dry-sprinklers', text: 'If you have a dry sprinkler system, please make sure that water is drained from low points.' },
  { id: 'fire-pumps', text: 'Check Fire Pumps to make sure pump room has adequate heat' },
  { id: 'exhaust-fans', text: 'Ensure continuous rooftop exhaust fans are operational' },
  { id: 'louvers', text: 'Ensure automatic louvers systems are functional. For example - Behind commercial dryers, these should automatically close when dryers turn off. If not, repair and/or winterize(insulate and cover)' },
  { id: 'fire-panel', text: 'Make sure fire panel is fully functioning with no troubles.' },
  { id: 'pic-training', text: 'Make sure PIC training is conducted with Managers, Front Desk, Auditors, and engineering staff. Discuss who is responsible for shoveling/applying ice melt, how often it should be done,etc.' },
  { id: 'lawn-sprinklers', text: 'Flush and winterize outdoor lawn sprinkler system' },
  { id: 'furniture', text: 'Bring in outdoor furniture if not weather-resistant.' },
  { id: 'wet-floor', text: 'Have wet floor signs handy, along with doodlebug/spray to clean up dry salt' },
  { id: 'travel-safety', text: 'Talk to staff about winter safety and planning for more travel time.' },
  { id: 'snow-blowers', text: 'Service and tune up snow blowers to ensure they are working properly. Inspect Shuttle van tires to determine if they are in good condition and safe for the winter conditions.' },
  { id: 'storm-recovery', text: 'Ensure Storm Recovery training on is conducted with staff/Emergency response teams. To include: inspecting, documenting, and repair to any property damages such as (but not limited to) roofs, skylights, and overhangs, notifying ERTs of any injuries or deaths, and supply replenishments for preparation of subsequent storms' },
  { id: 'supplies', text: 'Have the following items on hand for guests and staff during winter emergencies', children: [
    { id: 'ice-melt', text: 'Ice melt (present at all building entrances)' },
    { id: 'shovels', text: 'Shovels' },
    { id: 'car-scrapers', text: 'Car scrapers' },
    { id: 'flashlights', text: 'Flashlights' },
    { id: 'blankets', text: 'Extra blankets' },
    { id: 'deicer', text: 'Cans of deicer' },
    { id: 'gloves', text: 'Dollar store snug gloves for guests who forget' },
    { id: 'battery-charger', text: 'Portable car battery charger and/or set of jumper cables' },
  ] },
  { id: 'snow-agreements', text: 'Ensure Snow removal agreements are in place, insurance documents on file.', children: [
    { id: 'curb-flags', text: 'Mark curbs/obstacles with flags' },
    { id: 'snow-contact', text: "Post snow removal company's number at the front desk along with a log to track when they are removing snow and/or salting/sanding lot." },
    { id: 'emergency-access', text: 'It is imperative that emergency access roads are cleared. It is important to communicate the procedures to be followed during severe weather to key operating and emergency personnel.' },
  ] },
];
export const WINTER_TASK_IDS = WINTER_TASKS.flatMap(task => [task.id, ...(task.children || []).map(child => child.id)]);
export type WinterItem = { item_id: string; checked: boolean; revision: number; changed_by: string; changed_by_name: string; changed_at: string };
