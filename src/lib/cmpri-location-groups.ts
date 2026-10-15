export type CommonAreaLocation = { id: string; name: string; area?: string | null; location_type?: string | null; room_number?: string | null; active?: boolean | null };
export function cmpriLocationSection(location: CommonAreaLocation) {
  const area = (location.area || "").toLowerCase();
  const name = (location.name || "").toLowerCase();
  const type = (location.location_type || "").toLowerCase().replace(/[_-]+/g, " ");

  if (type.includes("guest room") || area.includes("guest room") || /^room\s*\d+/i.test(location.name)) return "Guest Rooms";
  if (area.includes("electrical") || name.includes("electrical closet")) return "Electrical Closets";
  if (area.includes("elevator") || name.includes("elevator")) return "Elevators / Vertical Transport";

  // Guest Laundry is guest-facing and belongs with public areas, not BOH laundry.
  if (name === "guest laundry" || area === "guest laundry") return "Main Guest / Public Areas";

  if (
    area.includes("lobby") ||
    area.includes("public restroom") ||
    name.includes("lobby") ||
    name.includes("front desk") ||
    name.includes("breakfast area") ||
    name.includes("study") ||
    name.includes("public men's restroom") ||
    name.includes("public women's restroom")
  ) return "Main Guest / Public Areas";

  if (
    area.includes("back office") ||
    name.includes("manager office") ||
    name.includes("sales office") ||
    name.includes("back office") ||
    name.includes("conference room")
  ) return "Office / Administrative";

  if (
    area.includes("kitchen") ||
    area.includes("pantry") ||
    name.includes("kitchen") ||
    name.includes("pantry") ||
    name.includes("breakfast prep")
  ) return "Food / Service";

  if (area.includes("pool") || area.includes("fitness") || name === "pool area" || name.includes("fitness")) {
    if (name.includes("pump room") || name.includes("conditioner room")) return "Maintenance / Mechanical";
    return "Recreation / Amenities";
  }

  if (
    area.includes("housekeeping") ||
    area.includes("laundry") ||
    area.includes("break room") ||
    name.includes("housekeeping") ||
    name.includes("boh laundry") ||
    name.includes("supply closet") ||
    name.includes("break room")
  ) return "Housekeeping / Laundry / BOH";

  if (
    area.includes("maintenance") ||
    area.includes("boiler") ||
    area.includes("pbx") ||
    area.includes("fire pump") ||
    name.includes("maintenance shop") ||
    name.includes("boiler room") ||
    name.includes("pbx room") ||
    name.includes("fire pump room") ||
    name.includes("mechanical")
  ) return "Maintenance / Mechanical";

  if (
    area.includes("entrance") ||
    area.includes("parking") ||
    area.includes("exterior") ||
    area.includes("roof") ||
    name.includes("entry") ||
    name.includes("parking") ||
    name.includes("exterior") ||
    name.includes("roof") ||
    name.includes("ground floor")
  ) return "Building Entrances / Exterior";

  return "Other Building Areas";
}

/** Front Desk reports may explicitly use same-property common-area equipment. */
export function frontDeskCommonArea(ticket: CommonAreaLocation | undefined, physical: CommonAreaLocation | undefined) {
  if (!ticket || !physical || physical.active === false || ticket.name.trim().toLowerCase() !== "front desk") return false;
  if (/^\d{3,4}$/.test(physical.room_number || "")) return false;
  return cmpriLocationSection(physical) !== "Guest Rooms";
}
