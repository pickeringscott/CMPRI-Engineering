"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getValidSession } from "@/lib/supabase/client";
import { authorizationHeaders, loadCmpriSession, type CmpriClientSession } from "@/lib/auth/client-session";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import SearchableSelect from "@/components/SearchableSelect";
import CopyButton from "@/components/CopyButton";
import { classifyAsset } from "@/lib/asset-category";
import { categoryOptions as workOrderCategoryOptions } from "@/lib/work-order-categories";
import { normalizeManualKnowledge, type ManualErrorCode, type ManualKnowledge, type ManualSymptomRule } from "@/lib/manual-knowledge";


type Asset = {
  id: string;
  location_id: string | null;
  location_name?: string;
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
type WorkOrderImage = { id: string; name: string; url: string };

type WorkOrder = {
  revision: number;
  id: string;
  display_id?: string | null;
  location_id?: string | null;
  asset_id?: string | null;
  room?: string | null;
  asset_name?: string | null;
  category?: string | null;
  issue?: string | null;
  priority?: string | null;
  technician_name?: string | null;
  status?: string | null;
  notes?: string | null;
  reporter_notes?: string | null;
  action_root_cause?: string | null;
  parts?: string | null;
  cost?: number | null;
  hours?: number | null;
  due_by?: string | null;
  creator_name?: string | null;
  created_at?: string | null;
};

type MentionTicket = {
  id: string;
  display_id?: string | null;
  room?: string | null;
  issue?: string | null;
  status?: string | null;
};

type ExternalActivity = {
  configured?: boolean;
  purchases?: { id: string; vendor?: string | null; order_number?: string | null; status?: string | null; eta?: string | null;
    cmpri_purchase_shipments?: { id?: string; status?: string | null; ship_from?: string | null; tracking_number?: string | null }[] }[];
  enseo?: { id: string; ticket_number?: string | null; enseo_endpoint?: string | null; room_number?: string | null; status?: string | null }[];
  warranties?: { id: string; rma_number?: string | null; warranty_case_number?: string | null; status?: string | null }[];
  followups?: { id: string; status?: string | null }[];
  history_configured?: boolean;
  history?: { id: string; actor_name?: string | null; event_type?: string | null; old_status?: string | null; new_status?: string | null; changed_fields?: Record<string, unknown> | null; recorded_at?: string | null }[];
};

type RoomRankerContext = {
  rowNumber?: number;
  room?: string;
  rank?: string;
  check1?: string;
  check2?: string;
  check3?: string;
  notes?: string;
};

type RoomOperationalContext = {
  ranker: RoomRankerContext | null;
  pm: Record<string, unknown> | null;
  loading: boolean;
};

type TechnicianProfile = {
  id: string;
  full_name: string | null;
  role: string | null;
  active: boolean | null;
};

function categoryForAsset(asset: Asset) {
  return classifyAsset(asset);
}

function priorityForCategory(
  category: string
) {
  switch (category) {
    case "Safety":
    case "HVAC":
    case "Pool/Spa":
    case "Pool":
    case "Doors/Locks":
      return "High";

    case "Furniture":
      return "Low";

    default:
      return "Medium";
  }
}

function priorityBubbleClass(priority?: string | null) {
  const value = String(priority || "").toLowerCase();
  if (value === "urgent") return "border-purple-400/40 bg-purple-950/45 text-purple-200";
  if (value === "high") return "border-red-400/40 bg-red-950/40 text-red-200";
  if (value === "medium") return "border-yellow-400/40 bg-yellow-950/35 text-yellow-200";
  if (value === "low") return "border-blue-400/40 bg-blue-950/35 text-blue-200";
  return "border-slate-700 bg-slate-900 text-slate-300";
}

function statusBubbleClass(status?: string | null) {
  const value = String(status || "Open").toLowerCase();
  if (value === "pending verification") return "border-purple-400/50 bg-purple-950/45 text-purple-200";
  if (value === "open") return "border-green-400/40 bg-green-950/35 text-green-200";
  if (value === "in progress") return "border-yellow-400/40 bg-yellow-950/35 text-yellow-200";
  if (value === "completed") return "border-blue-400/40 bg-blue-950/35 text-blue-200";
  if (value === "duplicate") return "border-orange-400/40 bg-orange-950/35 text-orange-200";
  if (value === "closed") return "border-red-400/40 bg-red-950/35 text-red-200";
  if (value === "will not do") return "border-slate-500/40 bg-slate-800 text-slate-200";
  return "border-slate-700 bg-slate-900 text-slate-300";
}




type SymptomRoute = {
  key: string;
  categories?: string[];
  assetPattern?: RegExp;
  issuePattern: RegExp;
  steps: string[];
};

const SYMPTOM_ROUTES: SymptomRoute[] = [
  {
    key: "sink-leak",
    categories: ["Plumbing"],
    assetPattern: /\b(sink|vanity|faucet|disposal|garbage disposal|plumbing)\b/i,
    issuePattern: /\b(leak|leaking|drip|dripping|water under sink|leak under sink|cabinet wet|wet under sink)\b/i,
    steps: [
      "Dry the cabinet and plumbing so the exact leak source can be identified.",
      "Run the faucet and inspect the hot and cold supply stops, supply hoses, faucet shanks, and faucet-body connections.",
      "Fill the sink, then release the water and inspect the basket strainer or disposal flange, disposal body, dishwasher drain connection, and discharge tube.",
      "Inspect every P-trap slip joint, trap arm connection, washer, and wall-drain connection while water is flowing.",
      "If a garbage disposal is installed, check whether water is leaking from the sink flange, dishwasher inlet, discharge connection, or the disposal housing itself.",
      "Check the cabinet floor and wall for water damage after the active leak is identified.",
      "Repair the confirmed leaking component rather than replacing unrelated plumbing parts.",
    ],
  },
  {
    key: "garbage-disposal-jam",
    categories: ["Plumbing", "Appliances", "Appliance"],
    assetPattern: /\b(disposal|garbage disposal|sink)\b/i,
    issuePattern: /\b(disposal|garbage disposal).*\b(hum|humming|jam|jammed|stuck|won't turn|will not turn|not spinning|not working)\b/i,
    steps: [
      "Turn the disposal off and verify power is removed before reaching into or working on the grinding chamber.",
      "Check for a visible foreign object or jam without placing hands into the disposal.",
      "Use the manufacturer-approved jam-clearing method or wrench point if the unit provides one.",
      "After the obstruction is cleared, verify the overload/reset condition and restore power.",
      "Run water and test operation while checking the sink flange, dishwasher inlet, discharge tube, and disposal body for leaks.",
      "If the motor remains seized, repeatedly trips, or the housing leaks, treat replacement as the likely repair after power and jam conditions are verified.",
    ],
  },
  {
    key: "sink-clog",
    categories: ["Plumbing"],
    assetPattern: /\b(sink|drain|plumbing|disposal)\b/i,
    issuePattern: /\b(sink|drain).*\b(clog|clogged|slow|backing up|won't drain|will not drain)\b/i,
    steps: [
      "Determine whether the blockage is limited to this sink or affects another fixture on the same branch.",
      "Check the sink stopper or strainer and the garbage disposal, if present, for an obvious obstruction.",
      "Inspect and clear the P-trap if the blockage appears local to the sink.",
      "Inspect the trap arm and wall-drain connection if the P-trap is clear.",
      "If multiple fixtures are affected, stop treating it as a fixture-only problem and investigate the branch or building drain.",
    ],
  },
  {
    key: "tv-no-signal",
    categories: ["TV / AV", "Telecom"],
    assetPattern: /\b(tv|television|enseo|set[- ]?top box|stb)\b/i,
    issuePattern: /\b(no signal|black screen|no picture|picture missing|input|source|hdmi|channel|channels|tv not working|television not working)\b/i,
    steps: [
      "Verify the television and Enseo/set-top box both have power.",
      "Use the TV controls directly if needed so a remote-control problem is not mistaken for a TV failure.",
      "Confirm the television is on the correct input/source for the Enseo/set-top box.",
      "Reseat and inspect the HDMI connection between the set-top box and television.",
      "Check coax/network connections and the visible status of the set-top box.",
      "Determine whether the problem affects only this TV, both TVs in the room, or multiple rooms; a wider problem should be treated as a distribution/network issue.",
      "Verify the TV and set-top box are assigned/provisioned to the exact room sub-location, such as Living Room or Bedroom.",
      "Guest-room set-top boxes should retain guest-room provisioning such as Netflix capability; do not substitute a public-area box without updating provisioning.",
      "If a known-good signal reaches the TV and the TV still cannot display it, then treat the television itself as the likely failed component.",
    ],
  },
  {
    key: "tv-no-power",
    categories: ["TV / AV", "Telecom"],
    assetPattern: /\b(tv|television|enseo|set[- ]?top box|stb)\b/i,
    issuePattern: /\b(no power|won't turn on|will not turn on|dead|doesn't turn on|does not turn on)\b/i,
    steps: [
      "Verify the outlet and power cord are working before condemning the television.",
      "Try the TV controls directly rather than relying only on the remote.",
      "Check the set-top box separately so a dead TV and dead set-top box are not treated as the same failure.",
      "If power is present and the television remains dead after basic external checks, replace the television rather than opening it for component-level repair.",
      "When replacing or moving a TV, keep its Enseo/set-top-box room and sub-location assignment synchronized.",
    ],
  },
  {
    key: "tv-physical-damage",
    categories: ["TV / AV", "Telecom"],
    assetPattern: /\b(tv|television)\b/i,
    issuePattern: /\b(broken|cracked|shattered|screen broken|screen cracked|physical damage)\b/i,
    steps: [
      "Document the physical damage and verify the correct room sub-location for the television.",
      "Do not perform component-level screen repair on a physically broken hotel television.",
      "Replace the television with a compatible unit.",
      "If equipment is moved between room sub-locations, update both the TV and associated Enseo/set-top-box assignments.",
    ],
  },
  {
    key: "pool-humidity",
    categories: ["Pool/Spa", "Pool", "HVAC"],
    assetPattern: /\b(pool|natatorium|dehumid|hvac|air handler|conditioner)\b/i,
    issuePattern: /\b(humid|humidity|muggy|condensation|sweating walls|wet walls|fogging|dehumidif|natatorium|pool room air)\b/i,
    steps: [
      "Verify the pool-room HVAC or dehumidification system is powered and operating.",
      "Record room temperature and relative humidity if a reliable reading is available.",
      "Check whether supply and return air are moving normally and that grilles are not blocked.",
      "Inspect filters, coils, and accessible air paths for dirt, restriction, or icing.",
      "Check condensate pans and drains for standing water or blockage.",
      "Confirm exhaust, outdoor-air, and dehumidification functions are operating as designed for the pool area.",
      "Look for abnormal evaporation sources, including unusually warm pool water or doors/windows being held open.",
      "Record controller alarms, diagnostic codes, compressor/fan status, and cycling behavior before resetting equipment.",
      "Use the verified manual for the exact installed pool HVAC/dehumidifier before changing refrigerant, airflow, or control settings.",
    ],
  },
  {
    key: "ice-no-production",
    assetPattern: /\b(scotsman|ice machine|ice maker|icemaker)\b/i,
    issuePattern: /\b(not making ice|no ice|reduced ice|low ice|ice production|slow ice)\b/i,
    steps: [
      "Verify electrical power and confirm the ice machine is switched on.",
      "Confirm the water supply valve is open and water is reaching the machine.",
      "Check that the bin control is not falsely indicating a full bin.",
      "Inspect the water system, curtain, evaporator, and water-contact areas for mineral scale or buildup.",
      "Inspect the condenser and air intake for dirt, blockage, or poor airflow.",
      "Observe the fill, freeze, and harvest portions of the cycle and note exactly where operation stops.",
      "Record any status light, diagnostic code, or control indication before resetting the machine.",
    ],
  },
  {
    key: "washer-drain",
    assetPattern: /\b(unimac|washer|washing machine|washer extractor)\b/i,
    issuePattern: /\b(drain|draining|standing water|won'?t drain|will not drain|not draining)\b/i,
    steps: [
      "Verify the washer has power and the controls respond normally.",
      "Confirm the door/lock condition is satisfied.",
      "Inspect the drain hose, drain path, strainers, and accessible traps for restriction.",
      "Listen for drain-pump or drain-valve operation when draining should occur.",
      "Check the building drain or standpipe for backup before condemning the washer.",
      "Record any displayed fault or alarm before resetting the machine.",
    ],
  },
  {
    key: "washer-fill",
    assetPattern: /\b(unimac|washer|washing machine|washer extractor)\b/i,
    issuePattern: /\b(no fill|not filling|won'?t fill|will not fill|no water)\b/i,
    steps: [
      "Verify hot and cold water supplies are open as applicable.",
      "Inspect inlet hoses and accessible inlet screens for restriction.",
      "Confirm the door/lock condition is satisfied.",
      "Record any displayed fill, valve, or control fault before resetting.",
      "Verify the machine is commanding the inlet valve during the fill portion of the cycle.",
    ],
  },
  {
    key: "dryer-performance",
    assetPattern: /\b(unimac|dryer|tumble dryer|clothes dryer)\b/i,
    issuePattern: /\b(not drying|long dry|slow dry|no heat|overheating|takes too long)\b/i,
    steps: [
      "Clean the lint screen and inspect the lint path.",
      "Inspect the exhaust duct and exterior termination for restriction, crushing, or heavy lint buildup.",
      "Confirm the exterior damper opens and airflow is strong while the dryer runs.",
      "If the drum turns but there is no heat, record any displayed fault and verify the heat source is being commanded.",
      "Document temperature, airflow, noise, and cycle behavior before replacing components.",
    ],
  },
  {
    key: "water-heater",
    assetPattern: /\b(navien|water heater|tankless|boiler)\b/i,
    issuePattern: /\b(no hot water|not heating|ignition|error|fault|leak|temperature)\b/i,
    steps: [
      "Record the displayed error code before resetting the unit.",
      "Verify electrical power and required gas/water supplies.",
      "Confirm inlet water flow and inspect accessible filters or strainers for restriction.",
      "Inspect intake and exhaust paths for visible blockage where applicable.",
      "Check for leaks, abnormal fan noise, ignition attempts, or overheating indications.",
      "Use the exact model's service procedure before replacing combustion or control components.",
    ],
  },
  {
    key: "hvac-heating",
    categories: ["HVAC"],
    assetPattern: /\b(hvac|vtac|vtec|ptac|friedrich|zoneline|heat pump|furnace|thermostat)\b/i,
    issuePattern: /\b(not heating|no heat|cold room|heater not working|heat not working|won't heat|will not heat|bad heater)\b/i,
    steps: [
      "Verify thermostat power, HEAT mode, setpoint, and actual room temperature.",
      "Record any unit or thermostat diagnostic code before resetting power.",
      "Verify normal airflow and inspect the filter for restriction.",
      "Confirm the indoor fan operates when heat is being requested.",
      "Determine which heating method this exact unit uses and verify that heating stage is being commanded.",
      "Check applicable safety limits, lockouts, and control inputs before replacing parts.",
      "Use the verified service manual for the exact installed model before testing or replacing heating components.",
    ],
  },
  {
    key: "hvac-cooling",
    categories: ["HVAC"],
    assetPattern: /\b(hvac|vtac|vtec|ptac|friedrich|zoneline|air conditioner|heat pump|thermostat)\b/i,
    issuePattern: /\b(not cooling|no cooling|not getting cold|not cold|not cold enough|won't get cold|will not get cold|hot room|warm room|won't cool|will not cool|ac not working|a\/c not working)\b/i,
    steps: [
      "Verify thermostat power, COOL mode, setpoint, and actual room temperature.",
      "Record any unit or thermostat diagnostic code before resetting power.",
      "Verify normal airflow and inspect the filter for restriction.",
      "Confirm the indoor fan operates and determine whether the cooling stage is being commanded.",
      "Check condenser/heat-rejection airflow and visible coil condition as applicable to this exact unit.",
      "Record supply and return temperatures and operating observations before replacing components.",
      "Use the verified service manual for the exact installed model before refrigerant or component-level service.",
    ],
  },
  {
    key: "hvac-general",
    categories: ["HVAC"],
    assetPattern: /\b(hvac|vtac|vtec|ptac|friedrich|zoneline|air conditioner|heat pump|furnace|thermostat)\b/i,
    issuePattern: /\b(thermostat|fan|noise|loud|leak|water|humidity|humid)\b/i,
    steps: [
      "Verify thermostat/control settings and record the actual operating condition.",
      "Record any equipment or thermostat diagnostic code before resetting power.",
      "Verify airflow and inspect the filter for restriction.",
      "Check breaker, disconnect, and unit power status.",
      "Identify exactly which component or operating stage is involved before performing component-level testing.",
      "Use the verified service manual for the exact installed model for the reported symptom.",
    ],
  },
  {
    key: "pump-flow",
    assetPattern: /\b(pump|circulation pump|pool pump)\b/i,
    issuePattern: /\b(not pumping|no flow|low flow|not moving water|loss of prime|air in system|noise)\b/i,
    steps: [
      "Verify the pump has power and is being commanded to run.",
      "Confirm suction and discharge valves are in the correct positions.",
      "Check for loss of prime, air leaks, blocked strainers, or restricted piping.",
      "Listen for abnormal bearing, impeller, or motor noise.",
      "Record pressure, flow, amperage, or other available operating readings before replacing components.",
    ],
  },
  {
    key: "door-lock",
    assetPattern: /\b(saflok|dormakaba|door lock|guest room lock|key card|keycard|rfid lock)\b/i,
    issuePattern: /\b(not working|won'?t lock|will not lock|won'?t unlock|will not unlock|dead|failed|card|key)\b/i,
    steps: [
      "Confirm the exact failure: card read, unlock, intermittent unlock, latch, alignment, or dead lock.",
      "Test with a known-good authorized key/card where permitted.",
      "Inspect the door, latch, strike, and alignment before assuming an electronic failure.",
      "Record indicator lights, beeps, or error behavior.",
      "Verify battery/power condition and accessible connections according to the manufacturer procedure.",
    ],
  },
];

function stepWords(value: string) {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 4)
  );
}

function troubleshootingStepAlreadyDone(
  step: string,
  notesText: string,
  aiActions: string[]
) {
  const actions = [
    notesText,
    ...aiActions,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!actions.trim()) {
    return false;
  }

  const stepSet = stepWords(step);
  const actionSet = stepWords(actions);

  if (!stepSet.size) {
    return false;
  }

  let overlap = 0;

  for (const word of stepSet) {
    if (actionSet.has(word)) {
      overlap += 1;
    }
  }

  /*
   * Conservative filtering: only hide a fallback step when the technician
   * note/action text has substantial overlap. This avoids incorrectly
   * deleting steps merely because both contain generic words like "check".
   */
  return (
    overlap >= 3 &&
    overlap / stepSet.size >= 0.45
  );
}

function symptomRouteTroubleshooting(
  asset: Asset | undefined,
  category: string,
  issueText: string,
  notesText: string,
  aiActions: string[]
) {
  const assetText =
    `${asset?.name || ""} ${asset?.asset_type || ""}`.trim();

  const matches = SYMPTOM_ROUTES.filter((route) => {
    const assetMatch =
      !route.assetPattern ||
      route.assetPattern.test(assetText);

    const issueMatch =
      route.issuePattern.test(issueText);

    /*
     * Issue language is required. Category/asset identity helps narrow
     * the route but cannot create an unrelated troubleshooting domain.
     */
    // The reported symptom is the primary routing signal. Category and asset
    // help with context, but they must not suppress clear issue-based guidance.
    return issueMatch && assetMatch;
  });

  const unique = Array.from(
    new Set(
      matches.flatMap(
        (route) => route.steps
      )
    )
  );

  return unique.filter(
    (step) =>
      !troubleshootingStepAlreadyDone(
        step,
        notesText,
        aiActions
      )
  );
}

function generalTroubleshootingFor(
  asset: Asset | undefined,
  category: string,
  issueText: string,
  notesText = "",
  aiActions: string[] = []
) {
  const routed =
    symptomRouteTroubleshooting(
      asset,
      category,
      issueText,
      notesText,
      aiActions
    );

  if (routed.length) {
    return routed;
  }

  /*
   * UNIVERSAL LAST RESORT
   *
   * This is deliberately generic. Manufacturer/model-specific manual
   * guidance and the symptom router both outrank these checks.
   */
  return [
    "Confirm the reported problem and reproduce it if safe to do so.",
    "Inspect the affected equipment or area for obvious damage or abnormal condition.",
    "Record error messages, noises, odors, leaks, temperatures, pressures, or other useful symptoms.",
    "Determine whether the problem is isolated or affects other areas.",
    "Check the verified equipment documentation before replacing parts or changing settings.",
    "Document findings and any tests already performed.",
  ].filter(
    (step) =>
      !troubleshootingStepAlreadyDone(
        step,
        notesText,
        aiActions
      )
  );
}



function normalizeDiagnosticCode(
  code: string | null | undefined
) {
  const value = String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  return value || null;
}

function extractReportedErrorCode(
  issue: string
) {
  const text =
    issue.trim().toLowerCase();

  const matches = [
    text.match(
      /\b(?:code|error|fault)\s*[:#-]?\s*((?:[a-z]{1,4}[- ]?)?\d{1,4}[a-z0-9-]{0,6})\b/i
    ),
    text.match(
      /\b(?!(?:room|rm)\s*#?\s*\d)([a-z]{1,4}[- ]?\d{1,4}[a-z0-9-]{0,6})\b/i
    ),
  ];

  for (const match of matches) {
    if (match?.[1]) {
      return normalizeDiagnosticCode(
        match[1].replace(/\s+/g, "")
      );
    }
  }

  return null;
}



function formatDateTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function explicitPartSuggestion(issue: string) {
  const text = String(issue || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Only suggest a part when the report explicitly says a part is needed/replaced/ordered.
  // Symptom-only reports stay diagnostic and never guess a replacement part.
  const explicitNeed = /\b(needs?|need a|requires?|replace|replacement|order|install|broken and needs|necesita|reemplazar|cambiar|pedir)\b/.test(text);
  if (!explicitNeed) return "";
  if (/\b(garbage disposal|disposal|food waste disposer|triturador(?:a)?(?: de basura)?)\b/.test(text)) return "Garbage disposal";
  if (/\b(toilet seat|asiento de inodoro)\b/.test(text)) return "Toilet seat";
  if (/\b(shower head|showerhead|cabezal de ducha)\b/.test(text)) return "Shower head";
  if (/\b(smoke detector|smoke alarm|detector de humo)\b/.test(text)) return "Smoke detector";
  if (/\b(light bulb|lamp bulb|bombilla|foco)\b/.test(text)) return "Light bulb";
  return "";
}

function cleanTicketReportedIssue(value: string, roomLabel: string) {
  const room = String(roomLabel || "").match(/\b(\d{3})\b/)?.[1] || "";
  let cleaned = String(value || "").trim();
  if (room) {
    const prefix = new RegExp(`^\\s*(?:room|rm)?\\s*#?\\s*${room}\\b\\s*[-:,.]?\\s*`, "i");
    const suffix = new RegExp(`\\s+\\bin\\s+(?:room\\s*)?#?${room}\\b\\s*$`, "i");
    cleaned = cleaned.replace(prefix, "").replace(suffix, "").trim();
  }
  return cleaned.replace(/[A-Za-z]/, (letter) => letter.toUpperCase());
}

type TicketHistoryEntry = {
  id: string;
  timestamp: string;
  actor: string;
  kind: "note" | "change" | "system";
  text: string;
  staged?: boolean;
};

function parseTicketHistory(raw: string, fallbackTime?: string | null): TicketHistoryEntry[] {
  const lines = String(raw || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const entries: TicketHistoryEntry[] = [];
  const plain: string[] = [];
  lines.forEach((line, index) => {
    const match = line.match(/^CMPRI\|([^|]+)\|([^|]*)\|(note|change|system)\|(.*)$/);
    if (match) {
      entries.push({ id: `saved-${index}-${match[1]}`, timestamp: match[1], actor: match[2] || "CMPRI User", kind: match[3] as TicketHistoryEntry["kind"], text: match[4] });
    } else {
      plain.push(line);
    }
  });
  if (plain.length) entries.push({ id: "legacy-notes", timestamp: fallbackTime || new Date().toISOString(), actor: "Existing ticket", kind: "note", text: plain.join(" ") });
  return entries.sort((a,b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function historyLine(entry: TicketHistoryEntry) {
  return `CMPRI|${entry.timestamp}|${entry.actor.replace(/\|/g, "/")}|${entry.kind}|${entry.text.replace(/\n+/g, " ").replace(/\|/g, "/")}`;
}

export default function WorkOrderTicketPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const router = useRouter();

  const [order, setOrder] = useState<WorkOrder | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetReferenceLoading, setAssetReferenceLoading] = useState(true);
  const [assetReferenceError, setAssetReferenceError] = useState("");
  const [technicians, setTechnicians] = useState<TechnicianProfile[]>([]);
  const [manualResult, setManualResult] = useState<{ assetId: string; documentationKey: string | null; knowledge: ManualKnowledge | null; status: string } | null>(null);
  const [manualPagePreview, setManualPagePreview] = useState<number | null>(null);
  const [workOrderImages, setWorkOrderImages] = useState<WorkOrderImage[]>([]);
  const [imagePreview, setImagePreview] = useState<WorkOrderImage | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [embedded, setEmbedded] = useState(true);
  const [modalToken, setModalToken] = useState("");
  const [message, setMessage] = useState("");
  const [editingIssue, setEditingIssue] = useState(false);
  const [showAddAsset, setShowAddAsset] = useState(false);
  const [newAssetType, setNewAssetType] = useState("");
  const [newAssetManufacturer, setNewAssetManufacturer] = useState("");
  const [newAssetModel, setNewAssetModel] = useState("");
  const [newAssetSerial, setNewAssetSerial] = useState("");
  const [newAssetInstallDate, setNewAssetInstallDate] = useState("");
  const [newAssetDocumentType, setNewAssetDocumentType] = useState("Service Manual");
  const [newAssetDocument, setNewAssetDocument] = useState<File | null>(null);
  const historyScrollRef = useRef<HTMLDivElement | null>(null);

  const [issue, setIssue] = useState("");
  const [assetId, setAssetId] = useState("");
  const [systemGuessAssetId, setSystemGuessAssetId] = useState("");
  const [category, setCategory] = useState("General");
  const [priority, setPriority] = useState("Medium");
  const [technicianName, setTechnicianName] = useState("");
  const [status, setStatus] = useState("Open");
  const [notes, setNotes] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [mentionTickets, setMentionTickets] = useState<MentionTicket[]>([]);
  const [currentActor, setCurrentActor] = useState("CMPRI User");
  const [stagedNoteIds, setStagedNoteIds] = useState<string[]>([]);
  const [actionRootCause, setActionRootCause] = useState("");
  const [parts, setParts] = useState("");
  const [cost, setCost] = useState("");
  const [hours, setHours] = useState("");
  const [dueBy, setDueBy] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [externalActivity, setExternalActivity] = useState<ExternalActivity>({ purchases: [], enseo: [], warranties: [], followups: [] });
  const [roomOperationalContext, setRoomOperationalContext] = useState<RoomOperationalContext>({ ranker: null, pm: null, loading: false });
  const [initialFingerprint, setInitialFingerprint] = useState("");
  const [cmpriSession, setCmpriSession] = useState<CmpriClientSession | null>(null);

  const selectedAsset = assets.find((asset) => asset.id === assetId);
  const manualCurrent = manualResult?.assetId === assetId && manualResult?.documentationKey === selectedAsset?.documentation_key;
  const manualKnowledge = manualCurrent ? manualResult?.knowledge : null;
  const manualStatus = manualCurrent ? manualResult?.status : null;
  const manualLoading = !!selectedAsset && !manualCurrent;

  useEffect(() => {
    const pane = historyScrollRef.current;
    if (!pane) return;
    requestAnimationFrame(() => { pane.scrollTop = pane.scrollHeight; });
  }, [notes, order?.created_at]);

  async function loadMaintenanceReference() {
    setAssetReferenceLoading(true);
    setAssetReferenceError("");
    try {
      const session = await getValidSession();
      const token = session?.access_token;
      if (!token) throw new Error("Sign in again to load equipment.");
      const response = await fetch("/api/maintenance-reference", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload.assets)) {
        throw new Error(payload.error || "Equipment could not be loaded.");
      }
      const referenceAssets = payload.assets as Asset[];
      setAssets(referenceAssets);
      setTechnicians((payload.technicians ?? []) as TechnicianProfile[]);
      return referenceAssets;
    } catch (error) {
      setAssetReferenceError(error instanceof Error ? error.message : "Equipment could not be loaded.");
      return [] as Asset[];
    } finally {
      setAssetReferenceLoading(false);
    }
  }

  async function loadWorkOrderImages() {
    if (!id) return;
    try {
      const session = await getValidSession();
      if (!session?.access_token) return;
      const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}/attachments`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = await response.json();
      setWorkOrderImages(Array.isArray(payload.images) ? payload.images as WorkOrderImage[] : []);
    } catch {
      setWorkOrderImages([]);
    }
  }

  function seedTicketPreview(row: WorkOrder) {
    setOrder(row);
    const previewIssue = cleanTicketReportedIssue(row.issue || "", row.room || "");
    setIssue(previewIssue);
    setAssetId(row.asset_id || "");
    setSystemGuessAssetId(row.asset_id || "");
    setCategory(row.category || "General");
    setPriority(row.priority || "Medium");
    setTechnicianName(row.technician_name || "");
    setStatus(row.status || "Open");
    setNotes(row.notes || "");
    setNoteDraft("");
    setStagedNoteIds([]);
    setActionRootCause(row.action_root_cause || "");
    setParts(row.parts || explicitPartSuggestion(previewIssue));
    setCost(row.cost == null ? "" : String(row.cost));
    setHours(row.hours == null ? "" : String(row.hours));
    const previewDueBy = row.due_by ? String(row.due_by).slice(0, 10) : "";
    setDueBy(previewDueBy);
    setInitialFingerprint(JSON.stringify({
      issue: previewIssue,
      assetId: row.asset_id || "",
      category: row.category || "General",
      priority: row.priority || "Medium",
      technicianName: row.technician_name || "",
      status: row.status || "Open",
      notes: row.notes || "",
      actionRootCause: row.action_root_cause || "",
      parts: row.parts || "",
      cost: row.cost == null ? "" : String(row.cost),
      hours: row.hours == null ? "" : String(row.hours),
      dueBy: previewDueBy,
    }));
    setSaveState("idle");
    setLoading(false);
  }

  async function loadRoomOperationalContext(roomLabel?: string | null) {
    const room = String(roomLabel || "").match(/\b\d{2,4}\b/)?.[0] || "";
    if (!room) { setRoomOperationalContext({ ranker: null, pm: null, loading: false }); return; }
    setRoomOperationalContext((current) => ({ ...current, loading: true }));
    try {
      const session = await getValidSession();
      const token = session?.access_token;
      if (!token) return;
      const headers = { Authorization: `Bearer ${token}` };
      const [rankerResponse, pmResponse] = await Promise.all([
        fetch("/api/room-ranker", { headers, cache: "no-store" }),
        fetch(`/api/corporate-pm?room=${encodeURIComponent(room)}`, { headers, cache: "no-store" }),
      ]);
      const rankerPayload = rankerResponse.ok ? await rankerResponse.json().catch(() => ({})) : {};
      const pmPayload = pmResponse.ok ? await pmResponse.json().catch(() => null) : null;
      const rankerRows = Array.isArray(rankerPayload?.rooms) ? rankerPayload.rooms as RoomRankerContext[] : [];
      const ranker = rankerRows.find((item) => String(item.room || "").trim() === room) || null;
      setRoomOperationalContext({ ranker, pm: pmPayload && typeof pmPayload === "object" && !Array.isArray(pmPayload) ? pmPayload as Record<string, unknown> : null, loading: false });
    } catch {
      setRoomOperationalContext({ ranker: null, pm: null, loading: false });
    }
  }

  useEffect(() => {
    void Promise.resolve().then(() => loadRoomOperationalContext(order?.room));
  }, [order?.room]);

  async function loadExternalActivity() {
    if (!id) return;
    try {
      const session = await getValidSession();
      const token = session?.access_token;
      if (!token) return;
      const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}/activity`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = await response.json();
      setExternalActivity(payload || { purchases: [], enseo: [], warranties: [], followups: [] });
    } catch {
      // External email/purchasing activity is supplemental; ticket loading must never fail because of it.
    }
  }

  async function loadTicket(showLoading = true) {
    if (!id) return;

    if (showLoading) setLoading(true);
    setMessage("");

    try {
      const session = await getValidSession();
      const token = session?.access_token;
      if (!token) {
        setOrder(null);
        setMessage("Your CMPRI session has expired. Sign in again.");
        setLoading(false);
        return;
      }

      const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}?include=mentions`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.workOrder) {
        setOrder(null);
        setMessage(`Work order error: ${String(payload?.error || `HTTP ${response.status}`)}`);
        setLoading(false);
        return;
      }

      setMentionTickets(((payload.mentionTickets ?? []) as MentionTicket[]).filter((ticket) => !!ticket.id));
      const row = payload.workOrder as WorkOrder;
      setOrder(row);
      const loadedIssue = cleanTicketReportedIssue(row.issue || "", row.room || "");
      setIssue(loadedIssue);
      setAssetId(row.asset_id || "");
      setSystemGuessAssetId(row.asset_id || "");
      setCategory(row.category || "General");
      setPriority(row.priority || "Medium");
      setTechnicianName(row.technician_name || "");
      setStatus(row.status || "Open");
      setNotes(row.notes || "");
      setNoteDraft("");
      setStagedNoteIds([]);
      setActionRootCause(row.action_root_cause || "");
      setParts(row.parts || explicitPartSuggestion(loadedIssue));
      setCost(row.cost == null ? "" : String(row.cost));
      setHours(row.hours == null ? "" : String(row.hours));
      const normalizedDueBy = row.due_by ? String(row.due_by).slice(0, 10) : "";
      setDueBy(normalizedDueBy);
      setInitialFingerprint(JSON.stringify({
        issue: cleanTicketReportedIssue(row.issue || "", row.room || ""),
        assetId: row.asset_id || "",
        category: row.category || "General",
        priority: row.priority || "Medium",
        technicianName: row.technician_name || "",
        status: row.status || "Open",
        notes: row.notes || "",
        actionRootCause: row.action_root_cause || "",
        parts: row.parts || "",
        cost: row.cost == null ? "" : String(row.cost),
        hours: row.hours == null ? "" : String(row.hours),
        dueBy: normalizedDueBy,
      }));
      setSaveState("idle");

      // Render the ticket immediately. Reference data can finish loading in the
      // background; the user should not wait on assets/technicians just to read a work order.
      setLoading(false);
      void loadMaintenanceReference();
    } catch (error) {
      setOrder(null);
      setMessage(`Work order error: ${error instanceof Error ? error.message : String(error)}`);
      setLoading(false);
    }
  }

  async function loadManualForAsset(asset?: Asset, isCurrent: () => boolean = () => true) {
    if (!asset) return;
    let knowledge: ManualKnowledge | null = null;
    let documentationStatus = "lookup_unavailable";
    try {
      const session = await getValidSession();
      const token = session?.access_token;
      if (!token) return;
      const response = await fetch(`/api/maintenance-reference?assetId=${encodeURIComponent(asset.id)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = await response.json();
      knowledge = normalizeManualKnowledge(payload?.manualKnowledge);
      documentationStatus = String(payload?.documentation_status || (knowledge?.source?.verified ? "verified" : "not_found"));
    } catch {
      knowledge = null;
    } finally {
      if (isCurrent()) setManualResult({ assetId: asset.id, documentationKey: asset.documentation_key, knowledge, status: documentationStatus });
    }
  }

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const isEmbedded = search.get("embedded") === "1";
    const token = search.get("modalToken") || "";
    if (isEmbedded && token && window.parent !== window) {
      window.parent.postMessage(
        { type: "cmpri-modal-ready", modalKind: "workOrder", workOrderId: id, modalToken: token },
        window.location.origin
      );
    }
    (async () => {
      const allowed = await enforceSessionPreference();
      setEmbedded(isEmbedded);
      setModalToken(token);
      if (!allowed) {
        window.location.replace("/");
        return;
      }
      try {
        const session = await loadCmpriSession();
        setCmpriSession(session);
        const canViewTicket = session.capabilities.includes("view_dashboard") || session.capabilities.includes("edit_tickets") || session.capabilities.includes("review_tickets");
        if (!canViewTicket) {
          window.location.replace("/work-orders");
          return;
        }
        if (session.user.name) setCurrentActor(session.user.name);
      } catch {
        window.location.replace("/");
        return;
      }
      let hadPreview = false;
      try {
        const raw = window.sessionStorage.getItem(`cmpri:work-order-preview:${id}`);
        if (raw) {
          seedTicketPreview(JSON.parse(raw) as WorkOrder);
          hadPreview = true;
        }
      } catch {}
      await loadTicket(!hadPreview);
      void loadWorkOrderImages();
      void loadExternalActivity();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    // Re-run after the asset reference list arrives. Previously assetId was
    // set before assets finished loading, so existing tickets never loaded
    // their model-specific troubleshooting until the asset was changed.
    let current = true;
    void loadManualForAsset(selectedAsset, () => current);
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, selectedAsset?.id, selectedAsset?.documentation_key]);

  function handleAssetChange(newAssetId: string) {
    setAssetId(newAssetId);
    setManualPagePreview(null);
    
    const asset = assets.find((item) => item.id === newAssetId);
    if (asset) {
      const nextCategory = categoryForAsset(asset);
      setCategory(nextCategory);
      setPriority(priorityForCategory(nextCategory));
    }
  }

  const combinedDiagnosticText = `${issue} ${order?.reporter_notes || ""} ${notes} ${actionRootCause}`.trim();
  const completedWorkNotes = `${notes} ${actionRootCause}`.trim();

  const generalTroubleshooting = generalTroubleshootingFor(
    selectedAsset,
    category,
    issue,
    completedWorkNotes,
    []
  );

  const trustedManualKnowledge = manualKnowledge?.source?.verified === true;
  const matchingSymptomRules = trustedManualKnowledge
    ? manualKnowledge?.symptom_rules?.filter((rule) => {
        const evidence = combinedDiagnosticText.toLowerCase();
        if (!rule.match?.length) return true;
        if (!evidence) return false;
        return rule.match.some((phrase) => evidence.includes(String(phrase || "").toLowerCase()));
      }) ?? []
    : [];

  const manualSteps = Array.from(
    new Set(matchingSymptomRules.flatMap((rule) => rule.steps))
  ).filter((step) => !troubleshootingStepAlreadyDone(step, completedWorkNotes, []));

  const reportedCode = extractReportedErrorCode(combinedDiagnosticText);
  const manualErrorCodes = (() => {
    const byCode = new Map<string, ManualErrorCode>();
    if (trustedManualKnowledge) {
      for (const item of manualKnowledge?.error_codes ?? []) {
        const code = normalizeDiagnosticCode(item.code);
        if (code) byCode.set(code, item);
      }
    }
    return Array.from(byCode.values());
  })();

  const matchingErrorCode = reportedCode
    ? manualErrorCodes.find((item) => normalizeDiagnosticCode(item.code) === reportedCode)
    : undefined;

  const diagnosticEvidence = combinedDiagnosticText.toLowerCase();
  const coolingComplaint = /\b(not cooling|no cooling|not cold|not getting cold|won't cool|will not cool|warm room|hot room|cooling|a\/?c|air condition)/i.test(diagnosticEvidence);
  const heatingComplaint = /\b(no heat|not heating|won't heat|will not heat|heating|heat pump)/i.test(diagnosticEvidence);
  const diagnosticKeywords = coolingComplaint
    ? ["cool", "coil", "temperature", "thermostat", "compressor", "pressure", "voltage", "fan"]
    : heatingComplaint
      ? ["heat", "coil", "temperature", "thermostat", "reversing", "voltage", "fan"]
      : diagnosticEvidence.split(/[^a-z0-9]+/).filter((word) => word.length >= 5);

  const relevantErrorCodes = manualErrorCodes
    .map((item) => {
      const haystack = `${item.problem} ${item.action}`.toLowerCase();
      const score = diagnosticKeywords.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
      return { item, score };
    })
    .filter(({ item, score }) =>
      (reportedCode && normalizeDiagnosticCode(item.code) === reportedCode) || score > 0
    )
    .sort((a, b) => {
      if (reportedCode) {
        const aExact = normalizeDiagnosticCode(a.item.code) === reportedCode ? 1 : 0;
        const bExact = normalizeDiagnosticCode(b.item.code) === reportedCode ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
      }
      return b.score - a.score;
    })
    .slice(0, 6)
    .map(({ item }) => item);

  const displayedSteps = generalTroubleshooting.slice(0, 10);

  const currentFingerprint = JSON.stringify({
    issue,
    assetId,
    category,
    priority,
    technicianName,
    status,
    notes,
    actionRootCause,
    parts,
    cost,
    hours,
    dueBy,
  });
  const hasUnsavedChanges = !!initialFingerprint && currentFingerprint !== initialFingerprint;
  const roomRankerFlags = [roomOperationalContext.ranker?.check1, roomOperationalContext.ranker?.check2, roomOperationalContext.ranker?.check3, roomOperationalContext.ranker?.notes].map((value) => String(value || "").trim()).filter(Boolean);
  const pmSummaryEntries = roomOperationalContext.pm
    ? Object.entries(roomOperationalContext.pm)
        .filter(([key, value]) => !["ok", "can_edit", "key"].includes(key) && value !== null && value !== undefined && typeof value !== "object")
        .slice(0, 8)
    : [];


  function closeEmbeddedTicket() {
    if (embedded && window.parent !== window) {
      window.parent.postMessage(
        { type: "cmpri-work-order-cancelled", modalKind: "workOrder", workOrderId: order?.id, modalToken },
        window.location.origin
      );
      return;
    }
    router.push("/engineering");
  }

  async function addAssetFromTicket() {
    if (!order || !order.location_id || !newAssetType.trim()) {
      setMessage("A room/location and equipment type are required.");
      return;
    }
    const session = await getValidSession();
    const token = session?.access_token || "";
    const response = await fetch("/api/assets", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        location_id: order.location_id,
        asset_type: newAssetType.trim(),
        manufacturer: newAssetManufacturer.trim(),
        model_number: newAssetModel.trim(),
        serial_number: newAssetSerial.trim(),
        install_year: newAssetInstallDate ? new Date(`${newAssetInstallDate}T12:00:00`).getFullYear() : null,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { setMessage(payload.error || "Unable to add asset."); return; }
    const created = payload.asset as Asset;

    let documentationMessage = "";
    if (newAssetDocument) {
      const form = new FormData();
      form.append("asset_id", created.id);
      form.append("document_type", newAssetDocumentType);
      form.append("file", newAssetDocument);
      const documentationResponse = await fetch("/api/assets/documentation", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const documentationPayload = await documentationResponse.json().catch(() => ({}));
      documentationMessage = documentationResponse.ok
        ? ` Documentation uploaded (${newAssetDocumentType}).`
        : ` Asset created, but documentation upload failed: ${documentationPayload.error || "unknown error"}`;
    }

    setAssets((items) => [...items.filter((item) => item.id !== created.id), created].sort((a,b) => a.name.localeCompare(b.name)));
    setAssetId(created.id);
    setCategory(categoryForAsset(created));
    setShowAddAsset(false);
    
    setNewAssetType(""); setNewAssetManufacturer(""); setNewAssetModel(""); setNewAssetSerial("");
    setNewAssetInstallDate(""); setNewAssetDocumentType("Service Manual"); setNewAssetDocument(null);
    setMessage(`New asset added and selected. Save the work order to make the assignment final.${documentationMessage}`);
  }

  function submitTechnicianNote() {
    const text = noteDraft.trim();
    if (!text) return;
    const entry: TicketHistoryEntry = { id: `staged-${Date.now()}`, timestamp: new Date().toISOString(), actor: currentActor, kind: "note", text, staged: true };
    const encoded = historyLine(entry);
    setNotes((existing) => [existing.trim(), encoded].filter(Boolean).join("\n"));
    // Track the exact staged history line, not a generated parser id. That makes
    // Edit target the note that was just submitted instead of an older note.
    setStagedNoteIds((lines) => [...lines, encoded]);
    setNoteDraft("");
  }

  function editSubmittedNote(entry: TicketHistoryEntry) {
    if (!entry.staged) return;
    const encoded = historyLine(entry);
    setNoteDraft(entry.text);
    setNotes((existing) => existing.split("\n").filter((line) => line.trim() !== encoded).join("\n"));
    setStagedNoteIds((lines) => lines.filter((line) => line !== encoded));
    requestAnimationFrame(() => document.getElementById("technician-note-editor")?.focus());
  }

  async function claimUnassignedWorkOrder() {
    if (!order) return;
    const assignedName = cmpriSession?.user.name?.trim();
    if (!assignedName) {
      setMessage("Your profile needs a name before you can take an unassigned work order.");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const headers = await authorizationHeaders();
      headers["Content-Type"] = "application/json";
      const response = await fetch(`/api/work-orders/${encodeURIComponent(order.id)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          expected_revision: order.revision,
          technician_name: assignedName,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.workOrder) {
        throw new Error(payload.error || "This work order could not be assigned to you.");
      }
      const claimed = payload.workOrder as WorkOrder;
      setOrder(claimed);
      setTechnicianName(assignedName);
      setInitialFingerprint(JSON.stringify({
        issue, assetId, category, priority, technicianName: assignedName, status, notes,
        actionRootCause, parts, cost, hours, dueBy,
      }));
      setSaveState("idle");
      setMessage("This work order is now assigned to you.");
      if (embedded && window.parent !== window) {
        window.parent.postMessage(
          { type: "cmpri-work-order-saved", modalKind: "workOrder", workOrderId: order.id, modalToken },
          window.location.origin,
        );
      }
    } catch (error) {
      setMessage(`Assignment error: ${error instanceof Error ? error.message : "This work order could not be assigned to you."}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveTicket() {
    if (!order) return;

    const normalizedIssue = cleanTicketReportedIssue(issue, order.room || "");
    if (!normalizedIssue.trim()) {
      setMessage("Reported Issue is required.");
      return;
    }
    if (normalizedIssue !== issue) setIssue(normalizedIssue);

    setSaving(true);
    setSaveState("saving");
    setMessage("");

    const asset = assets.find((item) => item.id === assetId);
    const fieldChanges: string[] = [];
    if (order.asset_id !== (asset?.id ?? null)) fieldChanges.push(`Asset: ${order.asset_name || "None"} → ${asset?.name || "None"}`);
    if ((order.category || "General") !== category) fieldChanges.push(`Category: ${order.category || "General"} → ${category}`);
    if ((order.priority || "Medium") !== priority) fieldChanges.push(`Priority: ${order.priority || "Medium"} → ${priority}`);
    if ((order.technician_name || "") !== technicianName.trim()) fieldChanges.push(`Technician: ${order.technician_name || "Unassigned"} → ${technicianName.trim() || "Unassigned"}`);
    if ((order.status || "Open") !== status) fieldChanges.push(`Status: ${order.status || "Open"} → ${status}`);
    const originalDue = order.due_by ? String(order.due_by).slice(0,10) : "";
    if (originalDue !== dueBy) fieldChanges.push(`Due By: ${originalDue || "None"} → ${dueBy || "None"}`);
    if (cleanTicketReportedIssue(order.issue || "", order.room || "") !== normalizedIssue) fieldChanges.push("Reported Issue updated");
    const changeLines = fieldChanges.map((text, index) => historyLine({ id: `change-${index}`, timestamp: new Date(Date.now() + index).toISOString(), actor: currentActor, kind: "change", text }));
    const notesWithChanges = [notes.trim(), ...changeLines].filter(Boolean).join("\n");

    const updatePayload: Record<string, unknown> = {
      expected_revision: order.revision,
    };
    const capabilities = typeof cmpriSession !== "undefined" ? (cmpriSession?.capabilities ?? []) : ["edit_tickets"];
    if (capabilities.includes("edit_tickets")) {
      Object.assign(updatePayload, {
        issue: normalizedIssue,
        asset_id: asset?.id ?? null,
        asset_name: asset?.name ?? "",
        category,
        priority,
        technician_name: technicianName.trim(),
        status,
        notes: notesWithChanges,
        action_root_cause: actionRootCause.trim(),
        parts: parts.trim(),
        cost: cost.trim() === "" ? 0 : Number(cost),
        hours: hours.trim() === "" ? 0 : Number(hours),
        due_by: dueBy || null,
      });
    } else if (capabilities.includes("review_tickets")) {
      if ((order.status || "Open") !== status) updatePayload.status = status;
      if (notesWithChanges !== (order.notes || "")) updatePayload.notes = notesWithChanges;
    } else {
      setMessage("This account is view-only.");
      setSaving(false);
      setSaveState("idle");
      return;
    }
    if (Object.keys(updatePayload).length === 1) {
      setMessage("There are no changes to save.");
      setSaving(false);
      setSaveState("idle");
      return;
    }

    let savedRow: WorkOrder | null = null;
    try {
      const session = await getValidSession();
      const token = session?.access_token || "";
      const response = await fetch(`/api/work-orders/${encodeURIComponent(order.id)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(updatePayload),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Work order update failed.");
      savedRow = (payload.workOrder || null) as WorkOrder | null;
    } catch (error) {
      setMessage(`Save error: ${error instanceof Error ? error.message : "Work order update failed."}`);
      setSaving(false);
      setSaveState("idle");
      // Keep unsaved edits and staged notes available for a deliberate retry.
      return;
    }

    if (savedRow) setOrder(savedRow);
    setNotes(notesWithChanges);
    setStagedNoteIds([]);

    setInitialFingerprint(JSON.stringify({
      issue: normalizedIssue, assetId, category, priority, technicianName, status, notes: notesWithChanges,
      actionRootCause, parts, cost, hours, dueBy,
    }));
    setSaving(false);
    setSaveState("saved");

    window.setTimeout(() => {
      if (embedded && window.parent !== window) {
        window.parent.postMessage(
          { type: "cmpri-work-order-saved", modalKind: "workOrder", workOrderId: order.id, modalToken },
          window.location.origin
        );
        return;
      }
      router.push("/engineering");
    }, 1250);
  }

  function cancelTicket() {
    if (hasUnsavedChanges) {
      setShowCancelConfirm(true);
      return;
    }
    closeEmbeddedTicket();
  }

  useEffect(() => {
    if (!embedded) return;
    const handleModalCancelRequest = (event: Event) => {
      event.preventDefault();
      cancelTicket();
    };
    document.addEventListener("cmpri-modal-cancel-request", handleModalCancelRequest);
    return () => document.removeEventListener("cmpri-modal-cancel-request", handleModalCancelRequest);
  }, [embedded, hasUnsavedChanges]);

  if (loading) {
    return (
      <main className="min-h-screen bg-slate-950 p-6 text-white">
        Loading work order...
      </main>
    );
  }

  if (!order) {
    return (
      <main className="min-h-screen bg-slate-950 p-6 text-white">
        <Link href="/engineering" className="text-amber-400">
          ← Engineering Dashboard
        </Link>
        <div className="mt-6 rounded-xl border border-red-400/30 bg-red-950/20 p-4">
          {message || "Work order not found."}
        </div>
      </main>
    );
  }

  const technicianOptions = [
    { value: "", label: "Unassigned" },
    ...technicians
      .filter((profile) => !!profile.full_name?.trim())
      .map((profile) => ({
        value: profile.full_name!.trim(),
        label: profile.full_name!.trim(),
      })),
  ];

  if (
    technicianName.trim() &&
    !technicianOptions.some((option) => option.value === technicianName.trim())
  ) {
    technicianOptions.push({
      value: technicianName.trim(),
      label: `${technicianName.trim()} (current assignment)`,
    });
  }

  const roomNumber = String(order?.room || "").trim();
  const issueText = `${issue} ${notes}`.toLowerCase();
  const roomText = roomNumber.toLowerCase();

  function assetIssueScore(asset: Asset) {
    const text = [
      asset.name,
      asset.asset_type,
      asset.manufacturer || "",
      asset.model_number || "",
      asset.asset_tag || "",
    ].join(" ").toLowerCase();

    let score = 0;
    if (asset.id === assetId) score += 25;
    if (order?.location_id && asset.location_id === order.location_id) score += 180;
    else if (order?.location_id) score -= 80;
    if (categoryForAsset(asset) === category) score += 70;
    else if (category !== "General") score -= 25;
    if (roomText && text.includes(roomText)) score += 35;
    if (roomText.includes("pool") && text.includes("pool")) score += 20;

    const humidityIssue = /\b(humid|humidity|moisture|condensation|muggy)\b/.test(issueText);
    const coolingIssue = /\b(not cooling|not cold|too warm|warm room|no cool|no cooling)\b/.test(issueText);
    const tvIssue = /\b(tv|television|no picture|no signal)\b/.test(issueText);
    const plumbingIssue = /\b(leak|leaking|drain|sink|toilet|faucet|shower)\b/.test(issueText);

    if (humidityIssue) {
      if (/dehumid|ventilat|exhaust|air handler|hvac|air condition|make.?up air|fan/.test(text)) score += 120;
      if (/sand filter|bromine|chemical|pool filter|circulation pump/.test(text)) score -= 70;
    }
    if (coolingIssue && /hvac|vtac|ptac|friedrich|air condition|heat pump|thermostat/.test(text)) score += 120;
    if (tvIssue) {
      // Prefer the physical display/TV over the Enseo/set-top system when the complaint says the TV itself is broken.
      if (/\b(tv|television|display|lg|samsung|vizio)\b/.test(text)) score += 150;
      if (/enseo|set.?top|stb|receiver/.test(text)) score -= 45;
      if (/camera|surveillance|cctv/.test(text)) score -= 300;
      if (/bedroom/.test(issueText) && /bedroom/.test(text)) score += 90;
      if (/living room|livingroom/.test(issueText) && /living room|livingroom/.test(text)) score += 90;
    }
    if (plumbingIssue && /plumb|sink|toilet|faucet|shower|drain|valve/.test(text)) score += 100;

    return score;
  }

  const activeAssets = assets.filter((asset) => asset.active !== false);
  const rankedAssets = [...activeAssets].sort((a, b) => {
    const delta = assetIssueScore(b) - assetIssueScore(a);
    if (delta !== 0) return delta;
    return a.name.localeCompare(b.name);
  });

  const assetOptions = [
    ...rankedAssets.map((asset) => {
      const score = assetIssueScore(asset);
      const exactLocation = !!order?.location_id && asset.location_id === order.location_id;
      const sameCategory = categoryForAsset(asset) === category;
      const group = exactLocation && score >= 180
        ? "Best Match — This Location"
        : exactLocation && sameCategory
          ? "This Location — Same Category"
          : exactLocation
            ? "This Location"
            : score >= 80
              ? "Recommended"
              : "Other Locations";
      return {
        value: asset.id,
        label: asset.location_name ? `${asset.name} — ${asset.location_name}` : asset.name,
        group,
        keywords: [
          asset.asset_type,
          asset.manufacturer || "",
          asset.model_number || "",
          asset.asset_tag || "",
          asset.location_name || "",
          order?.room || "",
        ],
      };
    }),
    {
      value: "",
      label: "No specific asset / equipment",
      group: "Other",
    },
  ];


  const categoryOptions = workOrderCategoryOptions(category);
  const priorityOptions = ['Urgent','High','Medium','Low'].map((value) => ({ value, label: value }));
  const canEditTicket = Boolean(cmpriSession?.capabilities.includes("edit_tickets"));
  const canReviewTicket = Boolean(cmpriSession?.capabilities.includes("review_tickets"));
  const canReopenTicket = Boolean(cmpriSession?.capabilities.includes("reopen"));
  const isTechnician = ["technician", "maintenancetechnician"].includes(
    (cmpriSession?.user.role || "").toLowerCase().replace(/[\s_-]+/g, ""),
  );
  const canClaimWorkOrder = isTechnician &&
    !String(order.technician_name || "").trim() &&
    ["Open", "In Progress"].includes(String(order.status || "Open"));
  const statusValues = (() => {
    if (canReviewTicket && !canEditTicket) {
      return status === "Pending Verification" ? ["Pending Verification", "Open", "Will Not Do"] : [status];
    }
    if (!canEditTicket) return [status];
    if (status === "Closed") return canReopenTicket ? ["Closed", "In Progress", "Completed"] : ["Closed"];
    const values = ["Open", "In Progress", "Completed", "Will Not Do", "Closed"];
    return status === "Pending Verification" ? ["Pending Verification", ...values] : values;
  })();
  const statusOptions = Array.from(new Set(statusValues)).map((value) => ({ value, label: value }));
  const mentionMatch = noteDraft.match(/(?:^|\s)@([A-Za-z0-9-]*)$/);
  const mentionQuery = (mentionMatch?.[1] || "").toLowerCase();
  const mentionSuggestions = mentionMatch
    ? mentionTickets
        .filter((ticket) => {
          if (!mentionQuery) return true;
          const haystack = [ticket.display_id, ticket.room, ticket.issue, ticket.status, ticket.id.slice(0, 8)].filter(Boolean).join(" ").toLowerCase();
          return haystack.includes(mentionQuery);
        })
        .slice(0, 6)
    : [];

  function ticketMentionLabel(ticket: MentionTicket) {
    return String(ticket.display_id || `WO-${ticket.id.slice(0, 8)}`).replace(/^@/, "");
  }

  function insertTicketMention(ticket: MentionTicket) {
    if (!mentionMatch) return;
    const label = ticketMentionLabel(ticket);
    setNoteDraft((draft) => draft.replace(/(?:^|\s)@[A-Za-z0-9-]*$/, (matched) => `${matched.startsWith(" ") ? " " : ""}@${label} `));
  }

  function openMentionedTicket(ticket: MentionTicket) {
    if (embedded && window.parent !== window) {
      window.parent.postMessage(
        { type: "cmpri-open-related-work-order", modalKind: "workOrder", workOrderId: order?.id, targetWorkOrderId: ticket.id, modalToken },
        window.location.origin
      );
      return;
    }
    router.push(`/work-orders/${encodeURIComponent(ticket.id)}`);
  }

  function renderHistoryText(text: string) {
    const pieces = text.split(/(@[A-Za-z0-9-]+)/g);
    return pieces.map((piece, index) => {
      if (!piece.startsWith("@")) return <span key={`text-${index}`}>{piece}</span>;
      const token = piece.slice(1).toLowerCase();
      const ticket = mentionTickets.find((candidate) => {
        const label = ticketMentionLabel(candidate).toLowerCase();
        return label === token || candidate.id.toLowerCase().startsWith(token.replace(/^wo-/, ""));
      });
      if (!ticket) return <span key={`mention-${index}`} className="font-semibold text-sky-300">{piece}</span>;
      return (
        <button key={`mention-${index}`} type="button" onClick={() => openMentionedTicket(ticket)} className="font-semibold text-sky-300 underline decoration-sky-500/60 underline-offset-2 hover:text-sky-200" title={`Open ${ticketMentionLabel(ticket)} — ${ticket.room || "No location"}`}>
          {piece}
        </button>
      );
    });
  }
  const parsedHistory = parseTicketHistory(notes, order.created_at);
  const stagedLineSet = new Set(stagedNoteIds);
  const historyEntries: TicketHistoryEntry[] = parsedHistory.map((entry) => ({
    ...entry,
    staged: entry.kind === "note" && stagedLineSet.has(historyLine(entry)),
  }));
  const authoritativeHistory = externalActivity.history || [];
  for (const event of authoritativeHistory) {
    const fields = event.changed_fields && typeof event.changed_fields === "object" ? Object.keys(event.changed_fields) : [];
    const statusText = event.old_status !== event.new_status && event.new_status
      ? `Status ${event.old_status || "—"} → ${event.new_status}`
      : "";
    const fieldText = fields.filter((field) => field !== "notes").map((field) => field.replace(/_/g, " ")).join(", ");
    const text = [statusText, fieldText ? `Updated ${fieldText}` : ""].filter(Boolean).join(" · ") || String(event.event_type || "Work order updated").replace(/_/g, " ");
    historyEntries.push({
      id: `db-${event.id}`,
      timestamp: event.recorded_at || order.created_at || new Date(0).toISOString(),
      actor: event.actor_name || "CMPRI User",
      kind: event.event_type === "created" ? "system" : "change",
      text,
    });
  }
  if (!externalActivity.history_configured && order.created_at) {
    historyEntries.push({ id: "created", timestamp: order.created_at, actor: "System", kind: "system", text: "Work order created" });
  }
  const uniqueHistory = new Map<string, TicketHistoryEntry>();
  for (const entry of historyEntries) uniqueHistory.set(`${entry.timestamp}|${entry.actor}|${entry.kind}|${entry.text}`, entry);
  historyEntries.splice(0, historyEntries.length, ...Array.from(uniqueHistory.values()));
  historyEntries.sort((a,b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  return (
    <main className="min-h-screen bg-slate-950 text-[16px] text-white">
      <div className="mx-auto max-w-5xl px-3 pb-4 sm:px-4">
        <div className="sticky top-0 z-20 -mx-4 flex flex-col gap-4 border-b border-slate-800 bg-slate-950/95 px-4 py-4 backdrop-blur sm:-mx-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            {!embedded && (
              <Link
                href="/engineering"
                className="text-sm font-semibold text-amber-400 hover:text-amber-300"
              >
                ← Engineering Dashboard
              </Link>
            )}
            <div className="mt-2 flex flex-wrap items-start gap-3">
              <div className="min-w-0">
                <h1 className="text-3xl font-bold leading-none sm:text-4xl">{order.room || "Work Order"}</h1>
                <p className="mt-1 max-w-[22rem] truncate text-sm leading-5 text-slate-200 sm:max-w-[26rem]" title={issue || "No reported issue"}>
                  {issue || "No reported issue"}
                </p>
              </div>
              <div className="flex items-start gap-2 pt-0.5">
                <div className="grid w-max justify-items-stretch gap-0.5 text-center">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Priority</span>
                  <span className={`rounded-full border px-3 py-1 text-center text-xs font-semibold ${priorityBubbleClass(priority)}`}>
                    {priority}
                  </span>
                </div>
                <div className="grid w-max justify-items-stretch gap-0.5 text-center">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Status</span>
                  <span className={`rounded-full border px-3 py-1 text-center text-xs font-semibold ${statusBubbleClass(status)}`}>
                    {status}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="ml-auto flex shrink-0 items-end gap-2 self-end">
            <button
              type="button"
              onClick={cancelTicket}
              disabled={saving}
              className="rounded-lg border border-slate-600 px-5 py-3 text-sm font-semibold text-slate-200 hover:bg-slate-900 disabled:opacity-60"
            >
              Cancel
            </button>
            <div className="grid justify-items-center gap-1">
              <button
                type="button"
                title="Copy work order number"
                onClick={() => { if (order.display_id) void navigator.clipboard?.writeText(order.display_id); }}
                className="rounded-full border border-orange-500/50 bg-orange-950/45 px-2.5 py-1 text-[11px] font-bold text-orange-200"
              >
                {order.display_id || "Work Order"}
              </button>
              {(canEditTicket || canReviewTicket) && <button
                type="button"
                onClick={saveTicket}
                disabled={saving || saveState === "saved"}
                className={`rounded-lg border px-5 py-3 text-sm font-bold transition-colors disabled:opacity-80 ${
                  saveState === "saved"
                    ? "border-emerald-500 bg-emerald-600 text-white"
                    : saveState === "saving"
                      ? "border-red-900 bg-red-950/70 text-red-200"
                      : hasUnsavedChanges
                        ? "border-red-500 bg-red-600 text-white ring-2 ring-red-400/20 hover:bg-red-500"
                        : "border-blue-500 bg-blue-700 text-white hover:bg-blue-600"
                }`}
              >
                {saveState === "saving"
                  ? "Saving..."
                  : saveState === "saved"
                    ? "Saved"
                    : hasUnsavedChanges
                      ? "Save Changes"
                      : "Save Work Order"}
              </button>}
            </div>
          </div>
        </div>

        {message && (
          <div className="mt-5 rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm">
            {message}
          </div>
        )}

        <div className="mt-3 grid gap-3 xl:grid-cols-[1fr_370px]">
          <div className="space-y-3">
            <section className="rounded-xl border border-slate-800 bg-slate-900 p-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-[30px] font-bold leading-tight tracking-tight">Reported Issue</h2>
                  {(canEditTicket || canReviewTicket) && <button
                    type="button"
                    onClick={() => {
                      const next = !editingIssue;
                      setEditingIssue(next);
                    }}
                    className={`rounded-lg border px-2.5 py-1.5 text-xs font-bold ${editingIssue ? "border-amber-400 bg-amber-950/40 text-amber-100" : "border-slate-700 text-amber-300 hover:bg-slate-800"}`}
                  >
                    {editingIssue ? "Done Editing" : "✎ Edit Issue"}
                  </button>}
                </div>
                <div className="text-right text-[11px] leading-4 text-slate-500">
                  <div>Created by <span className="font-semibold text-slate-300">{order.creator_name || "—"}</span></div>
                  <div>{formatDateTime(order.created_at)}</div>
                </div>
              </div>

              {editingIssue && canEditTicket ? (
                <>
                  <textarea
                    required
                    value={issue}
                    onChange={(event) => setIssue(event.target.value)}
                    rows={Math.max(3, Math.min(10, issue.split("\n").length + Math.floor(issue.length / 70)))}
                    className="mt-3 w-full resize-y rounded-xl border border-slate-700 bg-slate-950 p-3 text-base text-white outline-none focus:border-amber-400"
                  />
                  <div className="mt-2 rounded-lg border border-sky-500/25 bg-sky-950/20 px-3 py-2 text-xs text-sky-100/80">
                    Editing an existing ticket never creates additional work orders. Additional problems entered here remain attached to this ticket as sub-issues unless someone deliberately creates a separate work order.
                  </div>
                </>
              ) : (
                <p className="mt-3 whitespace-pre-wrap text-base leading-6 text-slate-200">{issue || "—"}</p>
              )}

              {order.reporter_notes && (
                <div className="mt-3 rounded-lg border border-slate-700 bg-slate-950/60 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reporter Notes</div>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-slate-300">{order.reporter_notes}</p>
                </div>
              )}

              {status === "Pending Verification" && canReviewTicket && (
                <div className="mt-4 flex justify-end">
                  <button type="button" onClick={() => { setStatus("Open"); setMessage("Verified. Save the work order to approve it and move it into the active Open queue."); }} className="rounded-lg border border-purple-400/50 bg-purple-950/40 px-3 py-2 text-xs font-bold text-purple-100 hover:bg-purple-900/50">Approve → Open</button>
                </div>
              )}

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-slate-800 bg-slate-950/55 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Asset / Equipment</div>
                  {editingIssue && canEditTicket ? <div className="mt-2"><SearchableSelect value={assetId} onChange={handleAssetChange} disabled={assetReferenceLoading || Boolean(assetReferenceError)} placeholder={assetReferenceLoading ? "Loading equipment…" : assetReferenceError ? "Equipment unavailable" : "Asset / Equipment"} options={assetOptions} topSuggestions={3} footerActionLabel="+ Add New Asset" onFooterAction={() => setShowAddAsset(true)} />{assetReferenceError && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-300"><span role="alert">{assetReferenceError}</span><button type="button" onClick={() => void loadMaintenanceReference()} className="font-semibold underline">Retry loading equipment</button></div>}{systemGuessAssetId && systemGuessAssetId === assetId && <p className="mt-2 text-xs font-semibold text-emerald-400">System best guess</p>}</div> : <p className="mt-2 text-base text-slate-200">{selectedAsset?.name || order.asset_name || "Not identified"}</p>}
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950/55 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Category</div>
                  {editingIssue && canEditTicket ? <div className="mt-2"><SearchableSelect value={category} onChange={setCategory} placeholder="Category" options={categoryOptions} topSuggestions={2} /></div> : <p className="mt-2 text-base text-slate-200">{category || "General"}</p>}
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950/55 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Priority</div>
                  {editingIssue && canEditTicket ? <div className="mt-2"><SearchableSelect value={priority} onChange={setPriority} placeholder="Priority" options={priorityOptions} topSuggestions={2} /></div> : <p className="mt-2 text-base text-slate-200">{priority || "Medium"}</p>}
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950/55 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Technician</div>
                  {editingIssue && canEditTicket ? <div className="mt-2"><SearchableSelect value={technicianName} onChange={setTechnicianName} placeholder="Technician" options={technicianOptions} topSuggestions={2} /></div> : <p className="mt-2 text-base text-slate-200">{technicianName || "Unassigned"}</p>}
                  {canClaimWorkOrder && <button type="button" onClick={() => void claimUnassignedWorkOrder()} disabled={saving} className="mt-2 rounded-lg border border-emerald-400/50 bg-emerald-950/40 px-3 py-2 text-xs font-bold text-emerald-100 hover:bg-emerald-900/50 disabled:opacity-50">{saving ? "Taking work…" : "Take this work"}</button>}
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950/55 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</div>
                  {editingIssue && (canEditTicket || canReviewTicket) ? <div className="mt-2"><SearchableSelect value={status} onChange={setStatus} placeholder="Status" options={statusOptions} topSuggestions={2} /></div> : <p className="mt-2 text-base text-slate-200">{status || "Open"}</p>}
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950/55 p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Due By</div>
                  {editingIssue && canEditTicket ? <input type="date" value={dueBy} onChange={(event) => setDueBy(event.target.value)} className="mt-2 min-h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm outline-none focus:border-amber-400" /> : <p className="mt-2 text-base text-slate-200">{dueBy || "No due date"}</p>}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
              <h2 className="text-lg font-bold tracking-tight text-slate-100">Photo</h2>
              {workOrderImages.length ? (
                <div className="mt-3 flex flex-wrap gap-3">
                  {workOrderImages.map((image) => (
                    <button key={image.id} type="button" onClick={() => setImagePreview(image)} className="overflow-hidden rounded-lg border border-slate-700 bg-slate-950 p-1 text-left hover:border-sky-400">
                      <img src={image.url} alt="Work-order attachment" className="h-auto w-[25%] min-w-24 max-w-48 object-contain" />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="mt-3 flex min-h-24 items-center justify-center rounded-lg border border-dashed border-slate-700 bg-slate-950 text-sm text-slate-500">No photo attached</div>
              )}
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
              <h2 className="text-lg font-bold tracking-tight text-slate-100">Ticket History</h2>
              <div ref={historyScrollRef} className="mt-2 max-h-[8.5rem] overflow-y-auto rounded-xl border border-slate-700 bg-slate-950">
                {historyEntries.length ? historyEntries.map((entry) => {
                  const when = new Date(entry.timestamp);
                  const shortDate = Number.isNaN(when.getTime()) ? "—" : when.toLocaleDateString([], { month: "numeric", day: "numeric", year: "2-digit" });
                  const hoverTime = Number.isNaN(when.getTime()) ? entry.timestamp : when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
                  return (
                    <div key={entry.id} className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[5rem_8.5rem_minmax(0,1fr)_auto] items-start gap-2 border-b border-slate-800 px-3 py-1.5 text-[15px] leading-5 last:border-b-0">
                      <span className="text-slate-500" title={hoverTime}>{shortDate}</span>
                      <span className="truncate font-semibold text-sky-200" title={entry.actor}>{entry.actor}</span>
                      <span className="text-slate-300">{renderHistoryText(entry.text)}</span>
                      {entry.staged && <button type="button" onClick={() => editSubmittedNote(entry)} className="font-semibold text-sky-300 hover:text-sky-200">Edit</button>}
                    </div>
                  );
                }) : <div className="px-3 py-2 text-[15px] text-slate-500">No ticket history yet.</div>}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
              <h2 className="text-[28px] font-bold leading-tight tracking-tight">Technician Notes</h2>
              <div className="relative">
                <textarea
                  id="technician-note-editor"
                  value={noteDraft}
                  disabled={!canEditTicket && !canReviewTicket}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  rows={2}
                  placeholder="Document findings, diagnostic codes, readings, tests, work performed, or type @ to mention another ticket..."
                  className="mt-2 max-h-20 w-full resize-none overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 p-3 text-[16px] text-white outline-none placeholder:text-slate-600 focus:border-sky-400"
                />
                {mentionMatch && mentionSuggestions.length > 0 && (
                  <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-48 overflow-y-auto rounded-xl border border-slate-600 bg-slate-900 p-1 shadow-2xl">
                    {mentionSuggestions.map((ticket) => (
                      <button key={ticket.id} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertTicketMention(ticket)} className="block w-full rounded-lg px-2.5 py-2 text-left hover:bg-sky-900/45">
                        <span className="font-semibold text-sky-200">@{ticketMentionLabel(ticket)}</span>
                        <span className="ml-2 text-sm text-slate-300">{ticket.room || "No location"}</span>
                        <span className="ml-2 text-sm text-slate-500">{ticket.issue || "No issue"}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="mt-2 flex justify-end">
                <button type="button" onClick={submitTechnicianNote} disabled={!noteDraft.trim() || (!canEditTicket && !canReviewTicket)} className="rounded-lg bg-sky-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40">Submit Note</button>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-[28px] font-bold leading-tight tracking-tight text-amber-400">
                  Suggested Troubleshooting
                </h2>
                {selectedAsset && (
                  <span className="text-xs text-slate-500">
                    {manualLoading
                      ? "Loading equipment documentation..."
                      : manualSteps.length
                        ? "Verified manufacturer guidance"
                        : "Issue-based guide"}
                  </span>
                )}
              </div>

              {!selectedAsset && (
                <div className="mt-4 rounded-xl border border-slate-700 bg-slate-950 p-4 text-sm text-slate-300">
                  General issue-based guidance only. No asset is selected, so no equipment manual or error-code table is used.
                </div>
              )}

              {selectedAsset && !manualLoading && !trustedManualKnowledge && (
                <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-950/15 p-3 text-sm text-amber-100">
                  {manualStatus === "lookup_unavailable"
                    ? "The assigned troubleshooting guide could not be checked. General issue-based guidance remains available; no other asset's guide was substituted."
                    : selectedAsset.documentation_key
                      ? `No verified guide could be resolved for documentation key ${selectedAsset.documentation_key}. General issue-based guidance is shown without borrowing another manual.`
                      : "No verified guide is assigned to this asset. General issue-based guidance is shown without guessing a manual."}
                </div>
              )}

              <div className="mt-4 max-h-[26rem] overflow-y-auto pr-2">
                {manualKnowledge?.source?.title && (
                  <div className="rounded-lg border border-slate-800 bg-slate-950 p-3">
                    <p className="text-sm font-semibold">{manualKnowledge.source.title}</p>
                    <p className={`mt-1 text-xs ${manualKnowledge?.source?.verified ? "text-emerald-400" : "text-slate-500"}`}>{manualKnowledge?.source?.verified ? "Verified equipment documentation" : manualKnowledge ? "Equipment reference uploaded — verification pending" : "Generic troubleshooting only — no equipment documentation linked"}</p>
                    {(manualKnowledge.manufacturer || manualKnowledge.equipment) && (
                      <p className="mt-1 text-xs text-slate-400">{[manualKnowledge.manufacturer, manualKnowledge.equipment].filter(Boolean).join(" · ")}</p>
                    )}
                    {selectedAsset?.documentation_key && (
                      <p className="mt-1 break-all text-[11px] text-slate-500">Documentation key: {selectedAsset.documentation_key}</p>
                    )}
                    {manualKnowledge?.source?.source_file_name && (
                      <p className="mt-1 truncate text-[11px] text-slate-500" title={manualKnowledge.source.source_file_name}>{manualKnowledge.source.source_file_name}</p>
                    )}
                    <p className="mt-2 text-[11px] leading-4 text-slate-400">{manualKnowledge.source.verified ? "Verified troubleshooting entries carry the exact manual page reference when the ingested PDF provided one." : "This upload is visible for reference, but its extracted troubleshooting content is not used until Engineering verifies the equipment documentation."}</p>
                    {(manualKnowledge.source.file_url || manualKnowledge.source.pdf_url) && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <a
                          href={manualKnowledge.source.file_url || manualKnowledge.source.pdf_url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-md border border-sky-500/40 bg-sky-950/35 px-2.5 py-1.5 text-[11px] font-bold text-sky-100 hover:bg-sky-900/50"
                        >
                          Open Manual
                        </a>
                        <span className="text-[11px] text-sky-300">Manual page buttons below open the same PDF at the referenced page.</span>
                      </div>
                    )}
                  </div>
                )}

                {reportedCode && !matchingErrorCode && (
                  <p className="mt-4 text-sm text-slate-400">
                    Reported code {reportedCode} has no exact matching entry in verified documentation for the selected asset.
                  </p>
                )}

                {relevantErrorCodes.length > 0 && (
                  <div className="mt-4 space-y-3">
                    <div>
                      <h3 className="text-sm font-semibold text-red-300">Fault / Diagnostic Code Reference</h3>
                      <p className="mt-1 text-xs text-slate-500">
                        {reportedCode
                          ? "The reported code is listed first when the manual contains it."
                          : "Potentially relevant manual codes are references only; verify the actual displayed equipment code before applying a code-specific action."}
                      </p>
                    </div>
                    {relevantErrorCodes.map((item) => {
                      const exact = !!reportedCode && normalizeDiagnosticCode(item.code) === reportedCode;
                      return (
                        <div key={`${item.code}-${item.problem}`} className={`rounded-xl border p-4 ${exact ? "border-red-400/50 bg-red-950/25" : "border-slate-700 bg-slate-950"}`}>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-semibold text-red-300">Code {item.code}</p>
                            {exact && <span className="rounded-full border border-red-400/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-200">Reported code</span>}
                          </div>
                          <p className="mt-2 text-sm font-medium text-slate-100">{item.problem}</p>
                          <p className="mt-2 text-sm text-slate-300"><span className="font-semibold text-slate-200">Solution / Action:</span> {item.action}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {!!item.source_pages?.length && (
                              <div className="flex flex-wrap gap-1.5">
                                {item.source_pages.map((page) => (
                                  <button type="button" key={page} onClick={() => setManualPagePreview(page)} className="rounded-md border border-sky-500/30 bg-sky-950/35 px-2 py-1 text-[11px] font-semibold text-sky-200 hover:bg-sky-500/20">Manual p. {page}</button>
                                ))}
                              </div>
                            )}
                            <CopyButton text={`Code ${item.code}: ${item.problem}\nAction: ${item.action}`} label="Copy code" className="ml-auto" />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {manualSteps.length > 0 && (
                  <div className="mt-5">
                    <h3 className="text-sm font-semibold text-sky-300">Verified manufacturer troubleshooting</h3>
                    <ol className="mt-3 space-y-3 text-sm text-slate-300">
                      {manualSteps.map((step, index) => {
                        const sourceRule = matchingSymptomRules.find((rule) => rule.steps.includes(step));
                        return (
                          <li key={`${step}-${index}`} className="rounded-lg border border-sky-900/70 bg-slate-950/60 p-2.5">
                            <div className="flex gap-2.5">
                              <span className="font-semibold text-sky-300">{index + 1}.</span>
                              <span className="flex-1">{step}</span>
                              <CopyButton text={step} label="Copy" className="shrink-0" />
                            </div>
                            {!!sourceRule?.source_pages?.length && (
                              <div className="mt-2 ml-6 flex flex-wrap gap-1.5">
                                {sourceRule.source_pages.map((page) => (
                                  <button type="button" key={page} onClick={() => setManualPagePreview(page)} className="rounded-md border border-sky-500/30 bg-sky-950/35 px-2 py-1 text-[11px] font-semibold text-sky-200 hover:bg-sky-500/20">Manual p. {page}</button>
                                ))}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                )}

                {displayedSteps.length > 0 && (
                  <div className="mt-5">
                    <h3 className="text-sm font-semibold text-amber-300">General issue-based checks</h3>
                    <ol className="mt-3 space-y-3 text-sm text-slate-300">
                      {displayedSteps.map((step, index) => {
                        return (
                          <li key={`${step}-${index}`} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
                            <div className="flex gap-2.5">
                              <span className="font-semibold text-amber-400">{index + 1}.</span>
                              <span className="flex-1">{step}</span>
                              <CopyButton text={step} label="Copy" className="shrink-0" />
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                )}

                {manualPagePreview && (manualKnowledge?.source?.file_url || manualKnowledge?.source?.pdf_url) && (
                  <div className="mt-4 overflow-hidden rounded-xl border border-sky-500/30 bg-slate-950">
                    <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
                      <p className="text-xs font-semibold text-sky-200">Manufacturer documentation — page {manualPagePreview}</p>
                      <button type="button" onClick={() => setManualPagePreview(null)} className="text-xs font-semibold text-slate-400 hover:text-white">Hide page</button>
                    </div>
                    <iframe
                      title={`Manual page ${manualPagePreview}`}
                      src={`${manualKnowledge.source.file_url || manualKnowledge.source.pdf_url}#page=${manualPagePreview}&view=FitH`}
                      className="h-[34rem] w-full bg-white"
                    />
                  </div>
                )}

                {manualPagePreview && !(manualKnowledge?.source?.file_url || manualKnowledge?.source?.pdf_url) && (
                  <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-950/20 p-3 text-xs text-amber-100">
                    The troubleshooting record references manual page {manualPagePreview}, but this manual has not yet been stored with a browser-accessible PDF URL. The page reference is preserved; inline preview will activate as soon as the document record includes its PDF URL.
                  </div>
                )}

                {displayedSteps.length === 0 && relevantErrorCodes.length === 0 && !manualLoading && (
                  <p className="text-sm text-slate-400">
                    No symptom-specific troubleshooting matched yet. Add more detail to the reported issue or technician notes.
                  </p>
                )}
              </div>
            </section>

            {["Completed", "Closed", "Will Not Do"].includes(status) && (
              <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
                <h2 className="text-lg font-semibold">Closure Details</h2>
                <p className="mt-1 text-xs text-slate-500">
                  Record the final action and root cause only when closing the ticket.
                </p>
                <textarea
                  value={actionRootCause}
                  onChange={(event) => setActionRootCause(event.target.value)}
                  rows={5}
                  placeholder="Repair performed, root cause, or reason not completed..."
                  className="mt-4 w-full rounded-xl border border-slate-700 bg-slate-950 p-4 text-sm text-white outline-none placeholder:text-slate-600 focus:border-amber-400"
                />
              </section>
            )}

          </div>

          <aside className="space-y-6">
            {(roomOperationalContext.loading || roomOperationalContext.ranker || roomOperationalContext.pm) && (
              <section className="rounded-2xl border border-cyan-500/30 bg-slate-900 p-5">
                <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-cyan-300">Room Context</p><h2 className="mt-1 text-lg font-semibold">Room Ranker & Corporate PM</h2></div><div className="flex gap-2"><Link href="/engineering/room-ranker" className="text-xs font-semibold text-amber-300 hover:underline">Ranker</Link><Link href="/engineering/preventive-maintenance" className="text-xs font-semibold text-amber-300 hover:underline">PM</Link></div></div>
                {roomOperationalContext.loading ? <p className="mt-3 text-sm text-slate-400">Loading live room context…</p> : <>
                  <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3"><div className="flex items-center justify-between gap-3"><b>Room Ranker</b><span className="rounded-full border border-amber-500/40 px-2 py-0.5 text-xs font-bold text-amber-200">{roomOperationalContext.ranker?.rank || "Unranked"}</span></div>{roomRankerFlags.length ? <ul className="mt-2 space-y-1 text-xs text-slate-300">{roomRankerFlags.map((flag, index) => <li key={`${flag}-${index}`}>• {flag}</li>)}</ul> : <p className="mt-2 text-xs text-slate-500">No Room Ranker flags/notes returned for this room.</p>}</div>
                  <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3"><b>Corporate PM</b>{pmSummaryEntries.length ? <dl className="mt-2 grid gap-1 text-xs">{pmSummaryEntries.map(([key, value]) => <div key={key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3"><dt className="text-slate-500">{key.replaceAll("_", " ")}</dt><dd className="text-right text-slate-200">{String(value)}</dd></div>)}</dl> : <p className="mt-2 text-xs text-slate-500">{roomOperationalContext.pm ? "Live PM data is available; open the PM page for the full checklist." : "No live room PM summary returned."}</p>}</div>
                </>}
              </section>
            )}

            {(externalActivity.purchases?.length || externalActivity.enseo?.length || externalActivity.warranties?.length || externalActivity.followups?.length) ? (
              <section className="rounded-2xl border border-orange-500/30 bg-slate-900 p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-orange-300">Linked External Activity</p>
                    <h2 className="mt-1 text-lg font-semibold">Parts, Shipments & Service Tickets</h2>
                  </div>
                  <Link href="/engineering/purchasing" className="text-xs font-semibold text-amber-300 hover:underline">View all</Link>
                </div>

                {!!externalActivity.purchases?.length && (
                  <div className="mt-4 space-y-3">
                    {externalActivity.purchases.map((purchase) => (
                      <div key={purchase.id} className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-semibold">{purchase.vendor || "Supplier"}{purchase.order_number ? ` · PO ${purchase.order_number}` : ""}</p>
                          <span className="rounded-full border border-blue-400/40 bg-blue-950/35 px-2 py-0.5 text-[11px] font-semibold text-blue-200">{purchase.status || "Ordered"}</span>
                        </div>
                        {purchase.eta && <p className="mt-1 text-xs text-slate-400">ETA: {purchase.eta}</p>}
                        {!!purchase.cmpri_purchase_shipments?.length && (
                          <div className="mt-2 space-y-1.5">
                            {purchase.cmpri_purchase_shipments.map((shipment, index: number) => (
                              <div key={shipment.id || `${purchase.id}-${index}`} className="rounded-lg border border-slate-800 px-2.5 py-2 text-xs text-slate-300">
                                <div className="font-semibold">Shipment {index + 1}{(purchase.cmpri_purchase_shipments?.length || 0) > 1 ? ` of ${purchase.cmpri_purchase_shipments?.length}` : ""} · {shipment.status || "Shipped"}</div>
                                <div className="mt-0.5 text-slate-500">From: {shipment.ship_from || "Origin not listed"}</div>
                                <div className="mt-0.5 break-all text-slate-500">Tracking: {shipment.tracking_number || "Not provided"}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {!!externalActivity.enseo?.length && (
                  <div className="mt-4 border-t border-slate-800 pt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-sky-300">Enseo</p>
                    {externalActivity.enseo.map((ticket) => <p key={ticket.id} className="mt-1 text-sm text-slate-300">{ticket.ticket_number ? `Ticket ${ticket.ticket_number}` : "Enseo ticket"}{ticket.enseo_endpoint ? ` · ${ticket.enseo_endpoint}` : ticket.room_number ? ` · Room ${ticket.room_number}` : ""} · {ticket.status || "Updated"}</p>)}
                  </div>
                )}

                {!!externalActivity.warranties?.length && (
                  <div className="mt-4 border-t border-slate-800 pt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-purple-300">Warranty / RMA</p>
                    {externalActivity.warranties.map((item) => <p key={item.id} className="mt-1 text-sm text-slate-300">{item.rma_number ? `RMA ${item.rma_number}` : item.warranty_case_number ? `Case ${item.warranty_case_number}` : "Warranty case"} · {item.status || "Open"}</p>)}
                  </div>
                )}

                {!!externalActivity.followups?.length && (
                  <div className="mt-4 border-t border-slate-800 pt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-amber-300">Supplier Follow-up</p>
                    {externalActivity.followups.map((item) => <p key={item.id} className="mt-1 text-sm text-slate-300">{item.status || "Vendor Contacted — Awaiting Response"}</p>)}
                  </div>
                )}
              </section>
            ) : null}

            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="text-lg font-semibold">Labor & Parts</h2>

              <label className="mt-4 block">
                <span className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                  Parts
                </span>
                <input
                  value={parts}
                  onChange={(event) => setParts(event.target.value)}
                  className="mt-2 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm outline-none focus:border-amber-400"
                  placeholder="Parts used / ordered"
                />
              </label>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                    Hours
                  </span>
                  <input
                    type="number"
                    step="0.25"
                    min="0"
                    value={hours}
                    onChange={(event) => setHours(event.target.value)}
                    className="mt-2 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm outline-none focus:border-amber-400"
                  />
                </label>

                <label className="block">
                  <span className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                    Cost
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={cost}
                    onChange={(event) => setCost(event.target.value)}
                    className="mt-2 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm outline-none focus:border-amber-400"
                  />
                </label>
              </div>
            </section>

          </aside>
        </div>

      </div>

      {showCancelConfirm && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-1" onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          setShowCancelConfirm(false);
        }}>
          <div role="dialog" aria-modal="true" className="cmpri-modal-shell rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
            <h2 className="text-xl font-bold">Are you sure you want to cancel?</h2>
            <p className="mt-2 text-sm text-slate-400">Your unsaved changes will be discarded.</p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                autoFocus
                onClick={() => setShowCancelConfirm(false)}
                className="rounded-lg border border-slate-600 px-5 py-3 text-sm font-semibold text-slate-200 hover:bg-slate-800"
              >
                No
              </button>
              <button
                type="button"
                onClick={closeEmbeddedTicket}
                className="rounded-lg bg-red-600 px-5 py-3 text-sm font-bold text-white hover:bg-red-500"
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddAsset && order && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 p-1" role="dialog" aria-modal="true" aria-label="Add New Asset" onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          setShowAddAsset(false);
        }}>
          <div className="cmpri-modal-shell rounded-2xl border border-slate-700 bg-slate-950 p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div><h2 className="text-2xl font-bold text-white">Add New Equipment</h2><p className="mt-1 text-sm text-slate-400">Create the physical asset first, then link it to this work order.</p></div>
              <button type="button" onClick={() => setShowAddAsset(false)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">Cancel</button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <input autoFocus value={newAssetType} onChange={(e)=>setNewAssetType(e.target.value)} placeholder="Equipment type, e.g. TV or VTAC" className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm" />
              <div className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-300">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">New asset name</span>
                <span className="mt-0.5 block font-semibold text-slate-100">{newAssetType.trim() ? `${newAssetType.trim()} – ${order.room || "Location"}` : `Equipment type – ${order.room || "Location"}`}</span>
              </div>
              <input value={newAssetManufacturer} onChange={(e)=>setNewAssetManufacturer(e.target.value)} placeholder="Manufacturer" className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm" />
              <input value={newAssetModel} onChange={(e)=>setNewAssetModel(e.target.value)} placeholder="Model" className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm" />
              <input value={newAssetSerial} onChange={(e)=>setNewAssetSerial(e.target.value)} placeholder="Serial" className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm" />
              <label className="grid gap-1 text-[13px] text-slate-300">Install / replacement date<input type="date" value={newAssetInstallDate} onChange={(e)=>setNewAssetInstallDate(e.target.value)} className="min-h-11 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm" /></label>
            </div>
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/70 p-3">
              <span className="text-sm font-semibold text-slate-200">Documentation (optional)</span>
              <div className="mt-2 grid gap-2 sm:grid-cols-[12rem_1fr]">
                <SearchableSelect
                  value={newAssetDocumentType}
                  onChange={setNewAssetDocumentType}
                  placeholder="Document type"
                  topSuggestions={2}
                  options={["Service Manual", "Installation Manual", "Parts Manual", "Wiring Diagram", "Other"].map((value) => ({ value, label: value }))}
                />
                <input type="file" accept="application/pdf,.pdf" onChange={(e)=>setNewAssetDocument(e.target.files?.[0] || null)} className="min-h-11 rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-sm file:mr-2 file:rounded file:border-0 file:bg-sky-800 file:px-2 file:py-1 file:text-white" />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setShowAddAsset(false)} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300">Cancel</button><button type="button" onClick={() => void addAssetFromTicket()} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950">Add & Select Asset</button></div>
          </div>
        </div>
      )}

      {imagePreview && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/85 p-1" role="dialog" aria-modal="true" aria-label="Full-size work-order photo" onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          setImagePreview(null);
        }}>
          <button type="button" aria-label="Close photo" onClick={() => setImagePreview(null)} className="absolute inset-0 cursor-default" />
          <div className="cmpri-modal-shell relative z-10 rounded-xl border border-slate-600 bg-slate-950 p-2 shadow-2xl">
            <img src={imagePreview.url} alt="Full-size work-order attachment" className="max-h-[92vh] max-w-[92vw] object-contain" />
            <button type="button" onClick={() => setImagePreview(null)} className="absolute right-3 top-3 rounded-lg border border-slate-600 bg-slate-950/90 px-3 py-2 text-sm font-semibold text-white">Close</button>
          </div>
        </div>
      )}
    </main>
  );
}
