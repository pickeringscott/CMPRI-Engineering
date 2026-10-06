import {
  assetTermsForPlumbingIssue,
  categoryFromIssue,
  priorityForCategory,
} from "./work-order-suggestions";

export type WorkOrderLocation = {
  id: string;
  area: string;
  name: string;
  room_number: string | null;
  location_type: string;
  room_status?: string | null;
};

export type RelatedIssueSuggestion = {
  key: string;
  title: string;
  issue: string;
  assetName: string;
  assetTerms: string[];
  category: string;
  priority: string;
  locationId?: string | null;
  locationName?: string;
};

export function findLocationFromText(text: string, locations: WorkOrderLocation[]) {
  const value = text.toLowerCase().trim();
  const explicitRoom = value.match(/\b(?:room|rm)\s*#?\s*(\d{3})\b/i);
  const leadingRoom = value.match(/^\s*#?(\d{3})\b/);
  const inRoom = value.match(/\bin\s+(?:room\s*)?#?(\d{3})\b/i);
  const roomNumber = explicitRoom?.[1] || leadingRoom?.[1] || inRoom?.[1];

  if (roomNumber) {
    const room = locations.find((location) =>
      location.room_number === roomNumber ||
      location.name.toLowerCase() === `room ${roomNumber}`);
    if (room) return room;
  }

  const namedLocations = [
    ["pool pump room", "Pool Pump Room"],
    ["pool area", "Pool Area"],
    ["pool", "Pool Area"],
    ["guest laundry", "Guest Laundry"],
    ["boh laundry", "BoH Laundry"],
    ["back of house laundry", "BoH Laundry"],
    ["fitness area", "Fitness Area"],
    ["fitness room", "Fitness Area"],
    ["maintenance shop", "Maintenance Shop"],
    ["conference room", "Conference Room"],
    ["fire pump", "Fire Pump"],
    ["pbx", "PBX"],
    ["lobby", "Lobby / General"],
  ];

  for (const [phrase, locationName] of namedLocations) {
    if (value.includes(phrase)) {
      const location = locations.find((item) =>
        item.name.toLowerCase() === locationName.toLowerCase());
      if (location) return location;
    }
  }

  return undefined;
}

function capitalizeIssue(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.replace(/[A-Za-z]/, (letter) => letter.toUpperCase());
}

function capitalizeIssuePreservingWhitespace(text: string) {
  return text.replace(/[A-Za-z]/, (letter) => letter.toUpperCase());
}

export function cleanIssueLocationPrefix(
  text: string,
  locations: WorkOrderLocation[],
  selectedLocation?: WorkOrderLocation | null,
) {
  const detectedLocation = findLocationFromText(text, locations);
  const location = detectedLocation || selectedLocation || null;
  const leadingRoom = text.match(/^\s*(?:room|rm)?\s*#?\s*(\d{3})\b\s*[-:,.]?\s*/i)?.[1] || "";
  const room =
    detectedLocation?.room_number ||
    detectedLocation?.name.match(/\b(\d{3})\b/)?.[1] ||
    selectedLocation?.room_number ||
    selectedLocation?.name.match(/\b(\d{3})\b/)?.[1] ||
    leadingRoom;

  let cleaned = text;
  if (room) {
    const prefix = new RegExp(`^\\s*(?:room|rm)?\\s*#?\\s*${room}\\b\\s*[-:,.]?\\s*`, "i");
    const suffix = new RegExp(`\\s+\\bin\\s+(?:room\\s*)?#?${room}\\b\\s*$`, "i");
    cleaned = cleaned.replace(prefix, "").replace(suffix, "").trim();
  }

  if (!cleaned && /^\s*(?:room|rm)?\s*#?\s*\d{3}\s*$/i.test(text)) {
    cleaned = text.trim();
  }

  return { location, issue: capitalizeIssue(cleaned || text) };
}

export function createSuggestionFromIssueClause(
  clause: string,
  index: number,
  locations: WorkOrderLocation[] = [],
  fallbackLocation?: WorkOrderLocation | null,
): RelatedIssueSuggestion {
  const { location: detectedLocation, issue: strippedPrefix } =
    cleanIssueLocationPrefix(clause.trim().replace(/^[-,:.\s]+/, ""), locations);
  const resolvedLocation = detectedLocation || fallbackLocation || null;
  const cleaned = capitalizeIssuePreservingWhitespace(strippedPrefix);
  const category = categoryFromIssue(cleaned) || "General";
  const lower = cleaned.toLowerCase();

  let assetName = "General Maintenance";
  let assetTerms: string[] = [];

  if (/\b(tv|television|screen|no signal|black screen)\b/.test(lower)) {
    assetName = "TV";
    assetTerms = ["tv", "television", "enseo"];
  } else if (/\b(cool|cooling|heat|heating|hvac|thermostat|air conditioner|ac|vtac|ptac)\b/.test(lower)) {
    assetName = "Room HVAC";
    assetTerms = ["vtac", "ptac", "hvac", "friedrich", "zoneline", "air conditioner"];
  } else if (/\b(toilet|sink|faucet|shower|drain|pipe|leak|plumbing)\b/.test(lower)) {
    assetName = "Plumbing Fixture";
    assetTerms = assetTermsForPlumbingIssue(cleaned);
  } else if (/\b(light|bulb|lamp|outlet|switch|electrical)\b/.test(lower)) {
    assetName = "Electrical / Lighting";
    assetTerms = ["light", "lighting", "fixture", "outlet", "switch"];
  } else if (/\b(pool|humidity|humid|dehumid|ventilation|exhaust)\b/.test(lower)) {
    assetName = "Pool HVAC / Ventilation";
    assetTerms = ["dehumid", "ventilation", "exhaust", "hvac", "pool"];
  } else if (/\b(fridge|refrigerator)\b/.test(lower)) {
    assetName = "Refrigerator";
    assetTerms = ["refrigerator", "fridge"];
  } else if (/\b(lock|keycard|key card|saflok)\b/.test(lower)) {
    assetName = "Door Lock";
    assetTerms = ["lock", "saflok", "dormakaba"];
  }

  return {
    key: `create-${index}-${cleaned.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
    title: cleaned,
    issue: cleaned,
    assetName,
    assetTerms,
    category,
    priority: priorityForCategory(category),
    locationId: resolvedLocation?.id ?? null,
    locationName: resolvedLocation?.name ?? "",
  };
}

export function splitMaintenanceIssueClauses(value: string) {
  const hasExplicitSeparator = /(?:\n+|;|\s*\|\s*|,\s+|\s+\band\s+)/i.test(value);
  const explicit = value
    .split(/(?:\n+|;|\s*\|\s*|,\s+|\s+\band\b\s+)/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3);

  const starter = /\b(?:not\s+cooling|not\s+heating|no\s+cooling|no\s+heat|too\s+humid|humidity|(?:bathroom\s+)?sink\s+leak(?:ing)?|bathroom\s+sink|kitchen\s+sink|sink|toilet|faucet|shower|drain|leak(?:ing)?|bedroom\s+tv|living\s+room\s+tv|tv|television|light(?:ing)?|outlet|door\s+lock|keycard|refrigerator|fridge|pool\s+pump|pool\s+filter)\b/gi;
  const output: string[] = [];
  for (const piece of explicit) {
    const starts: number[] = [];
    starter.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = starter.exec(piece))) {
      if (!starts.length || (!hasExplicitSeparator && match.index > starts[starts.length - 1])) {
        starts.push(match.index);
      }
    }

    if (starts.length < 2) {
      output.push(piece);
      continue;
    }

    const firstStart = starts[0];
    const boundaries = [0, ...starts.slice(1)];
    for (let i = 0; i < boundaries.length; i += 1) {
      const start = boundaries[i];
      const end = i + 1 < boundaries.length ? boundaries[i + 1] : piece.length;
      const clause = piece.slice(start, end).trim().replace(/^[,;:\-]+|[,;:\-]+$/g, "").trim();
      if (clause.length >= 3) output.push(clause);
    }

    if (firstStart > 0 && output.length) {
      const prefix = piece.slice(0, firstStart).trim();
      if (prefix && !output[output.length - boundaries.length].startsWith(prefix)) {
        output[output.length - boundaries.length] = `${prefix} ${output[output.length - boundaries.length]}`.trim();
      }
    }
  }
  return output;
}

export function detectMultipleCreateIssues(
  issue: string,
  locations: WorkOrderLocation[] = [],
  fallbackLocation?: WorkOrderLocation | null,
): RelatedIssueSuggestion[] {
  const source = issue.trim();
  if (!source) return [];

  const pieces = splitMaintenanceIssueClauses(source);
  if (pieces.length < 2) return [];

  const suggestions = pieces.map((piece, index) =>
    createSuggestionFromIssueClause(piece, index, locations, fallbackLocation));
  const meaningful = suggestions.filter((item) => item.category !== "General").length;
  if (meaningful < 2) return [];
  return suggestions;
}
