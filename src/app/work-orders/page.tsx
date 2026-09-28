"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ModalNavigationButton from "@/components/ModalNavigationButton";
import { useRouter } from "next/navigation";
import { getValidSession, signOutDevice } from "@/lib/supabase/client";
import { loadCmpriSession, type CmpriClientSession } from "@/lib/auth/client-session";
import AccountSummary from "@/components/AccountSummary";
import { dashboardTitleForRole } from "@/lib/account-display";

import SearchableSelect from "@/components/SearchableSelect";
import { classifyAsset } from "@/lib/asset-category";
import { priorityForCategory, categoryFromIssue, inferWorkOrder, assetTermsForPlumbingIssue } from "@/lib/work-order-suggestions";
import { categoryOptions } from "@/lib/work-order-categories";
import { validFirstName } from "@/lib/work-order-attribution";
import { likelyDuplicate } from "@/lib/work-order-duplicates";
import { normalizeManualKnowledge, type ManualKnowledge } from "@/lib/manual-knowledge";

type Location = {
  id: string;
  area: string;
  name: string;
  room_number: string | null;
  location_type: string;
};


type WorkOrderDraft = {
  id: string;
  created_by: string;
  creator_name?: string | null;
  creator_role?: string | null;
  can_delete?: boolean;
  staff_first_name?: string | null;
  location_id: string;
  room?: string | null;
  issue: string;
  notes?: string | null;
  asset_id?: string | null;
  asset_name?: string | null;
  category?: string | null;
  priority?: string | null;
  revision: number;
  updated_at?: string | null;
};
type Asset = {
  id: string;
  location_id: string | null;
  asset_type: string;
  name: string;
  asset_tag: string | null;
  active: boolean;
  status: string;
  manufacturer: string | null;
  model_number: string | null;
  serial_number: string | null;
  generation: string | null;
  install_year: number | null;
  documentation_key: string | null;
};

const GENERAL_TROUBLESHOOTING_CHECKS = [
  "Confirm the reported problem and reproduce it if safe to do so.",
  "Inspect the affected equipment or area for obvious damage or abnormal condition.",
  "Record error messages, noises, odors, leaks, temperatures, pressures, or other useful symptoms.",
  "Determine whether the problem is isolated or affects other areas.",
  "Check verified equipment documentation before replacing parts or changing settings.",
  "Document findings and any tests already performed.",
];

type WorkOrder = {
  id: string;
  display_id: string;
  room: string;
  location_id: string | null;
  asset_id: string | null;
  asset_name: string;
  category: string;
  issue: string;
  priority: string;
  technician_name: string;
  status: string;
  notes: string;
  logged_on: string;
  due_by: string | null;
  creator_name: string;
};








type RelatedIssueSuggestion = {
  key: string;
  title: string;
  issue: string;
  assetName: string;
  assetTerms: string[];
  category: string;
  priority: string;
};

type NotesAnalysis = {
  detectedCode: string | null;
  troubleshootingDocumented: boolean;
  relatedIssues: RelatedIssueSuggestion[];
};

const CMPRI_LOCATION_SECTION_ORDER: Record<string, number> = {
  "Main Guest / Public Areas": 10,
  "Office / Administrative": 20,
  "Food / Service": 30,
  "Recreation / Amenities": 40,
  "Housekeeping / Laundry / BOH": 50,
  "Maintenance / Mechanical": 60,
  "Building Entrances / Exterior": 70,
  "Elevators / Vertical Transport": 80,
  "Other Building Areas": 90,
  "Guest Rooms": 100,
  "Electrical Closets": 110,
};

function cmpriLocationSection(location: Location) {
  const area = (location.area || "").toLowerCase();
  const name = (location.name || "").toLowerCase();
  const type = (location.location_type || "").toLowerCase();

  if (type.includes("guest room") || area.includes("guest room") || /^room\s+\d+/i.test(location.name)) return "Guest Rooms";
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

function cmpriNaturalNumber(value: string | null | undefined) {
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}

function cmpriLocationWithinSectionRank(location: Location) {
  const name = (location.name || "").toLowerCase();
  const area = (location.area || "").toLowerCase();

  // Public/guest-facing areas.
  const preferred = [
    "lobby / general",
    "front desk",
    "main lobby vestibule",
    "breakfast area",
    "study area 1",
    "study area 2",
    "study area 3",
    "guest laundry",
    "conference room",
    "general manager office",
    "assistant manager office",
    "sales office",
    "back office / general",
    "kitchen",
    "pantry",
    "pool area",
    "fitness area",
    "boh laundry",
    "maintenance shop",
    "pool pump room",
    "pbx room",
    "fire pump room",
    "boiler room",
  ];

  const exact = preferred.indexOf(name);
  if (exact >= 0) return exact;

  // Other Building Areas: put floor hallways in floor order near the top.
  if (name.includes("floor hall") || area.includes("floor hall")) {
    return 100 + cmpriNaturalNumber(name);
  }

  // Building Entrances / Exterior: entrances first, then grounds/parking,
  // then ground-floor-labeled items, with roof locations at the bottom.
  if (name.includes("main entry") || name.includes("main entrance")) return 200;
  if (name.includes("north entry") || name.includes("north entrance")) return 210;
  if (name.includes("south entry") || name.includes("south entrance")) return 220;
  if (name.includes("entry") || name.includes("entrance")) return 230;
  if (name.includes("exterior brand signage")) return 240;
  if (name.includes("exterior") || name.includes("property grounds")) return 250;
  if (name.includes("parking")) return 260;
  if (name.includes("ground floor")) return 880;
  if (name.includes("lower roof")) return 920;
  if (name.includes("roof")) return 950;

  return 500;
}
function assetsForLocation(
  location: Location | undefined,
  assets: Asset[]
) {
  if (!location) {
    return [];
  }

  return assets.filter((asset) => asset.location_id === location.id);
}

function findLocationFromText(
  text: string,
  locations: Location[]
) {
  const value = text.toLowerCase().trim();

  const explicitRoom =
    value.match(/\b(?:room|rm)\s*#?\s*(\d{3})\b/i);

  const leadingRoom =
    value.match(/^\s*#?(\d{3})\b/);

  const inRoom =
    value.match(/\bin\s+(?:room\s*)?#?(\d{3})\b/i);

  const roomNumber =
    explicitRoom?.[1] ||
    leadingRoom?.[1] ||
    inRoom?.[1];

  if (roomNumber) {
    const room =
      locations.find(
        (location) =>
          location.room_number === roomNumber ||
          location.name.toLowerCase() ===
            `room ${roomNumber}`
      );

    if (room) {
      return room;
    }
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
      const location =
        locations.find(
          (item) =>
            item.name.toLowerCase() ===
            locationName.toLowerCase()
        );

      if (location) {
        return location;
      }
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

function cleanIssueLocationPrefix(text: string, locations: Location[], selectedLocation?: Location | null) {
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


function analyzeTechnicianNotes(
  notes: string
): NotesAnalysis {
  const value = notes.toLowerCase();

  const code =
    extractReportedErrorCode(notes);

  const troubleshootingDocumented =
    /\b(checked|tested|verified|measured|replaced|reset|cleaned|tightened|repaired|adjusted|diagnosed|diagnosed|found|inspected|removed|installed|confirmed|voltage|vac|ohm|continuity|pressure|temperature)\b/i.test(
      notes
    );

  const relatedIssues: RelatedIssueSuggestion[] = [];

  const addSuggestion = (
    suggestion: RelatedIssueSuggestion
  ) => {
    if (
      !relatedIssues.some(
        (item) => item.key === suggestion.key
      )
    ) {
      relatedIssues.push(suggestion);
    }
  };

  /*
   * These rules intentionally look for "extra issue" language
   * before suggesting another ticket. We do not silently create
   * tickets from every noun that appears in a technician note.
   */
  const looksLikeAdditionalObservation =
    /\b(also|additionally|another|noticed|while there|while in room|separately|as well)\b/i.test(
      notes
    );

  if (looksLikeAdditionalObservation) {
    if (
      /\b(refrigerator|fridge)\b/.test(value) &&
      /\b(noise|noisy|grind|grinding|rattle|rattling|buzz|buzzing|hum|humming|knock|knocking|loud)\b/.test(
        value
      )
    ) {
      addSuggestion({
        key: "refrigerator-noise",
        title: "Refrigerator making unusual noise",
        issue: "Refrigerator making unusual noise",
        assetName: "Refrigerator",
        assetTerms: ["refrigerator", "fridge"],
        category: "Appliances",
        priority: "Medium",
      });
    }

    if (
      /\b(light|light bulb|bulb|lamp|vanity light)\b/.test(
        value
      ) &&
      /\b(out|burned out|burnt out|not working|dead|flicker|flickering)\b/.test(
        value
      )
    ) {
      addSuggestion({
        key: "light-out",
        title: "Light / bulb not working",
        issue: "Light / bulb not working",
        assetName: "Light Fixture",
        assetTerms: ["light", "lighting", "fixture"],
        category: "Electrical",
        priority: "Low",
      });
    }

    if (
      /\b(tv|television)\b/.test(value) &&
      /\b(no signal|not working|black screen|no picture|no power)\b/.test(
        value
      )
    ) {
      addSuggestion({
        key: "tv-problem",
        title: "TV problem",
        issue: "TV problem reported during maintenance visit",
        assetName: "TV",
        assetTerms: ["tv", "television", "enseo"],
        category: "TV / AV",
        priority: "Medium",
      });
    }

    if (
      /\b(toilet|sink|faucet|shower|pipe|drain)\b/.test(
        value
      ) &&
      /\b(leak|leaking|drip|dripping|clog|clogged|slow drain)\b/.test(
        value
      )
    ) {
      addSuggestion({
        key: "plumbing-extra",
        title: "Additional plumbing issue",
        issue: "Additional plumbing issue noticed during maintenance visit",
        assetName: "Plumbing Fixture",
        assetTerms: [
          "plumbing",
          "shower",
          "faucet",
          "sink",
          "toilet",
          "drain",
        ],
        category: "Plumbing",
        priority: "Medium",
      });
    }

    if (
      /\b(door lock|lock|keycard|key card|saflok)\b/.test(
        value
      ) &&
      /\b(not working|won't lock|will not lock|won't unlock|will not unlock|dead|failed)\b/.test(
        value
      )
    ) {
      addSuggestion({
        key: "door-lock",
        title: "Door lock / key-card issue",
        issue: "Door lock / key-card issue noticed during maintenance visit",
        assetName: "DormaKaba Saflok RFID Lock",
        assetTerms: ["saflok", "dormakaba", "lock"],
        category: "Doors/Locks",
        priority: "High",
      });
    }
  }

  return {
    detectedCode: code,
    troubleshootingDocumented,
    relatedIssues,
  };
}



function createSuggestionFromIssueClause(
  clause: string,
  index: number
): RelatedIssueSuggestion {
  const strippedPrefix = cleanIssueLocationPrefix(clause.trim().replace(/^[-,:.\s]+/, ""), [] as Location[]).issue;
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

    // Preserve a leading room/location token with the first detected issue.
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

export function detectMultipleCreateIssues(issue: string): RelatedIssueSuggestion[] {
  const source = issue.trim();
  if (!source) return [];

  const pieces = splitMaintenanceIssueClauses(source);
  if (pieces.length < 2) return [];

  const suggestions = pieces.map(createSuggestionFromIssueClause);
  const meaningful = suggestions.filter((item) => item.category !== "General").length;

  // Multiple independent maintenance signatures are required, but punctuation
  // is not. This lets natural front-desk reports such as "not cooling bathroom
  // sink leaking bedroom TV fucked" become three reviewable work orders.
  if (meaningful < 2) return [];
  return suggestions;
}

function categoryForAsset(asset: Asset) { return classifyAsset(asset); }

function extractReportedErrorCode(
  issue: string
) {
  const text =
    issue.trim().toLowerCase();

  const matches = [
    text.match(
      /\bcode\s*[:#-]?\s*(\d{1,2})\b/i
    ),
    text.match(
      /\berror\s*[:#-]?\s*(\d{1,2})\b/i
    ),
    text.match(
      /\bfault\s*[:#-]?\s*(\d{1,2})\b/i
    ),
  ];

  for (const match of matches) {
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}


export default function WorkOrdersPage() {
  const router = useRouter();
  const [
    locations,
    setLocations,
  ] = useState<Location[]>([]);

  const [
    assets,
    setAssets,
  ] = useState<Asset[]>([]);

  const [
    workOrders,
    setWorkOrders,
  ] = useState<WorkOrder[]>([]);

  const [
    locationId,
    setLocationId,
  ] = useState("");

  const [
    assetId,
    setAssetId,
  ] = useState("");

  const [
    category,
    setCategory,
  ] = useState("General");

  const [
    issue,
    setIssue,
  ] = useState("");

  const [
    priority,
    setPriority,
  ] = useState("Medium");

  const [
    notes,
    setNotes,
  ] = useState("");

  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUploadError, setPhotoUploadError] = useState("");

  const [
    manualLocation,
    setManualLocation,
  ] = useState(false);

  const [
    manualAsset,
    setManualAsset,
  ] = useState(false);

  const [
    manualCategory,
    setManualCategory,
  ] = useState(false);

  const [
    manualPriority,
    setManualPriority,
  ] = useState(false);



  const [
    message,
    setMessage,
  ] = useState("");

  const [
    loading,
    setLoading,
  ] = useState(false);

  const [
    loadingLocations,
    setLoadingLocations,
  ] = useState(true);

  const [
    loadingAssets,
    setLoadingAssets,
  ] = useState(true);

  const [
    showRelatedWorkOrderDialog,
    setShowRelatedWorkOrderDialog,
  ] = useState(false);

  const [
    creatingRelatedWorkOrders,
    setCreatingRelatedWorkOrders,
  ] = useState(false);

  const [
    mainWorkOrderCreated,
    setMainWorkOrderCreated,
  ] = useState(false);

  const [batchCreateSuggestions, setBatchCreateSuggestions] = useState<RelatedIssueSuggestion[]>([]);
  const [showBatchCreateDialog, setShowBatchCreateDialog] = useState(false);
  const [creatingBatchWorkOrders, setCreatingBatchWorkOrders] = useState(false);

  const [embedded] = useState(() => typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("embedded") === "1"
    && window.parent !== window);
  const [modalToken] = useState(() => typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("modalToken") || ""
    : "");
  const [createState, setCreateState] = useState<"idle" | "creating" | "created">("idle");
  const [currentRole, setCurrentRole] = useState("");
  const [troubleshootingResult, setTroubleshootingResult] = useState<{
    assetKey: string;
    knowledge: ManualKnowledge | null;
    error: string;
  } | null>(null);
  const [formLanguage, setFormLanguage] = useState<"en" | "es">(() => {
    if (typeof window === "undefined") return "en";
    try {
      const saved = window.localStorage.getItem("cmpri:work-order-language");
      return saved === "es" ? "es" : "en";
    } catch {
      return "en";
    }
  });
  const [staffFirstName, setStaffFirstName] = useState("");
  const [cmpriSession, setCmpriSession] = useState<CmpriClientSession | null>(null);
  const [drafts, setDrafts] = useState<WorkOrderDraft[]>([]);
  const [activeDraftId, setActiveDraftId] = useState("");
  const [activeDraftRevision, setActiveDraftRevision] = useState<number | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);



  const apiHeaders = useCallback(async (includeJson = false) => {
    const session = await getValidSession();
    if (!session?.access_token) throw new Error("Sign in again to continue.");
    return {
      ...(includeJson ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${session.access_token}`,
    };
  }, []);

  async function signOut() {
    await signOutDevice();
    if (embedded && modalToken && window.parent !== window) {
      window.parent.postMessage({ type: "cmpri-modal-sign-out", modalToken }, window.location.origin);
    }
    router.replace("/");
  }

  const loadDrafts = useCallback(async () => {
    try {
      const response = await fetch("/api/work-orders/drafts", {
        headers: await apiHeaders(),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Drafts could not be loaded.");
      setDrafts((payload.drafts || []) as WorkOrderDraft[]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Drafts could not be loaded.");
    }
  }, [apiHeaders]);

  async function loadProfilePreference() {
    try {
      const session = await getValidSession();
      if (!session?.access_token) return;
      const response = await fetch("/api/profile", { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json().catch(() => ({}));
      if (payload.preferences?.language === "es" || payload.preferences?.language === "en") setFormLanguage(payload.preferences.language);
    } catch {}
  }


  useEffect(() => {
    if (!showRelatedWorkOrderDialog && !showBatchCreateDialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [showRelatedWorkOrderDialog, showBatchCreateDialog]);

  const loadLocations = useCallback(async () => {
    try {
      const response = await fetch("/api/rooms?mode=create", {
        headers: await apiHeaders(),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload.locations)) {
        throw new Error(payload.error || "Locations could not be loaded.");
      }
      setLocations(payload.locations as Location[]);
    } catch (error) {
      setMessage(`Location error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoadingLocations(false);
    }
  }, [apiHeaders]);

  const loadAssets = useCallback(async () => {
    try {
      const response = await fetch("/api/assets?mode=create", {
        headers: await apiHeaders(),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload.assets)) {
        throw new Error(payload.error || "Equipment could not be loaded.");
      }
      setAssets((payload.assets as Asset[]).filter((asset) => asset.active !== false));
    } catch (error) {
      setMessage(`Asset error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoadingAssets(false);
    }
  }, [apiHeaders]);

  const loadWorkOrders = useCallback(async (canViewCandidates = false) => {
    if (!canViewCandidates) {
      setWorkOrders([]);
      return;
    }
    try {
      const session = await getValidSession();
      const token = session?.access_token;
      if (!token) throw new Error("Sign in again to check existing work orders.");
      const response = await fetch("/api/work-orders?mode=duplicate-candidates", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload.work_orders)) throw new Error(payload.error || "Existing work orders could not be checked.");
      setWorkOrders(payload.work_orders as WorkOrder[]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Existing work orders could not be checked.");
    }
  }, []);

  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const session = await loadCmpriSession();
        if (!current) return;
        if (!session.capabilities.includes("submit")) {
          window.location.replace(session.landing);
          return;
        }
        setCmpriSession(session);
        setCurrentRole(session.user.role || "");
        await Promise.all([
          loadLocations(),
          loadAssets(),
          loadWorkOrders(session.capabilities.includes("view_dashboard")),
          loadDrafts(),
          loadProfilePreference(),
        ]);
      } catch {
        if (current) window.location.replace("/");
      }
    })().catch(() => {
      if (current) {
        setMessage("Could not load work-order data. Please reload.");
        setLoadingLocations(false);
        setLoadingAssets(false);
      }
    });
    return () => { current = false; };
  }, [loadLocations, loadAssets, loadWorkOrders, loadDrafts]);

  const selectedLocation =
    locations.find(
      (location) =>
        location.id === locationId
    );

  const locationAssets = assetsForLocation(selectedLocation, assets);
  const availableAssets = locationAssets;

  const normalizedCurrentRole = currentRole.toLowerCase().replace(/[_-]+/g, " ").trim();
  const currentRoleKey = normalizedCurrentRole.replace(/\s+/g, "");
  const canViewTroubleshootingGuide = [
    "engineer", "engineers", "engineering", "chiefengineer", "engineeringmanager", "regionalmaintenance", "regionalengineer",
    "technician", "maintenancetechnician",
  ].includes(currentRoleKey);
  const isFrontDeskUser = currentRoleKey === "frontdesk";
  const isSubmitOnlyUser = ["front desk", "frontdesk", "housekeeping", "lead housekeeper", "leadhousekeeper", "executive housekeeper", "executivehousekeeper"].includes(normalizedCurrentRole) || ["leadhousekeeper", "executivehousekeeper"].includes(currentRoleKey);
  const selectedCreateAsset = assets.find((item) => item.id === assetId);
  const selectedCreateAssetId = selectedCreateAsset?.id;
  const selectedCreateDocumentationKey = selectedCreateAsset?.documentation_key;
  const troubleshootingAssetKey = selectedCreateAssetId
    ? `${selectedCreateAssetId}:${selectedCreateDocumentationKey || ""}`
    : "";
  const currentTroubleshootingResult = troubleshootingResult?.assetKey === troubleshootingAssetKey
    ? troubleshootingResult
    : null;
  const troubleshootingKnowledge = currentTroubleshootingResult?.knowledge || null;
  const troubleshootingLoading = Boolean(canViewTroubleshootingGuide && selectedCreateAsset && !currentTroubleshootingResult);
  const troubleshootingError = currentTroubleshootingResult?.error || "";

  useEffect(() => {
    let current = true;
    if (!canViewTroubleshootingGuide || !selectedCreateAssetId) {
      return () => { current = false; };
    }

    const assetKey = `${selectedCreateAssetId}:${selectedCreateDocumentationKey || ""}`;
    void (async () => {
      try {
        const session = await getValidSession();
        if (!session?.access_token) throw new Error("Sign in again to load troubleshooting guidance.");
        const response = await fetch(`/api/maintenance-reference?assetId=${encodeURIComponent(selectedCreateAssetId)}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "Troubleshooting guidance could not be loaded.");
        if (current) setTroubleshootingResult({ assetKey, knowledge: normalizeManualKnowledge(payload.manualKnowledge), error: "" });
      } catch (error) {
        if (current) setTroubleshootingResult({ assetKey, knowledge: null, error: error instanceof Error ? error.message : "Troubleshooting guidance could not be loaded." });
      }
    })();

    return () => { current = false; };
  }, [canViewTroubleshootingGuide, selectedCreateAssetId, selectedCreateDocumentationKey]);

  function applySmartSuggestions(
    newIssue: string,
    newNotes: string,
    locationOverride?: Location
  ) {
    const combinedText =
      `${newIssue} ${newNotes}`.trim();

    if (!combinedText) {
      
      return;
    }

    let workingLocation = locationOverride ||
      locations.find(
        (item) =>
          item.id === locationId
      );

    if (!locationOverride && !manualLocation) {
      const detectedLocation =
        findLocationFromText(
          combinedText,
          locations
        );

      if (detectedLocation) {
        workingLocation =
          detectedLocation;

        if (
          detectedLocation.id !==
          locationId
        ) {
          setLocationId(
            detectedLocation.id
          );
        }
      }
    }

    if (!workingLocation) {
      
      return;
    }

    const workingAssets =
      assetsForLocation(
        workingLocation,
        assets
      );

    const suggestion = inferWorkOrder(
      combinedText,
      workingAssets,
    );
    const shouldAutoSelectAsset = !manualAsset || Boolean(locationOverride) || isSubmitOnlyUser;
    if (shouldAutoSelectAsset) setAssetId(suggestion.assetId || "");
    const effectiveAssetId = shouldAutoSelectAsset ? suggestion.assetId : assetId;
    const matchedAsset = workingAssets.find(item => item.id === effectiveAssetId);

    const smartCategory =
      matchedAsset
        ? categoryForAsset(
            matchedAsset
          )
        : suggestion.category;

    if (
      smartCategory &&
      (!manualCategory || locationOverride || isSubmitOnlyUser)
    ) {
      setCategory(
        smartCategory
      );
    }

    if (
      smartCategory &&
      (!manualPriority || locationOverride || isSubmitOnlyUser)
    ) {
      setPriority(
        priorityForCategory(
          smartCategory
        )
      );
    }

    const recognized: string[] = [
      workingLocation.name,
    ];

    if (matchedAsset) {
      recognized.push(
        matchedAsset.name
      );
    }

    if (smartCategory) {
      recognized.push(
        smartCategory
      );
    }

    
  }


  function handleLocationChange(
    newLocationId: string
  ) {
    setManualLocation(true);

    setLocationId(
      newLocationId
    );

    setAssetId("");
    setManualAsset(false);
    setCategory("General");
    setPriority("Medium");

    setManualCategory(false);
    setManualPriority(false);

    

    const nextLocation = locations.find((item) => item.id === newLocationId);
    if (nextLocation && (issue.trim() || notes.trim())) applySmartSuggestions(issue, notes, nextLocation);
  }



  function handleAssetChange(
    newAssetId: string
  ) {
    setManualAsset(true);
    setAssetId(newAssetId);

    if (!newAssetId) {
      const assetlessSuggestion = inferWorkOrder(`${issue} ${notes}`.trim(), assetsForLocation(selectedLocation, assets));
      if (!manualCategory) {
        setCategory(assetlessSuggestion.category || "General");
      }
      if (!manualPriority) {
        setPriority(assetlessSuggestion.priority || "Medium");
      }
      return;
    }

    const asset =
      assets.find(
        (item) =>
          item.id === newAssetId
      );

    if (asset) {
      const newCategory =
        categoryForAsset(asset);

      if (!manualCategory) {
        setCategory(newCategory);
      }

      if (!manualPriority) {
        setPriority(
          priorityForCategory(
            newCategory
          )
        );
      }
    }
  }


  function handleIssueChange(
    newIssue: string
  ) {
    const currentlySelectedLocation =
      locations.find((item) => item.id === locationId) || null;
    const detectedLocation = findLocationFromText(newIssue, locations) || currentlySelectedLocation;

    if (detectedLocation && detectedLocation.id !== locationId) {
      setLocationId(detectedLocation.id);
      setAssetId("");
      setManualLocation(false);
      setManualAsset(false);
      setManualCategory(false);
      setManualPriority(false);
    }

    // Preserve exactly what the user types in the textarea. Room-prefix cleanup
    // happens only when the ticket is submitted, while smart-fill works from a
    // normalized copy in the background.
    setIssue(newIssue);
    const smartIssue = cleanIssueLocationPrefix(newIssue, locations, detectedLocation).issue;
    applySmartSuggestions(smartIssue, notes, detectedLocation?.id !== locationId ? detectedLocation || undefined : undefined);
  }

  function handleNotesChange(
    newNotes: string
  ) {
    setNotes(newNotes);

    applySmartSuggestions(
      issue,
      newNotes
    );
  }



  const notesAnalysis =
    analyzeTechnicianNotes(
      notes
    );

  const relatedIssueSuggestions =
    [
      ...notesAnalysis.relatedIssues,
    ].filter(
      (suggestion, index, all) => {
        const signature =
          `${suggestion.assetName} ${suggestion.issue}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " " )
            .trim();

        return (
          all.findIndex((candidate) => {
            const candidateSignature =
              `${candidate.assetName} ${candidate.issue}`
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, " " )
                .trim();

            const refrigeratorMatch =
              /refrigerator|fridge/.test(signature) &&
              /refrigerator|fridge/.test(candidateSignature);

            const lightMatch =
              /light|bulb|lighting/.test(signature) &&
              /light|bulb|lighting/.test(candidateSignature);

            return (
              candidateSignature === signature ||
              refrigeratorMatch ||
              lightMatch
            );
          }) === index
        );
      }
    );

  function restoreDraft(draft: WorkOrderDraft) {
    setActiveDraftId(draft.id);
    setActiveDraftRevision(draft.revision);
    setStaffFirstName(draft.staff_first_name || "");
    setLocationId(draft.location_id || "");
    setAssetId(draft.asset_id || "");
    setManualAsset(Boolean(draft.asset_id));
    setCategory(draft.category || "General");
    setIssue(draft.issue || "");
    setPriority(draft.priority || "Medium");
    setNotes(draft.notes || "");
    setManualLocation(Boolean(draft.location_id));
    setManualCategory(false);
    setManualPriority(false);
    setMessage(`Draft loaded${draft.creator_name ? ` — ${draft.creator_name}` : ""}.`);
  }

  async function saveDraft(automatic = false) {
    if (!locationId || !issue.trim()) {
      setMessage("Select a room/location and enter the issue before saving a draft.");
      return;
    }
    setDraftBusy(true);
    setMessage("");
    try {
      const selected = locations.find((item) => item.id === locationId);
      const asset = assets.find((item) => item.id === assetId);
      const body = {
        ...(activeDraftId ? { id: activeDraftId, expected_revision: activeDraftRevision } : {}),
        staff_first_name: staffFirstName.trim(),
        location_id: locationId,
        issue: cleanIssueLocationPrefix(issue, locations, selected).issue,
        notes,
        asset_id: isSubmitOnlyUser ? null : (asset?.id || null),
        asset_name: isSubmitOnlyUser ? "" : (asset?.name || ""),
        category: isSubmitOnlyUser ? "General" : category,
        priority: isSubmitOnlyUser ? "Medium" : priority,
      };
      const response = await fetch("/api/work-orders/drafts", {
        method: activeDraftId ? "PATCH" : "POST",
        headers: await apiHeaders(true),
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Draft could not be saved.");
      const saved = payload.draft as WorkOrderDraft;
      setActiveDraftId(saved.id);
      setActiveDraftRevision(saved.revision);
      setMessage(automatic ? "Draft autosaved after 30 minutes of inactivity." : "Draft saved.");
      await loadDrafts();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Draft could not be saved.");
    } finally {
      setDraftBusy(false);
    }
  }

  async function deleteDraft(draft: WorkOrderDraft) {
    if (!draft.can_delete) return;
    setDraftBusy(true);
    try {
      const response = await fetch(`/api/work-orders/drafts?id=${encodeURIComponent(draft.id)}`, {
        method: "DELETE",
        headers: await apiHeaders(),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Draft could not be deleted.");
      if (activeDraftId === draft.id) {
        setActiveDraftId("");
        setActiveDraftRevision(null);
        resetWorkOrderForm();
      }
      await loadDrafts();
      setMessage("Draft deleted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Draft could not be deleted.");
    } finally {
      setDraftBusy(false);
    }
  }

  async function clearSubmittedDraft() {
    if (!activeDraftId) return;
    try {
      await fetch(`/api/work-orders/drafts?id=${encodeURIComponent(activeDraftId)}`, {
        method: "DELETE",
        headers: await apiHeaders(),
      });
      setActiveDraftId("");
      setActiveDraftRevision(null);
      await loadDrafts();
    } catch {
      // Submission succeeded; a stale draft can still be removed from the Drafts panel later.
    }
  }

  function resetWorkOrderForm() {
    setActiveDraftId("");
    setActiveDraftRevision(null);
    setStaffFirstName("");
    setLocationId("");
    setAssetId("");
    setCategory("General");
    setIssue("");
    setPriority("Medium");
    setNotes("");
    setPhoto(null);
    setPhotoUploadError("");

    setManualLocation(false);
    setManualAsset(false);
    setManualCategory(false);
    setManualPriority(false);

    
    setMainWorkOrderCreated(false);
  }

  function notifyCreateModal(type: "cmpri-work-order-cancelled" | "cmpri-work-order-created", displayId?: string) {
    if (!embedded || window.parent === window || !modalToken) return false;
    window.parent.postMessage(
      { type, modalKind: "create", ...(displayId ? { displayId } : {}), modalToken },
      window.location.origin,
    );
    return true;
  }

  function finishCancelCreateForm() {
    resetWorkOrderForm();
    setBatchCreateSuggestions([]);
    setShowBatchCreateDialog(false);
    setShowRelatedWorkOrderDialog(false);
    setCreateState("idle");
    setMessage("");
    setShowCancelConfirm(false);
    if (notifyCreateModal("cmpri-work-order-cancelled")) return;
    if (!isSubmitOnlyUser && cmpriSession?.landing === "/engineering") {
      router.push("/engineering");
    }
  }

  function requestCancelCreateForm() {
    if (createHasUnsavedChanges || activeDraftId) {
      setShowCancelConfirm(true);
      return;
    }
    finishCancelCreateForm();
  }

  const requestCancelCreateFormRef = useRef(requestCancelCreateForm);
  useEffect(() => {
    requestCancelCreateFormRef.current = requestCancelCreateForm;
  });

  useEffect(() => {
    if (!embedded) return;
    const handleModalCancelRequest = (event: Event) => {
      event.preventDefault();
      requestCancelCreateFormRef.current();
    };
    document.addEventListener("cmpri-modal-cancel-request", handleModalCancelRequest);
    return () => document.removeEventListener("cmpri-modal-cancel-request", handleModalCancelRequest);
  }, [embedded]);

  useEffect(() => {
    const updateLanguage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== "cmpri-profile-preferences-updated") return;
      if (event.data.preferences?.language === "en" || event.data.preferences?.language === "es") {
        setFormLanguage(event.data.preferences.language);
      }
    };
    window.addEventListener("message", updateLanguage);
    return () => window.removeEventListener("message", updateLanguage);
  }, []);

  async function confirmCancelCreateForm() {
    if (activeDraftId) {
      setDraftBusy(true);
      try {
        const response = await fetch(`/api/work-orders/drafts?id=${encodeURIComponent(activeDraftId)}`, {
          method: "DELETE",
          headers: await apiHeaders(),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "The draft could not be discarded.");
        await loadDrafts();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "The draft could not be discarded.");
        return;
      } finally {
        setDraftBusy(false);
      }
    }
    finishCancelCreateForm();
  }

  function resolveRelatedAsset(
    suggestion: RelatedIssueSuggestion,
    location: Location
  ) {
    const possibleAssets =
      assetsForLocation(
        location,
        assets
      );

    return possibleAssets.find(
      (asset) => {
        const value =
          `${asset.name} ${asset.asset_type}`.toLowerCase();

        return suggestion.assetTerms.some(
          (term) =>
            value.includes(
              term.toLowerCase()
            )
        );
      }
    );
  }

  function returnSingleBatchSuggestionToForm(suggestion: RelatedIssueSuggestion | null) {
    const location = locations.find((item) => item.id === locationId);
    if (!location) {
      setShowBatchCreateDialog(false);
      setBatchCreateSuggestions([]);
      return;
    }

    if (!suggestion) {
      setShowBatchCreateDialog(false);
      setBatchCreateSuggestions([]);
      return;
    }

    const relatedAsset = resolveRelatedAsset(suggestion, location);
    setIssue(suggestion.issue);
    setCategory(suggestion.category);
    setPriority(suggestion.priority);
    setAssetId(relatedAsset?.id ?? "");
    setManualAsset(Boolean(relatedAsset));
    setShowBatchCreateDialog(false);
    setBatchCreateSuggestions([]);
    setMessage("One proposed work order remains. Review the form and submit it when ready.");
  }

  function handleBatchSuggestionRemoval(index: number) {
    const remaining = batchCreateSuggestions.filter((_, itemIndex) => itemIndex !== index);
    if (remaining.length === 0) {
      setBatchCreateSuggestions([]);
      setShowBatchCreateDialog(false);
      setCreateState("idle");
      return;
    }

    if (remaining.length === 1) {
      returnSingleBatchSuggestionToForm(remaining[0]);
      return;
    }

    setBatchCreateSuggestions(remaining);
  }


  function cancelRelatedWorkOrders() {
    setShowRelatedWorkOrderDialog(false);

    if (mainWorkOrderCreated) {
      resetWorkOrderForm();
      notifyCreateModal("cmpri-work-order-created");
    }
  }

  async function createRelatedWorkOrders() {
    if (isFrontDeskUser && !validFirstName(staffFirstName)) {
      setMessage("Enter your first name before submitting.");
      return;
    }
    const location = locations.find((item) => item.id === locationId);
    if (!location) {
      setMessage("Select the room/location before creating related work orders.");
      return;
    }
    if (!relatedIssueSuggestions.length) {
      setShowRelatedWorkOrderDialog(false);
      return;
    }

    setCreatingRelatedWorkOrders(true);
    setMessage("");
    const rows = relatedIssueSuggestions.map((suggestion) => {
      const relatedAsset = resolveRelatedAsset(suggestion, location);
      return {
        location_id: location.id,
        asset_id: relatedAsset?.id ?? null,
        asset_name: relatedAsset?.name ?? suggestion.assetName,
        category: suggestion.category,
        issue: suggestion.issue,
        priority: suggestion.priority,
        notes: `Created from technician note during maintenance workflow. Original note: ${notes}`,
      };
    });

    const result = await submitWorkOrders(rows);
    if (result.error) {
      setMessage(`Related work order error: ${result.error.message}`);
      setCreatingRelatedWorkOrders(false);
      return;
    }

    const displayIds = result.workOrders.map((item) => item.display_id).filter(Boolean);
    setShowRelatedWorkOrderDialog(false);
    setMessage(isSubmitOnlyUser
      ? `${rows.length} related request${rows.length === 1 ? "" : "s"} submitted for Engineering verification${displayIds.length ? `: ${displayIds.join(", ")}` : "."}`
      : `${rows.length} related work order${rows.length === 1 ? "" : "s"} created${displayIds.length ? `: ${displayIds.join(", ")}` : "."}`);
    await loadWorkOrders(Boolean(cmpriSession?.capabilities.includes("view_dashboard")));
    setCreatingRelatedWorkOrders(false);

    if (mainWorkOrderCreated) {
      resetWorkOrderForm();
      notifyCreateModal("cmpri-work-order-created");
    }
  }


  function possibleDuplicateFor(issueText: string, location: Location, assetIdOverride?: string | null) {
    const candidate = {
      location_id: location.id,
      asset_id: assetIdOverride || undefined,
      issue: issueText,
      status: "Open",
    };

    return workOrders.find((existing) => {
      const existingStatus = String(existing.status || "Open").toLowerCase();
      if (["closed", "duplicate", "will not do", "cancelled", "canceled"].includes(existingStatus)) return false;
      return likelyDuplicate(candidate, {
        location_id: existing.location_id || undefined,
        asset_id: existing.asset_id || undefined,
        issue: existing.issue || "",
        status: existing.status || "Open",
      });
    });
  }

  async function createSingleBatchWorkOrder(suggestion: RelatedIssueSuggestion) {
    if (isFrontDeskUser && !validFirstName(staffFirstName)) {
      setMessage("Enter your first name before submitting.");
      return;
    }
    const location = locations.find((item) => item.id === locationId);
    if (!location) {
      setMessage("Select a room/location before creating this work order.");
      return;
    }

    const relatedAsset = resolveRelatedAsset(suggestion, location);
    const duplicate = possibleDuplicateFor(suggestion.issue, location, relatedAsset?.id ?? null);
    if (duplicate) {
      setMessage(`Possible duplicate detected: ${duplicate.display_id || "existing work order"} — ${duplicate.issue || "similar active issue"}. Review the existing ticket before creating a new one.`);
      return;
    }

    const rows = [{
      location_id: location.id,
      asset_id: relatedAsset?.id ?? null,
      asset_name: relatedAsset?.name ?? suggestion.assetName,
      category: suggestion.category,
      issue: suggestion.issue,
      priority: suggestion.priority,
      notes: notes ? `Submitted individually from a split report. Original note: ${notes}` : "Submitted individually from a split report.",
    }];

    const result = await submitWorkOrders(rows);
    if (result.error) {
      setMessage(result.error.message);
      return;
    }

    const remaining = batchCreateSuggestions.filter((item) => item.key !== suggestion.key);
    if (remaining.length === 0) {
      await clearSubmittedDraft();
      await loadWorkOrders(Boolean(cmpriSession?.capabilities.includes("view_dashboard")));
      setShowBatchCreateDialog(false);
      setBatchCreateSuggestions([]);
      setCreateState("created");
      setMessage(isSubmitOnlyUser
        ? "Request submitted for Engineering verification."
        : "Work order created.");
      window.setTimeout(() => {
        resetWorkOrderForm();
        setBatchCreateSuggestions([]);
        setCreateState("idle");
        notifyCreateModal("cmpri-work-order-created", result.workOrders[0]?.display_id);
      }, 900);
      return;
    }

    if (remaining.length === 1) {
      returnSingleBatchSuggestionToForm(remaining[0]);
      setMessage(isSubmitOnlyUser
        ? "Request submitted for Engineering verification. One remaining issue has been returned to the form for review."
        : "Work order created. One remaining issue has been returned to the form for review.");
      return;
    }

    setBatchCreateSuggestions(remaining);
    setMessage(isSubmitOnlyUser
      ? "Request submitted for Engineering verification."
      : "Work order created.");
  }

  async function createBatchWorkOrders() {
    if (isFrontDeskUser && !validFirstName(staffFirstName)) {
      setMessage("Enter your first name before submitting.");
      return;
    }
    const location = locations.find((item) => item.id === locationId);
    if (!location || batchCreateSuggestions.length < 2) return;

    setCreatingBatchWorkOrders(true);
    setMessage("");
    const rows = batchCreateSuggestions.map((suggestion) => {
      const relatedAsset = resolveRelatedAsset(suggestion, location);
      return {
        location_id: location.id,
        asset_id: relatedAsset?.id ?? null,
        asset_name: relatedAsset?.name ?? suggestion.assetName,
        category: suggestion.category,
        issue: suggestion.issue,
        priority: suggestion.priority,
        notes: notes ? `Submitted together from one report. Original note: ${notes}` : "Submitted together from one report.",
      };
    });

    const firstDuplicate = rows.find((row) => {
      const duplicate = possibleDuplicateFor(String(row.issue || ""), location, typeof row.asset_id === "string" ? row.asset_id : null);
      return Boolean(duplicate);
    });
    if (firstDuplicate) {
      const duplicate = possibleDuplicateFor(String(firstDuplicate.issue || ""), location, typeof firstDuplicate.asset_id === "string" ? firstDuplicate.asset_id : null);
      setMessage(`Possible duplicate detected: ${duplicate?.display_id || "existing work order"} — ${duplicate?.issue || "similar active issue"}. Review the existing ticket before creating a new one.`);
      setCreatingBatchWorkOrders(false);
      return;
    }

    const result = await submitWorkOrders(rows);
    if (result.error) {
      setMessage(result.error.message);
      setCreatingBatchWorkOrders(false);
      return;
    }

    await clearSubmittedDraft();
    await loadWorkOrders(Boolean(cmpriSession?.capabilities.includes("view_dashboard")));
    setCreatingBatchWorkOrders(false);
    setShowBatchCreateDialog(false);
    setCreateState("created");
    setMessage(isSubmitOnlyUser
      ? `${rows.length} requests submitted for Engineering verification.`
      : `${rows.length} work orders created.`);

    window.setTimeout(() => {
      resetWorkOrderForm();
      setBatchCreateSuggestions([]);
      setCreateState("idle");
      notifyCreateModal("cmpri-work-order-created");
    }, 900);
  }

  async function submitWorkOrders(orders: Record<string, unknown> | Record<string, unknown>[]) {
    try {
      const session = await getValidSession();
      if (!session) {
        return { error: { message: "Sign in again before submitting." }, workOrders: [] as Array<{ id: string; display_id: string; status: string }> };
      }
      const response = await fetch("/api/work-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          orders: Array.isArray(orders) ? orders : [orders],
          staff_first_name: staffFirstName.trim(),
          ...(activeDraftId ? { source_draft_id: activeDraftId, source_draft_revision: activeDraftRevision } : {}),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) {
        return {
          error: { message: result.error || "Unable to confirm work-order submission. Check the list before retrying." },
          workOrders: [] as Array<{ id: string; display_id: string; status: string }>,
        };
      }
      const workOrders = Array.isArray(result.work_orders) ? result.work_orders as Array<{ id: string; display_id: string; status: string }> : [];
      if (photo && workOrders.length) {
        for (const workOrder of workOrders) {
          const form = new FormData();
          form.append("photo", photo);
          const uploadResponse = await fetch(`/api/work-orders/${encodeURIComponent(workOrder.id)}/attachments`, {
            method: "POST",
            headers: { Authorization: `Bearer ${session.access_token}` },
            body: form,
          });
          if (!uploadResponse.ok) {
            const uploadPayload = await uploadResponse.json().catch(() => ({}));
            setPhotoUploadError(uploadPayload.error || "The work order was created, but its photo could not be uploaded.");
            break;
          }
        }
      }
      return {
        error: null,
        workOrders,
      };
    } catch {
      return {
        error: { message: "Submission could not be confirmed. Check the work-order list before retrying." },
        workOrders: [] as Array<{ id: string; display_id: string; status: string }>,
      };
    }
  }

  async function createWorkOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isFrontDeskUser && !validFirstName(staffFirstName)) {
      setMessage("Enter your first name before submitting.");
      return;
    }

    setLoading(true);
    setCreateState("creating");
    setMessage("");

    const location = locations.find((item) => item.id === locationId);
    if (!location) {
      setMessage("Please select a room or location.");
      setLoading(false);
      setCreateState("idle");
      return;
    }

    const normalizedIssue = cleanIssueLocationPrefix(issue, locations, location).issue;
    if (!normalizedIssue.trim()) {
      setMessage("Reported Issue is required.");
      setLoading(false);
      setCreateState("idle");
      return;
    }
    if (normalizedIssue !== issue) setIssue(normalizedIssue);

    const duplicate = possibleDuplicateFor(normalizedIssue, location, assetId || null);
    if (duplicate) {
      setMessage(`Possible duplicate detected: ${duplicate.display_id || "existing work order"} — ${duplicate.issue || "similar active issue"}. Review the existing ticket before creating a new one.`);
      setLoading(false);
      setCreateState("idle");
      return;
    }

    const multipleCreateIssues = detectMultipleCreateIssues(normalizedIssue);
    if (multipleCreateIssues.length >= 2) {
      setBatchCreateSuggestions(multipleCreateIssues);
      setShowBatchCreateDialog(true);
      setLoading(false);
      setCreateState("idle");
      return;
    }

    const asset = assets.find((item) => item.id === assetId);
    const result = await submitWorkOrders({
      location_id: location.id,
      asset_id: asset?.id ?? null,
      asset_name: asset?.name ?? "",
      category,
      issue: normalizedIssue,
      priority,
      notes,
    });

    if (result.error) {
      setMessage(result.error.message);
      setLoading(false);
      setCreateState("idle");
      return;
    }

    const displayId = result.workOrders[0]?.display_id || "Work order";
    await clearSubmittedDraft();
    await loadWorkOrders(Boolean(cmpriSession?.capabilities.includes("view_dashboard")));

    if (relatedIssueSuggestions.length > 0) {
      setMainWorkOrderCreated(true);
      setMessage(isSubmitOnlyUser
        ? `Request ${displayId} submitted for Engineering verification. Review the additional issues detected in the notes.`
        : `Work order ${displayId} created. Review the additional issues detected in the technician notes.`);
      setShowRelatedWorkOrderDialog(true);
      setLoading(false);
      return;
    }

    setMessage(isSubmitOnlyUser
      ? `Request ${displayId} submitted for Engineering verification.`
      : `Work order ${displayId} created.`);
    setLoading(false);
    setCreateState("created");

    window.setTimeout(() => {
      if (notifyCreateModal("cmpri-work-order-created", displayId)) return;
      resetWorkOrderForm();
      setCreateState("idle");
    }, 1000);
  }




  const locationOptions = useMemo(() => {
    return [...locations]
      .sort((a, b) => {
        const sectionA = cmpriLocationSection(a);
        const sectionB = cmpriLocationSection(b);
        const sectionDiff =
          (CMPRI_LOCATION_SECTION_ORDER[sectionA] ?? 999) -
          (CMPRI_LOCATION_SECTION_ORDER[sectionB] ?? 999);
        if (sectionDiff !== 0) return sectionDiff;

        if (sectionA === "Guest Rooms") {
          return cmpriNaturalNumber(a.room_number || a.name) - cmpriNaturalNumber(b.room_number || b.name);
        }

        if (sectionA === "Electrical Closets") {
          const floorDiff = cmpriNaturalNumber(a.name) - cmpriNaturalNumber(b.name);
          if (floorDiff !== 0) return floorDiff;
          return a.name.localeCompare(b.name, undefined, { numeric: true });
        }

        const preferredDiff = cmpriLocationWithinSectionRank(a) - cmpriLocationWithinSectionRank(b);
        if (preferredDiff !== 0) return preferredDiff;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      })
      .map((location) => ({
        value: location.id,
        label: location.name,
        group: cmpriLocationSection(location),
        keywords: [
          location.room_number ?? "",
          location.area ?? "",
          location.location_type ?? "",
        ],
      }));
  }, [locations]);
  const createHasUnsavedChanges = Boolean(
    issue.trim() || locationId || notes.trim() || assetId || staffFirstName.trim()
  );
  useEffect(() => {
    if (!createHasUnsavedChanges || !locationId || !issue.trim() || loading || draftBusy) return;
    const timeout = window.setTimeout(() => { void saveDraft(true); }, 30 * 60 * 1000);
    return () => window.clearTimeout(timeout);
    // saveDraft is intentionally omitted: the form values above reset this timer on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createHasUnsavedChanges, locationId, issue, notes, assetId, category, priority, staffFirstName, loading, draftBusy]);
  const isSpanish = formLanguage === "es";
  const tx = (english: string, spanish: string) => isSpanish ? spanish : english;
  const categoryLabelEs: Record<string, string> = {
    General: "General", HVAC: "Climatización / HVAC", Plumbing: "Plomería", Electrical: "Electricidad",
    Appliances: "Electrodomésticos", "Doors/Locks": "Puertas / Cerraduras", "Pool/Spa": "Piscina / Spa",
    Laundry: "Lavandería", "Public Area": "Área pública", Safety: "Seguridad", "TV / AV": "TV / AV", Furniture: "Muebles",
  };

  const createAssetOptions = [
    ...availableAssets.map((asset) => ({
      value: asset.id,
      label: asset.name,
      keywords: [
        asset.asset_type,
        asset.manufacturer ?? "",
        asset.model_number ?? "",
        asset.asset_tag ?? "",
      ],
    })),
    { value: "", label: tx("No specific asset / equipment", "Sin equipo específico") },
  ];

  const detectedCreateIssues = issue.trim() ? detectMultipleCreateIssues(issue) : [];

  const trustedTroubleshootingKnowledge = troubleshootingKnowledge?.source?.verified === true ? troubleshootingKnowledge : null;
  const trustedManualUrl = trustedTroubleshootingKnowledge?.source?.file_url || trustedTroubleshootingKnowledge?.source?.pdf_url;
  const troubleshootingEvidence = `${issue} ${notes}`.toLowerCase();
  const matchingTroubleshootingSteps = trustedTroubleshootingKnowledge?.symptom_rules
    ?.filter((rule) => !rule.match?.length || rule.match.some((phrase) => troubleshootingEvidence.includes(phrase.toLowerCase())))
    .flatMap((rule) => rule.steps) ?? [];
  const troubleshootingSteps = Array.from(new Set([
    ...matchingTroubleshootingSteps,
    ...GENERAL_TROUBLESHOOTING_CHECKS,
  ]));


  return (
    <main className="min-h-screen bg-slate-950 px-[15px] py-[15px] text-white">
      <div className={`mx-auto w-full max-w-none ${isSubmitOnlyUser ? "" : "lg:w-[66vw]"}`}>
        {drafts.length > 0 && (
          <section className="mb-2 rounded-xl border border-slate-800 bg-slate-900 p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-bold text-white">Saved Drafts</h2>
                <p className="text-xs text-slate-400">Your drafts are editable. Authorized supervisors can load, submit, or delete subordinate drafts without changing who originally created the report.</p>
              </div>
              <span className="rounded-full border border-slate-700 px-2.5 py-1 text-xs font-semibold text-slate-300">{drafts.length}</span>
            </div>
            <div className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
              {drafts.map((draft) => {
                const ownDraft = draft.created_by === cmpriSession?.user.id;
                const active = activeDraftId === draft.id;
                return (
                  <div key={draft.id} className={`rounded-xl border p-3 ${active ? "border-sky-500 bg-sky-950/25" : "border-slate-800 bg-slate-950/55"}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-slate-100">{draft.room || "Room / Location"} · {draft.issue}</p>
                        <p className="mt-1 text-xs text-slate-500">{ownDraft ? "Your draft" : `Created by ${draft.creator_name || "another employee"}${draft.creator_role ? ` · ${draft.creator_role}` : ""}`}{draft.updated_at ? ` · Updated ${new Date(draft.updated_at).toLocaleString()}` : ""}</p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button type="button" disabled={draftBusy} onClick={() => restoreDraft(draft)} className="rounded-lg border border-sky-600/60 px-3 py-1.5 text-xs font-bold text-sky-200 hover:bg-sky-950/60 disabled:opacity-50">{ownDraft ? "Load" : "Load to Submit"}</button>
                        {draft.can_delete && <button type="button" disabled={draftBusy} onClick={() => void deleteDraft(draft)} className="rounded-lg border border-red-700/60 px-3 py-1.5 text-xs font-bold text-red-300 hover:bg-red-950/40 disabled:opacity-50">Delete</button>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <div>
          <form
            onSubmit={createWorkOrder}
            className="mx-auto w-full space-y-1 rounded-xl border border-slate-800 bg-slate-900 p-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-1 pb-1">
              {cmpriSession && !embedded && (
                <div className="mr-auto min-w-0">
                  {!isSubmitOnlyUser && <h1 className="text-sm font-bold text-slate-100">{dashboardTitleForRole(cmpriSession.user.role)}</h1>}
                  <AccountSummary user={cmpriSession.user} />
                </div>
              )}
              <div className="flex flex-wrap items-center justify-end gap-1">
                <ModalNavigationButton href="/profile" className="rounded-lg border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-800">{tx("Profile", "Perfil")}</ModalNavigationButton>
                <label htmlFor="work-order-photo-file" title="Choose a photo file" aria-label="Choose a photo file" className="grid size-8 cursor-pointer place-items-center rounded-lg border border-slate-700 text-slate-200 hover:bg-slate-800">
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15V3m0 0 4 4m-4-4-4 4" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
                  </svg>
                </label>
                <input id="work-order-photo-file" type="file" accept="image/*" onChange={(event) => { setPhoto(event.target.files?.[0] || null); setPhotoUploadError(""); }} className="sr-only" />
                <label htmlFor="work-order-photo-camera" title="Take a photo" aria-label="Take a photo" className={`grid size-8 cursor-pointer place-items-center rounded-lg border ${isSubmitOnlyUser ? "md:hidden" : ""} ${photo ? "border-sky-400 bg-sky-950/50 text-sky-200" : "border-slate-700 text-slate-200 hover:bg-slate-800"}`}>
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 7.5h3l1.4-2h7.2l1.4 2h3A1.5 1.5 0 0 1 21.5 9v9a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18V9A1.5 1.5 0 0 1 4 7.5Z" />
                    <circle cx="12" cy="13" r="3.5" />
                  </svg>
                </label>
                <input id="work-order-photo-camera" type="file" accept="image/*" capture="environment" onChange={(event) => { setPhoto(event.target.files?.[0] || null); setPhotoUploadError(""); }} className="sr-only" />
                {!isSubmitOnlyUser && <button type="button" onClick={() => void signOut()} className="rounded-lg border border-red-400/50 bg-red-950/30 px-2 py-1 text-xs font-semibold text-red-100 hover:bg-red-900/40">{tx("Sign Out", "Cerrar sesión")}</button>}
                <button type="button" onClick={requestCancelCreateForm} disabled={loading || draftBusy} className="rounded-lg border border-slate-600 px-2 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-60">{tx("Cancel", "Cancelar")}</button>
                <button type="button" onClick={() => void saveDraft()} disabled={loading || draftBusy || loadingLocations || loadingAssets} className="rounded-lg border border-sky-600/70 bg-sky-950/40 px-2 py-1 text-xs font-semibold text-sky-200 hover:bg-sky-900/50 disabled:opacity-60">{draftBusy ? tx("Saving Draft...", "Guardando borrador...") : activeDraftId ? tx("Update Draft", "Actualizar borrador") : tx("Save Draft", "Guardar borrador")}</button>
                <button type="submit" disabled={loading || loadingLocations || loadingAssets || createState === "created"} className={`rounded-lg border px-2 py-1 text-xs font-bold transition-colors disabled:opacity-80 ${createState === "created" ? "border-emerald-500 bg-emerald-600 text-white" : createState === "creating" ? "border-red-900 bg-red-950/70 text-red-200" : createHasUnsavedChanges ? "border-red-500 bg-red-600 text-white hover:bg-red-500" : "border-blue-500 bg-blue-700 text-white hover:bg-blue-600"}`}>
                  {createState === "creating" ? tx("Submitting...", "Enviando...") : createState === "created" ? tx("Submitted", "Enviado") : isSubmitOnlyUser ? tx("Submit Request", "Enviar solicitud") : tx("Create Work Order", "Crear orden")}
                </button>
              </div>
            </div>

            {(photo || photoUploadError) && <div className="flex min-w-0 items-center gap-2 text-[11px]">{photo && <span className="max-w-[60%] truncate text-slate-400" title={photo.name}>Attached: {photo.name}</span>}{photoUploadError && <span role="alert" className="text-amber-300">{photoUploadError}</span>}</div>}

            {isFrontDeskUser && <label className="block">
              <span className="mb-1 block text-sm font-medium"> {tx("Your first name", "Tu nombre")} <span className="text-red-300">*</span></span>
              <input required maxLength={80} autoComplete="off" value={staffFirstName} onChange={event => setStaffFirstName(event.target.value)} placeholder={tx("First name", "Nombre")} disabled={loading || creatingBatchWorkOrders || creatingRelatedWorkOrders} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-amber-400" />
              <span className="mt-1 block text-xs text-slate-400"> {tx("Required for each report submitted through the shared front-desk account.", "Obligatorio para cada reporte enviado desde la cuenta compartida de recepción")} </span>
            </label>}

            <label className="block">
              <span className="mb-1 block text-sm font-medium"> {tx("Room / Location", "Habitación / Ubicación")} </span>
              <SearchableSelect
                required
                value={locationId}
                onChange={(value) => handleLocationChange(value)}
                disabled={loadingLocations || loadingAssets}
                placeholder={loadingLocations ? tx("Loading locations...", "Cargando ubicaciones...") : tx("Room / Location", "Habitación / Ubicación")}
                options={locationOptions}
                topSuggestions={2}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium"> {tx("Issue", "Problema")} </span>
              <textarea
                required
                value={issue}
                disabled={loadingLocations || loadingAssets}
                onChange={(event) => handleIssueChange(event.target.value)}
                rows={2}
                placeholder={tx("Example: 316 not cooling", "Ejemplo: 316 no enfría")}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm outline-none focus:border-amber-400"
              />
              {detectedCreateIssues.length >= 2 && (
                <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-950/25 px-3 py-2">
                  <p className="text-sm font-bold text-amber-200">This report will create {detectedCreateIssues.length} work orders.</p>
                  <p className="mt-1 text-xs text-amber-100/70">{detectedCreateIssues.map((item) => item.category).join(" · ")}</p>
                </div>
              )}
            </label>

            <div className="grid gap-2 md:grid-cols-3">
              <label className="block md:col-span-1">
                <span className="mb-1 block text-sm font-medium"> {tx("Asset / Equipment", "Equipo / Activo")} </span>
                <SearchableSelect
                  value={assetId}
                  onChange={handleAssetChange}
                  disabled={isSubmitOnlyUser || !locationId || loadingAssets}
                  placeholder={!locationId ? tx("Select location first", "Selecciona la ubicación primero") : tx("Asset / Equipment", "Equipo / Activo")}
                  options={createAssetOptions}
                  topSuggestions={3}
                  showSuggestionsOnOpen={false}
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium"> {tx("Category", "Categoría")} </span>
                <SearchableSelect
                  value={category}
                  disabled={isSubmitOnlyUser}
                  onChange={(value) => { setManualCategory(true); setCategory(value); }}
                  placeholder={tx("Category", "Categoría")}
                  topSuggestions={2}
                  options={categoryOptions(category).map((option) => ({ ...option, label: isSpanish ? (categoryLabelEs[option.value] || option.label) : option.label }))}
                />
                {isSubmitOnlyUser && <p className="mt-2 text-xs font-semibold text-emerald-400"> {tx("System best guess · Engineering verifies after submission", "Mejor estimación del sistema · Ingeniería verifica después del envío")} </p>}
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium"> {tx("Priority", "Prioridad")} </span>
                <SearchableSelect
                  value={priority}
                  disabled={isSubmitOnlyUser}
                  onChange={(value) => { setManualPriority(true); setPriority(value); }}
                  placeholder={tx("Priority", "Prioridad")}
                  topSuggestions={2}
                  options={['Urgent','High','Medium','Low'].map((value) => ({ value, label: isSpanish ? ({ Urgent: 'Urgente', High: 'Alta', Medium: 'Media', Low: 'Baja' } as Record<string,string>)[value] : value }))}
                />
                {isSubmitOnlyUser && <p className="mt-2 text-xs font-semibold text-emerald-400"> {tx("System best guess · locked for submit-only roles", "Mejor estimación del sistema · bloqueado para funciones de solo envío")} </p>}
              </label>
            </div>

            <label className="block">
              <span className="mb-1 block text-sm font-medium"> {tx("Notes / Actions Taken", "Notas / Acciones realizadas")} </span>
              <textarea
                value={notes}
                disabled={loadingLocations || loadingAssets}
                onChange={(event) => handleNotesChange(event.target.value)}
                rows={3}
                placeholder={tx("Optional: findings, diagnostic codes, readings, tests, or work already performed", "Opcional: hallazgos, códigos de diagnóstico, lecturas, pruebas o trabajo ya realizado")}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm outline-none focus:border-amber-400"
              />
            </label>

            {canViewTroubleshootingGuide && (
              <section aria-label="Troubleshooting Guide" className="rounded-xl border border-amber-500/30 bg-slate-950/70 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-bold text-amber-300">Suggested Troubleshooting</h2>
                    <p className="mt-1 text-xs text-slate-400">General checks and verified equipment guidance matched to the reported issue.</p>
                  </div>
                  {troubleshootingLoading && <span className="text-xs text-slate-400">Loading equipment guidance...</span>}
                </div>
                {selectedCreateAsset && trustedTroubleshootingKnowledge?.source?.title && (
                  <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2">
                    <p className="text-sm font-semibold text-slate-200">{trustedTroubleshootingKnowledge.source.title}</p>
                    <p className="mt-1 text-xs text-emerald-400">Verified equipment documentation</p>
                    {trustedManualUrl && (
                      <button type="button" onClick={() => window.open(trustedManualUrl, "_blank", "noopener,noreferrer")} className="mt-2 inline-block text-xs font-semibold text-sky-300 hover:underline">Open Manual</button>
                    )}
                  </div>
                )}
                {selectedCreateAsset && troubleshootingKnowledge?.source?.title && !trustedTroubleshootingKnowledge && (
                  <p className="mt-3 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-400">Equipment reference available; its extracted guidance is hidden until Engineering verifies the documentation.</p>
                )}
                {!selectedCreateAsset && <p className="mt-3 text-xs text-slate-400">Select equipment to include verified model-specific guidance.</p>}
                {troubleshootingError && <p role="status" className="mt-3 text-xs text-amber-200">{troubleshootingError}</p>}
                <ol className="mt-3 space-y-2 text-sm text-slate-300">
                  {troubleshootingSteps.map((step, index) => (
                    <li key={`${step}-${index}`} className="flex gap-2">
                      <span className="font-semibold text-amber-400">{index + 1}.</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}

          </form>
        </div>

        {message && (
          <p className="mt-5 rounded-lg bg-slate-900 p-4 text-sm">
            {message}
          </p>
        )}

        {showCancelConfirm && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-1" onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            setShowCancelConfirm(false);
          }}>
            <div role="dialog" aria-modal="true" aria-labelledby="create-cancel-title" className="cmpri-modal-shell rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
              <h2 id="create-cancel-title" className="text-xl font-bold">{tx("Cancel work-order creation?", "¿Cancelar la creación de la orden?")}</h2>
              <p className="mt-2 text-sm text-slate-400">{tx("Your unsaved work will be discarded. Any saved draft for this work will also be deleted.", "Se descartará el trabajo no guardado. También se eliminará cualquier borrador guardado de este trabajo.")}</p>
              <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button type="button" autoFocus disabled={draftBusy} onClick={() => setShowCancelConfirm(false)} className="rounded-lg border border-slate-600 px-5 py-3 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-60">{tx("Keep Editing", "Seguir editando")}</button>
                <button type="button" disabled={draftBusy} onClick={() => void confirmCancelCreateForm()} className="rounded-lg bg-red-600 px-5 py-3 text-sm font-bold text-white hover:bg-red-500 disabled:opacity-60">{draftBusy ? tx("Discarding...", "Descartando...") : tx("Confirm Cancel", "Confirmar cancelación")}</button>
              </div>
            </div>
          </div>
        )}

        {showBatchCreateDialog && selectedLocation && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-1" onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            setShowBatchCreateDialog(false);
            setBatchCreateSuggestions([]);
          }}>
            <div role="dialog" aria-modal="true" aria-labelledby="batch-work-orders-title" className="cmpri-modal-shell rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
              <h2 id="batch-work-orders-title" className="text-xl font-bold">{batchCreateSuggestions.length} work orders detected</h2>
              <p className="mt-2 text-sm text-slate-400">CMPRI found multiple maintenance issues in one report. Review them before anything is submitted. You can edit an issue or remove one that should not become a separate work order.</p>

              <div className="mt-5 max-h-[58vh] space-y-3 overflow-y-auto pr-1">
                {batchCreateSuggestions.map((suggestion, index) => {
                  const relatedAsset = resolveRelatedAsset(suggestion, selectedLocation);
                  const duplicate = possibleDuplicateFor(suggestion.issue, selectedLocation);
                  return (
                    <div key={suggestion.key} className="rounded-xl border border-slate-700 bg-slate-950 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Work Order {index + 1} · {selectedLocation.name}</p>
                          <input
                            value={suggestion.issue}
                            onChange={(event) => {
                              const nextIssue = event.target.value;
                              setBatchCreateSuggestions((current) => current.map((item, itemIndex) =>
                                itemIndex === index ? createSuggestionFromIssueClause(nextIssue, itemIndex) : item
                              ));
                            }}
                            className="mt-2 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm outline-none focus:border-amber-400"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => handleBatchSuggestionRemoval(index)}
                          className="rounded-lg border border-red-500/50 px-3 py-2 text-xs font-semibold text-red-300 hover:bg-red-950/40"
                        >
                          Remove
                        </button>
                      </div>
                      <div className="mt-3 grid gap-2 text-xs text-slate-300 sm:grid-cols-3">
                        <span><span className="text-slate-500">Asset:</span> {relatedAsset?.name ?? suggestion.assetName}</span>
                        <span><span className="text-slate-500">Category:</span> {suggestion.category}</span>
                        <span><span className="text-slate-500">Priority:</span> {suggestion.priority}</span>
                      </div>
                      {duplicate && (
                        <p className="mt-3 rounded-lg border border-orange-500/40 bg-orange-950/30 px-3 py-2 text-xs font-semibold text-orange-200">Possible duplicate: {duplicate.display_id || "existing work order"} — {duplicate.issue || "similar active issue"}</p>
                      )}
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button type="button" onClick={() => void createSingleBatchWorkOrder(suggestion)} className="rounded-lg border border-amber-500/50 bg-amber-950/30 px-3 py-2 text-xs font-bold text-amber-100 hover:bg-amber-900/40">Submit This</button>
                        <button type="button" onClick={() => handleBatchSuggestionRemoval(index)} className="rounded-lg border border-red-500/50 px-3 py-2 text-xs font-bold text-red-200 hover:bg-red-950/40">Remove</button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button type="button" autoFocus disabled={creatingBatchWorkOrders} onClick={() => { setShowBatchCreateDialog(false); setBatchCreateSuggestions([]); }} className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50">Back to Form</button>
                <button type="button" disabled={creatingBatchWorkOrders || batchCreateSuggestions.length < 2} onClick={() => void createBatchWorkOrders()} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-60">
                  {creatingBatchWorkOrders ? "Submitting..." : `Submit All (${batchCreateSuggestions.length})`}
                </button>
              </div>
            </div>
          </div>
        )}

        {showRelatedWorkOrderDialog &&
          selectedLocation && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-1" onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.preventDefault();
              event.stopPropagation();
              cancelRelatedWorkOrders();
            }}>
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="related-work-orders-title"
                className="cmpri-modal-shell rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
              >
                <h2
                  id="related-work-orders-title"
                  className="text-xl font-bold"
                >
                  Are you sure you want to create these work orders?
                </h2>

                <p className="mt-2 text-sm text-slate-400">
                  Review the separate issues found in the technician notes. Category, priority, and troubleshooting will still be saved, but they are intentionally hidden from this confirmation.
                </p>

                <div className="mt-5 max-h-[55vh] space-y-3 overflow-y-auto pr-1">
                  {relatedIssueSuggestions.map(
                    (suggestion) => {
                      const relatedAsset =
                        resolveRelatedAsset(
                          suggestion,
                          selectedLocation
                        );

                      return (
                        <div
                          key={
                            suggestion.key
                          }
                          className="rounded-xl border border-slate-700 bg-slate-950 p-4"
                        >
                          <div className="grid gap-3 sm:grid-cols-[110px_1fr]">
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                              Room
                            </p>

                            <p className="text-sm font-semibold">
                              {
                                selectedLocation.name
                              }
                            </p>

                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                              Asset
                            </p>

                            <p className="text-sm">
                              {relatedAsset?.name ??
                                suggestion.assetName}
                            </p>

                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                              Issue
                            </p>

                            <p className="text-sm">
                              {
                                suggestion.issue
                              }
                            </p>
                          </div>
                        </div>
                      );
                    }
                  )}
                </div>

                <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={
                      cancelRelatedWorkOrders
                    }
                    disabled={
                      creatingRelatedWorkOrders
                    }
                    className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                  >
                    Cancel
                  </button>

                  <button
                    type="button"
                    onClick={
                      createRelatedWorkOrders
                    }
                    disabled={
                      creatingRelatedWorkOrders
                    }
                    className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-60"
                  >
                    {creatingRelatedWorkOrders
                      ? "Creating..."
                      : `Yes, Create ${relatedIssueSuggestions.length} Work Order${relatedIssueSuggestions.length === 1 ? "" : "s"}`}
                  </button>
                </div>
              </div>
            </div>
          )}
      </div>
    </main>
  );
}
