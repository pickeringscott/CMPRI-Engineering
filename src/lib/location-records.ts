export interface Location {
  id: string; area: string | null; name: string | null; room_number: string | null;
  location_type: string | null; active: boolean;
}
export interface WorkOrder { id: string; display_id?: string | null; location_id: string | null; room: string | null; issue: string | null; status: string | null; created_at: string | null }
export interface PmPlan {
  id: string; location_id: string | null; asset_id: string | null; title: string; description: string | null;
  checklist: unknown; frequency_value: number; frequency_unit: string; last_completed_on: string | null; next_due_on: string | null; active: boolean;
}
export interface PmCompletion { id: string; pm_plan_id: string; completed_on: string; completed_by_name: string | null; notes: string | null; created_at: string | null }
export interface RoomHistory { hotel_id: string; room: string; period_start: string; completed_on: string | null; source_name: string | null; source_reference: string | null }
export function historyHref(record: RoomHistory) { return `/management/rooms/record?kind=history&hotel=${encodeURIComponent(record.hotel_id)}&room=${encodeURIComponent(record.room)}&period=${encodeURIComponent(record.period_start)}`; }
export function workOrderHref(id: string) { return `/work-orders/${encodeURIComponent(id)}`; }
export interface PmLog { id: string; template_id: string; period_start: string; scope_key: string; status: string; updated_at: string }
export interface EquipmentForm { location_id: string; template_id: string; title: string; cadence: string; months?: number[] | null; asset_names: string[]; asset_ids: string[]; evidence: string[]; item_ids: string[]; source: string }
export interface EquipmentAssociations { forms: EquipmentForm[]; log_links: {log_id: string; location_id: string; row_index: number; recorded_location: string}[]; counts: {unmatched_logs: number; unresolved_rows: number; logs_without_confirmed_location: number} }
export function equipmentFormHref(form: EquipmentForm) { return `/management/rooms/record?kind=form&location=${encodeURIComponent(form.location_id)}&template=${encodeURIComponent(form.template_id)}`; }
export function equipmentLogHref(id: string) { return `/management/rooms/record?kind=log&id=${encodeURIComponent(id)}`; }
// Source cadence labels are form availability, not newly created operational due dates.
export function formPeriods(form: EquipmentForm, date: string) {
  const day = new Date(`${date}T12:00:00Z`), key = (d: Date)=>d.toISOString().slice(0,10);
  if(form.cadence==='daily') { const next=new Date(day);next.setUTCDate(next.getUTCDate()+1);return {current:date,next:key(next)}; }
  if(form.cadence==='weekly') {day.setUTCDate(day.getUTCDate()-((day.getUTCDay()+6)%7));const next=new Date(day);next.setUTCDate(next.getUTCDate()+7);return {current:key(day),next:key(next)};}
  const months=form.months?.length?form.months:[1,2,3,4,5,6,7,8,9,10,11,12];
  const periods=[day.getUTCFullYear()-1,day.getUTCFullYear(),day.getUTCFullYear()+1].flatMap(y=>months.map(m=>`${y}-${String(m).padStart(2,'0')}-01`)).sort();
  return {current:periods.filter(p=>p<=date).at(-1)!,next:periods.find(p=>p>date)!};
}
export interface Snapshot {
  locations: Location[]; work_orders: WorkOrder[]; pm_plans: PmPlan[]; pm_completions: PmCompletion[];
  room_history: RoomHistory[]; pm_logs: PmLog[];
  equipment?: EquipmentAssociations;
}
export interface LocationInput { name: string; area: string; location_type: string }
export function displayName(location: Location) { return location.name || (location.room_number ? `Room ${location.room_number}` : 'Unnamed location'); }
const natural = (a: string, b: string) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'});
export function recordedOptions(locations: Location[]) {
  return {
    areas: [...new Set(locations.map(l => l.area).filter((v): v is string => !!v))].sort(natural),
    types: [...new Set(locations.map(l => l.location_type).filter((v): v is string => !!v))].sort(natural),
  };
}
export function groupedLocations(locations: Location[]) {
  const groups = new Map<string, Location[]>();
  for (const location of locations) { const area = location.area || ''; groups.set(area, [...(groups.get(area) || []), location]); }
  return [...groups].sort(([a], [b]) => a === 'Guest Rooms' ? -1 : b === 'Guest Rooms' ? 1 : natural(a,b))
    .map(([area, items]) => ({area, locations: items.sort((a,b) => natural(displayName(a),displayName(b)))}));
}
// POST and PATCH are deliberately separate. Existing identities and room keys never come from the form.
export function prepareLocation(method: 'POST' | 'PATCH', body: Record<string, unknown>, locations: Location[], source: Location[], newId: () => string): Location {
  const options = recordedOptions(source);
  let existing: Location | undefined;
  if (method === 'POST') {
    if ('id' in body) throw new Error('Add cannot include an existing location ID.');
  } else {
    if (typeof body.id !== 'string' || !body.id) throw new Error('Choose an existing location to edit.');
    existing = locations.find(l => l.id === body.id);
    if (!existing) throw new Error('That location no longer exists.');
  }
  if ('room_number' in body) throw new Error('Use the single location-name field. Existing room keys are preserved.');
  const input: LocationInput = {name:'', area:'', location_type:''};
  for (const field of ['name','area','location_type'] as const) {
    if (typeof body[field] !== 'string') throw new Error(`${field} is required.`);
    const value = (body[field] as string).trim();
    if (!value || value.length > 200) throw new Error(`${field} must contain 1–200 characters.`);
    input[field] = value;
  }
  if (!options.areas.includes(input.area)) throw new Error('Choose a recorded area.');
  if (!options.types.includes(input.location_type)) throw new Error('Choose a recorded location type.');
  if (locations.some(l => l.id !== existing?.id && l.area === input.area && displayName(l).toLocaleLowerCase() === input.name.toLocaleLowerCase())) throw new Error('A location with that name already exists in this area.');
  let roomNumber = existing?.room_number ?? null;
  if (!existing && input.location_type === 'Guest Room') {
    const room = /^(?:Room\s+)?(\d{2,4})$/i.exec(input.name);
    if (!room) throw new Error('For a new guest room, enter its room number as the location name, for example Room 501.');
    roomNumber = room[1];
    if (locations.some(l => l.location_type === 'Guest Room' && l.room_number === roomNumber)) throw new Error('That guest room already exists. Select it to edit.');
  }
  return {...existing, id:existing?.id || newId(), ...input, room_number:roomNumber, active:existing?.active ?? true};
}
export function associatedActivity(snapshot: Snapshot, selected: Location[], area?: string) {
  const ids = new Set(selected.map(l => l.id));
  // History follows the recorded original room identity, even after a name/type edit.
  const originalRooms = snapshot.locations.filter(l => ids.has(l.id) && l.room_number);
  const roomKeys = new Set(originalRooms.map(l => l.room_number));
  const plans = snapshot.pm_plans.filter(p => !!p.location_id && ids.has(p.location_id));
  const planIds = new Set(plans.map(p => p.id));
  const scopes = new Set([...ids].map(id => `location:${id}`));
  for (const room of roomKeys) scopes.add(`room:${room}`);
  if (area !== undefined) scopes.add(`area:${area}`);
  const logLinks=snapshot.equipment?.log_links.filter(l=>ids.has(l.location_id)) || [];
  const logIds=new Set(logLinks.map(l=>l.log_id));
  return {
    plans,
    completions: snapshot.pm_completions.filter(c => planIds.has(c.pm_plan_id)),
    tickets: snapshot.work_orders.filter(t => !!t.location_id && ids.has(t.location_id)),
    history: snapshot.room_history.filter(h => roomKeys.has(h.room)).sort((a,b) => (b.completed_on || b.period_start).localeCompare(a.completed_on || a.period_start)),
    logs: snapshot.pm_logs.filter(l => scopes.has(l.scope_key)||logIds.has(l.id)),
    logLinks,
    forms: snapshot.equipment?.forms.filter(f=>ids.has(f.location_id)) || [],
  };
}
