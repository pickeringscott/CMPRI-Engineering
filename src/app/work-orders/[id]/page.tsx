"use client";
import WorkOrderAttachmentHistory from "@/components/WorkOrderAttachmentHistory";
import WorkOrderMediaComposer from "@/components/WorkOrderMediaComposer";
import WorkOrderGuestIndicators from "@/components/WorkOrderGuestIndicators";
import {type RoomGroupBadge} from "@/lib/room-group-badges";
import {loyaltyTier} from "@/lib/loyalty-tier";

import { canApplyTicketRefresh } from "@/lib/events/ticket-refresh";
import { subscribeResources } from "@/lib/events/browser";
import WorkOrderNoteComposer from "@/components/WorkOrderNoteComposer";
import WorkOrderMentionText from "@/components/WorkOrderMentionText";
import type { WorkOrderMention } from "@/lib/work-order-mentions";
import { workOrderReferenceTargets } from "@/lib/work-order-reference-targets";
import {workOrderListSnapshot} from "@/lib/work-order-list-sync";
import PlainTextLinks from '@/components/PlainTextLinks';
import {plainTextParts} from '@/lib/plain-text-links';
import WorkOrderSupplies from "@/components/WorkOrderSupplies";
import WorkOrderTroubleshootingChecklist from "@/components/WorkOrderTroubleshootingChecklist";
import { deriveTroubleshootingChecklistContext } from "@/lib/work-orders/troubleshooting-checklist";
import { registerActiveTroubleshootingVisit } from "@/lib/work-orders/troubleshooting-visits";

import { createTicketWriteQueue } from "@/lib/work-orders/write-queue";
import { pendingTicketField } from "@/lib/work-orders/pending-field";

import { formatWorkOrder, workOrderNumber, workOrderReferences } from "@/lib/work-order-reference.js";
import { frontDeskCommonArea, type CommonAreaLocation } from "@/lib/cmpri-location-groups";

import WorkOrderImportPill from "@/components/WorkOrderImportPill";

import { troubleshootingStepAlreadyDone } from "@/lib/troubleshooting-completed-steps";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getValidSession } from "@/lib/supabase/client";
import { authorizationHeaders, loadCmpriSession, type CmpriClientSession } from "@/lib/auth/client-session";
import { enforceSessionPreference } from "@/lib/auth/session-preference";
import SearchableSelect from "@/components/SearchableSelect";
import { classifyAsset } from "@/lib/asset-category";
import { categoryOptions as workOrderCategoryOptions } from "@/lib/work-order-categories";
import { normalizeManualKnowledge, type ManualErrorCode, type ManualKnowledge } from "@/lib/manual-knowledge";
import { profileIsChiefEngineer, profileIsEstablishedHoursChief, roleKey } from "@/lib/server/roles";
import { accountRoleDisplayName } from "@/lib/account-display";
import { historyLine, parseTicketHistory, noteHeading, type TicketHistoryEntry } from "@/lib/ticket-note-presentation";
import { canAccessWorkOrderByAssignment } from "@/lib/server/work-order-assignment";
import PartsStatusPill from "@/components/PartsStatusPill";
import type {PartStatus} from "@/lib/work-order-parts";
import { checkoutLabel, priorityClass, priorityLabel, statusClass } from "@/components/desktop/WorkOrderListWindow";
import { normalizeKpiStatus } from "@/lib/dashboard/kpi-filters";
import { resolveWorkOrderImages, type WorkOrderImage } from "@/lib/work-orders/attachment-response";
import { type RoomRankerContext } from "@/lib/work-orders/room-ranker-context";
import { workOrderHistoryText } from "@/lib/work-order-history";
import { roomStatusBadge } from "@/lib/room-availability";
import { canSubmitWorkOrderNote, workOrderEditableFields, type WorkOrderEditableField } from "@/lib/work-order-edit-policy";
import { relevantSourcePassages, reportedDiagnosticCode } from "@/lib/manual-source";
import { guideRulesForIssue, equipmentSearchAliases } from "@/lib/work-orders/guide-selection";
import { inferWorkOrder } from "@/lib/work-order-suggestions";
import { assignableAssetsForLocation, roomAssetsForInference } from "@/lib/work-orders/assignable-assets";


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
  model_family: string | null;
  model_number: string | null;
  serial_number: string | null;
  generation: string | null;
  install_year: number | null;
  documentation_key: string | null;
  documentation_revision_id?: string | null;
  documentation_verified_at?: string | null;
};
type WorkOrder = {
  guest_name?: string|null;
  loyalty_tier?: string|null;
  guest_group_badge?: RoomGroupBadge|null;
  incoming_group_badge?: RoomGroupBadge|null;
  incoming_loyalty_tier?: string|null;
  incoming_reserved?: boolean;
  can_correct_report?: boolean;
  revision: number;
  id: string;
  display_id?: string | null;
  import_source?: string | null;
  import_external_id?: string | null;
  location_id?: string | null;
  asset_id?: string | null;
  room?: string | null;
  room_status?: string | null;
  asset_name?: string | null;
  category?: string | null;
  issue?: string | null;
  priority?: string | null;
  parts_status?: PartStatus | null;
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
  creator_display_role?: string | null;
  created_at?: string | null;
  technician_view_entries?: {
    id: string;
    technician_name: string;
    viewed_at: string;
    resolved_at: string | null;
  }[];
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
  history?: { id: string; actor_name?: string | null; event_type?: string | null; old_status?: string | null; new_status?: string | null; changed_fields?: Record<string, unknown> | null; source?: string | null; recorded_at?: string | null }[];
};

type RoomPmContext = {
  error?: string;
};

type RoomOperationalContext = {
  ranker: RoomRankerContext | null;
  rankerError: string;
  pm: RoomPmContext | null;
  guestName: string;
  loyaltyTier?: string|null;
  groupBadge?: RoomGroupBadge|null;
  roomStatus: string;
  checkoutDate: string;
  checkoutTime: string;
  checkoutError: string;
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

// Retained as a type source only; generic guidance is never invoked on this page.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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


export default function WorkOrderTicketPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [restoredVisit, setRestoredVisit] = useState(0);
  useEffect(() => {
    const resume = (event: PageTransitionEvent) => {
      if (event.persisted) setRestoredVisit(visit => visit + 1);
    };
    window.addEventListener("pageshow", resume);
    return () => window.removeEventListener("pageshow", resume);
  }, []);
  return <WorkOrderTicketEditor key={`${id}:${restoredVisit}`} id={id} />;
}

function WorkOrderTicketEditor({ id }: { id: string }) {
  const router = useRouter();
  const [troubleshootingVisitId] = useState(() => crypto.randomUUID());
  const partExitGuard = useRef<(() => Promise<void>) | null>(null);
  const registerPartExitGuard = useCallback((guard: () => Promise<void>) => {
    partExitGuard.current = guard;
    return () => { if (partExitGuard.current === guard) partExitGuard.current = null; };
  }, []);
  const checklistExitFlushes = useRef(new Set<() => Promise<void>>());
  const exitFallbackGeneration = useRef(0);
  const exitInFlight = useRef(false);
  const [exitFlushing, setExitFlushing] = useState(false);
  const [exitError, setExitError] = useState("");
  const pendingExitAction = useRef<(() => void) | null>(null);
  const registerExitFlush = useCallback((flush: () => Promise<void>) => {
    checklistExitFlushes.current.add(flush);
    // Guide reloads can unmount a checklist before this editing visit ends.
    // Keep its durable journal finalizer until the work-order page exits.
    return () => {};
  }, []);
  useEffect(() => registerActiveTroubleshootingVisit(troubleshootingVisitId), [troubleshootingVisitId]);
  useEffect(() => {
    const generation = ++exitFallbackGeneration.current;
    const finalizeLeavingVisit = () => {
      // Browser history, reloads and tab closure cannot await a controlled exit.
      // The server keeps each journal durable if the browser interrupts this attempt.
      for (const flush of checklistExitFlushes.current) void flush().catch(() => undefined);
    };
    window.addEventListener("pagehide", finalizeLeavingVisit);
    return () => {
      window.removeEventListener("pagehide", finalizeLeavingVisit);
      // Strict Mode immediately replays effects on the same editing visit.
      // Only a genuine page unmount should end its journal.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      queueMicrotask(() => { if (exitFallbackGeneration.current === generation) finalizeLeavingVisit(); });
    };
  }, []);

  const [order, setOrderState] = useState<WorkOrder | null>(null);
  const orderRef = useRef<WorkOrder | null>(null);
  const ticketWrites = useRef(createTicketWriteQueue());
  const [issueSaving, setIssueSaving] = useState(false);
  const issueSaveCount = useRef(0);
  function setOrder(next: WorkOrder | null) {
    // Publish the confirmed revision before another queued callback can run.
    orderRef.current = next;
    setOrderState(next);
  }

  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetReferenceLoading, setAssetReferenceLoading] = useState(true);
  const [assetReferenceError, setAssetReferenceError] = useState("");
  const [technicians, setTechnicians] = useState<TechnicianProfile[]>([]);
  const [manualResult, setManualResult] = useState<{ assetId: string; documentationKey: string | null; documentationRevisionId?: string | null; documentationVerifiedAt?: string | null; manufacturer: string | null; modelFamily: string | null; modelNumber: string | null; knowledge: ManualKnowledge | null; status: string; reason?: string } | null>(null);
  const [workOrderImages, setWorkOrderImages] = useState<WorkOrderImage[]>([]);
  const [workOrderImagesLoading, setWorkOrderImagesLoading] = useState(true);
  const [workOrderImageError, setWorkOrderImageError] = useState("");
  const [photoUploading, setPhotoUploading] = useState(false);
  const [removingPhotoId, setRemovingPhotoId] = useState<string | null>(null);
  const [hasPendingNoteMedia, setHasPendingNoteMedia] = useState(false);
  const [photoUploadError, setPhotoUploadError] = useState("");
  const [photoUploadMessage, setPhotoUploadMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [ticketReady, setTicketReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const recoveredDraft = useRef(false);
  const [embedded, setEmbedded] = useState(true);
  const [modalToken, setModalToken] = useState("");
  const [message, setMessage] = useState("");
  const [localDraftFailed, setLocalDraftFailed] = useState(false);
  const [editingIssue, setEditingIssue] = useState(false);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [showAddAsset, setShowAddAsset] = useState(false);
  const [newAssetType, setNewAssetType] = useState("");
  const [newAssetManufacturer, setNewAssetManufacturer] = useState("");
  const [newAssetModel, setNewAssetModel] = useState("");
  const [newAssetSerial, setNewAssetSerial] = useState("");
  const [newAssetInstallDate, setNewAssetInstallDate] = useState("");
  const [newAssetDocumentType, setNewAssetDocumentType] = useState("Service Manual");
  const [newAssetDocument, setNewAssetDocument] = useState<File | null>(null);
  const historyScrollRef = useRef<HTMLDivElement | null>(null);

  const [locationId, setLocationId] = useState("");
  const [reportLocations, setReportLocations] = useState<CommonAreaLocation[]>([]);
  const [locationError, setLocationError] = useState("");
  const [issue, setIssue] = useState("");
  const [assetId, setAssetId] = useState("");
  const assetSelectionChanged = useRef(false);
  const ticketLoadGeneration = useRef(0);
  const editState = useRef({ dirty: false, fingerprint: "", revision: 0, saving: false });
  const readLifetime = useRef({ active: true, generation: 0, controller: undefined as AbortController | undefined });
  const imageReadGeneration = useRef(0);
  const activityReadGeneration = useRef(0);
  useEffect(() => {
    const state = { active: true, generation: readLifetime.current.generation + 1, controller: new AbortController() };
    readLifetime.current = state;
    return () => { state.active = false; state.controller.abort(); };
  }, [id]);
  const [systemGuessAssetId, setSystemGuessAssetId] = useState("");
  const [category, setCategory] = useState("General");
  const [priority, setPriority] = useState("Medium");
  const [technicianName, setTechnicianName] = useState("");
  const [status, setStatus] = useState("Open");
  const [notes, setNotes] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [mentionTickets, setMentionTickets] = useState<MentionTicket[]>([]);
  const [mentionDirectory, setMentionDirectory] = useState<WorkOrderMention[]>([]);
  const [mentionDirectoryError, setMentionDirectoryError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/work-orders/mentions?directory=1", { headers: await authorizationHeaders(), cache: "no-store", signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error("Staff mentions could not be loaded. Reload the ticket to retry.");
        if (!controller.signal.aborted) { setMentionDirectory(payload.mentions || []); setMentionDirectoryError(""); }
      } catch { if (!controller.signal.aborted) setMentionDirectoryError("Staff mentions could not be loaded. Reload the ticket to retry."); }
    })();
    return () => controller.abort();
  }, [id]);
  const [notesLanguage, setNotesLanguage] = useState<"en" | "es">("en");
  useEffect(() => {
    const sync = () => setNotesLanguage(document.documentElement.lang === "es" ? "es" : "en");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    return () => observer.disconnect();
  }, []);

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
  const [roomOperationalContext, setRoomOperationalContext] = useState<RoomOperationalContext>({ ranker: null, rankerError: "", pm: null, guestName: "", roomStatus: "", checkoutDate: "", checkoutTime: "", checkoutError: "", loading: false });
  const [initialFingerprint, setInitialFingerprint] = useState("");
  const [cmpriSession, setCmpriSession] = useState<CmpriClientSession | null>(null);
  const cmpriSessionRef = useRef<CmpriClientSession | null>(null);

  const storedAsset = assets.find((asset) => asset.id === assetId);
  const equipmentLocationMismatch = !!storedAsset?.location_id && storedAsset.location_id !== (locationId || order?.location_id) && !frontDeskCommonArea(reportLocations.find(location => location.id === (locationId || order?.location_id)), reportLocations.find(location => location.id === storedAsset.location_id));
  const selectedAsset = equipmentLocationMismatch ? undefined : storedAsset;
  const manualCurrent = !!selectedAsset && manualResult?.assetId === assetId &&
    manualResult?.documentationKey === selectedAsset?.documentation_key &&
    manualResult?.documentationRevisionId === selectedAsset?.documentation_revision_id &&
    manualResult?.documentationVerifiedAt === selectedAsset?.documentation_verified_at &&
    manualResult?.manufacturer === selectedAsset?.manufacturer &&
    manualResult?.modelFamily === selectedAsset?.model_family &&
    manualResult?.modelNumber === selectedAsset?.model_number;
  const manualKnowledge = manualCurrent && manualResult?.knowledge?.source?.source_kind === "asset-upload" ? manualResult.knowledge : null;
  const manualStatus = manualCurrent ? manualResult?.status : null;
  const manualReason = manualCurrent ? manualResult?.reason : null;
  const manualLoading = !!selectedAsset && !manualCurrent;
  const guideSource = manualKnowledge?.source;
  const guideDocuments = guideSource?.source_kind === "asset-upload" && guideSource.storage_path ? [{
    name: guideSource.source_file_name || guideSource.title || "Uploaded equipment document",
    storage_path: guideSource.storage_path,
    url: guideSource.file_url || guideSource.pdf_url,
  }] : [];

  useEffect(() => {
    const pane = historyScrollRef.current;
    if (!pane) return;
    requestAnimationFrame(() => { pane.scrollTop = pane.scrollHeight; });
  }, [notes, order?.created_at]);

  useEffect(() => {
    if (!cmpriSession?.capabilities.includes("view_dashboard")) return;
    return subscribeResources(["reference"], async () => { await loadMaintenanceReference(); }, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmpriSession]);

  const maintenancePending = useRef<{ key: string; promise: Promise<Asset[]> } | null>(null);
  function loadMaintenanceReference() {
    const identity = cmpriSessionRef.current;
    const key = `${identity?.hotelId}:${identity?.user.id}`;
    if (maintenancePending.current?.key === key) return maintenancePending.current.promise;
    const promise = fetchMaintenanceReference().finally(() => {
      if (maintenancePending.current?.promise === promise) maintenancePending.current = null;
    });
    maintenancePending.current = { key, promise };
    return promise;
  }
  async function fetchMaintenanceReference() {
    const lifetime = readLifetime.current;
    setAssetReferenceLoading(true);
    setAssetReferenceError("");
    try {
      const session = await getValidSession();
      if (!lifetime.active) return [] as Asset[];
      const token = session?.access_token;
      if (!token) throw new Error("Sign in again to load equipment.");
      const response = await fetch("/api/maintenance-reference", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store", signal: lifetime.controller?.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(payload.assets)) {
        throw new Error(payload.error || "Equipment could not be loaded.");
      }
      if (!lifetime.active) return [] as Asset[];
      const referenceAssets = payload.assets as Asset[];
      setAssets(referenceAssets);
      setTechnicians((payload.technicians ?? []) as TechnicianProfile[]);
      return referenceAssets;
    } catch (error) {
      if (!lifetime.active) return [] as Asset[];
      setAssetReferenceError(error instanceof Error ? error.message : "Equipment could not be loaded.");
      return [] as Asset[];
    } finally {
      if (lifetime.active) setAssetReferenceLoading(false);
    }
  }

  async function loadWorkOrderImages(background = false) {
    const lifetime = readLifetime.current;
    const generation = ++imageReadGeneration.current;
    if (!id) {
      setWorkOrderImagesLoading(false);
      return;
    }
    setWorkOrderImagesLoading(true);
    setWorkOrderImageError("");
    if (!background) setWorkOrderImages([]);
    try {
      const session = await getValidSession();
      if (!lifetime.active) return;
      if (!session?.access_token) throw new Error("Your CMPRI session has expired. Sign in again.");
      const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}/attachments`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store", signal: lifetime.controller?.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!lifetime.active || generation !== imageReadGeneration.current) return false;
      const result = resolveWorkOrderImages(response.ok, payload);
      if (result.error) throw new Error(result.error);
      setWorkOrderImages(result.images);
      return true;
    } catch (error) {
      if (!lifetime.active || generation !== imageReadGeneration.current) return false;
      setWorkOrderImages([]);
      setWorkOrderImageError(error instanceof Error ? error.message : "Work-order images could not be loaded.");
      return false;
    } finally {
      if (lifetime.active && generation === imageReadGeneration.current) setWorkOrderImagesLoading(false);
    }
  }

  async function removeSavedPhoto(image: WorkOrderImage) {
    if (!id || !image.can_remove || photoUploading || removingPhotoId) return;
    if (!window.confirm("Remove this saved photo from this work order? This cannot be undone.")) return;
    setRemovingPhotoId(image.id);
    setPhotoUploadError("");
    setPhotoUploadMessage("");
    try {
      const session = await getValidSession();
      if (!session?.access_token) throw new Error("Your CMPRI session has expired. Sign in again.");
      const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}/attachments`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ photoId: image.id }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || "Photo removal could not be confirmed. Reload photos before retrying.");
      const confirmed = await loadWorkOrderImages();
      setPhotoUploadMessage(confirmed ? "Photo removed." : "Removal accepted, but the photo list could not be refreshed. Retry loading photos.");
    } catch (error) {
      setPhotoUploadError(error instanceof Error ? error.message : "The photo could not be removed.");
    } finally {
      setRemovingPhotoId(null);
    }
  }

  function seedTicketPreview(row: WorkOrder) {
    setOrder(row);
    setLocationId(row.location_id || "");
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
      locationId: row.location_id || "",
      issue: previewIssue,
      assetId: row.asset_id || "",
      category: row.category || "General",
      priority: row.priority || "Medium",
      technicianName: row.technician_name || "",
      status: row.status || "Open",
      notes: row.notes || "",
      actionRootCause: row.action_root_cause || "",
      parts: row.parts || explicitPartSuggestion(previewIssue),
      cost: row.cost == null ? "" : String(row.cost),
      hours: row.hours == null ? "" : String(row.hours),
      dueBy: previewDueBy,
    }));
    setSaveState("idle");
    setLoading(false);
  }

  useEffect(() => {
    if (!embedded || window.parent === window || !order) return;
    window.parent.postMessage({type:'cmpri-work-order-loaded',modalToken,workOrderId:order.id,workOrder:workOrderListSnapshot(order)},window.location.origin);
  }, [embedded, modalToken, order]);
  const [roomBoundaryVersion,setRoomBoundaryVersion]=useState(0);
  const [roomNextBoundary,setRoomNextBoundary]=useState<number|null>(null);
  const roomContextGeneration = useRef(0);
  useEffect(() => { const generation = roomContextGeneration; return () => { generation.current++; }; }, []);
  async function loadRoomOperationalContext(roomLabel?: string | null) {
    const generation = ++roomContextGeneration.current;
    const roomText = String(roomLabel || "");
    const room = roomText.match(/\b(?:\d{2,4}|MGR)\b/i)?.[0] || "";
    if (!room) { setRoomOperationalContext({ ranker: null, rankerError: "", pm: null, guestName: "", roomStatus: "", checkoutDate: "", checkoutTime: "", checkoutError: "", loading: false }); return; }
    setRoomOperationalContext((current) => ({ ...current, ranker: null, rankerError: "", guestName: "", roomStatus: "", checkoutDate: "", checkoutTime: "", loading: true }));
    try {
      const session = await getValidSession();
      const token = session?.access_token;
      if (!token) {
        if (generation !== roomContextGeneration.current) return;
        setRoomOperationalContext({ ranker: null, rankerError: "Your CMPRI session has expired. Sign in again.", pm: { error: "Your CMPRI session has expired. Sign in again." }, guestName: "", roomStatus: "", checkoutDate: "", checkoutTime: "", checkoutError: "Today's checkout time could not be loaded.", loading: false });
        return;
      }
      const headers = { Authorization: `Bearer ${token}` };
      const current = cmpriSession;
      if (!current) return;
      let guestName = "";
      let guestTier: string|null = null;
      let groupBadge: RoomGroupBadge|null = null;
      let roomStatus = "";
      let checkoutDate = "";
      let checkoutTime = "";
      let checkoutError = "";
      try {
        const response = await fetch(`/api/work-orders/${encodeURIComponent(orderRef.current?.id || id)}`, { headers, cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok || !payload.workOrder) throw Error(payload.error || 'Guest context is unavailable.');
        const context = payload.workOrder;
        guestName = context.guest_name || '';
        guestTier = loyaltyTier(context.loyalty_tier);
        groupBadge = context.guest_group_badge || null;
        roomStatus = context.room_status || '';
        checkoutDate = context.checkout_date || '';
        checkoutTime = context.checkout_time || '';
        if (generation === roomContextGeneration.current) {
          setRoomNextBoundary(typeof payload.next_guest_transition_at === 'number' ? payload.next_guest_transition_at : null);
          setOrder(orderRef.current && orderRef.current.id === context.id ? { ...orderRef.current, guest_name: guestName, loyalty_tier:guestTier, guest_group_badge:groupBadge, incoming_reserved:context.incoming_reserved, incoming_loyalty_tier:context.incoming_loyalty_tier, incoming_group_badge:context.incoming_group_badge } : orderRef.current);
        }
      } catch (error) { checkoutError = error instanceof Error ? error.message : 'Guest context is unavailable.'; }
      if (generation !== roomContextGeneration.current) return;
      setRoomOperationalContext(previous => ({ ...previous, pm: {}, loyaltyTier:guestTier, groupBadge, guestName, roomStatus, checkoutDate, checkoutTime, checkoutError, loading: false }));
    } catch (error) {
      if (generation !== roomContextGeneration.current) return;
      const message = error instanceof Error ? error.message : "Room context could not be loaded.";
      setRoomOperationalContext({
        ranker: null,
        rankerError: message,
        pm: { error: message },
        guestName: "",
        roomStatus: "",
        checkoutDate: "",
        checkoutTime: "",
        checkoutError: message,
        loading: false,
      });
    }
  }

  useEffect(() => {
    if (!cmpriSession) return;
    const stop = subscribeResources(["rooms"], async () => { await loadRoomOperationalContext(order?.room); });
    const generation = roomContextGeneration;
    return () => { generation.current++; stop(); };
    // The server authorizes each fresh context request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.room, cmpriSession,roomBoundaryVersion]);
  useEffect(()=>{
    if(!roomNextBoundary||roomNextBoundary<=Date.now())return;
    const timer=setTimeout(()=>setRoomBoundaryVersion(value=>value+1),roomNextBoundary-Date.now()+50);
    return()=>clearTimeout(timer);
  },[roomNextBoundary]);

  async function loadExternalActivity() {
    const lifetime = readLifetime.current;
    const generation = ++activityReadGeneration.current;
    if (!id) return;
    try {
      const session = await getValidSession();
      if (!lifetime.active || generation !== activityReadGeneration.current) return;
      const token = session?.access_token;
      if (!token) return;
      const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}/activity`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store", signal: lifetime.controller?.signal,
      });
      if (!response.ok) return;
      const payload = await response.json();
      if (!lifetime.active || generation !== activityReadGeneration.current) return;
      setExternalActivity(payload || { purchases: [], enseo: [], warranties: [], followups: [] });
    } catch {
      // External email/purchasing activity is supplemental; ticket loading must never fail because of it.
    }
  }

  const [referenceTickets, setReferenceTickets] = useState<MentionTicket[]>([]);
  const [referencePrefixes, setReferencePrefixes] = useState<Record<string, string>>({});
  const [referenceError, setReferenceError] = useState("");
  const referenceText = [order?.notes || "", ...(externalActivity.history || []).map(event => workOrderHistoryText(event, event.recorded_at))].join("\n");
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(()=>{
      if(controller.signal.aborted)return;
      setReferenceTickets([]);
      setReferencePrefixes({});
      setReferenceError("");
    });
    const targets = workOrderReferenceTargets(referenceText);
    if (!targets.length) return () => controller.abort();
    void (async () => {
      try {
        const headers = await authorizationHeaders();
        const tickets: MentionTicket[] = [];
        const prefixes: Record<string, string> = {};
        for (let offset = 0; offset < targets.length; offset += 100) {
          const query = new URLSearchParams();
          for (const target of targets.slice(offset, offset + 100)) query.append("target", target);
          const response = await fetch(`/api/work-orders/references?${query}`, { headers, cache: "no-store", signal: controller.signal });
          const payload = await response.json();
          if (!response.ok) throw new Error("Ticket links could not be loaded. Reload the ticket to retry.");
          tickets.push(...(payload.tickets || []));
          Object.assign(prefixes, payload.resolvedPrefixes || {});
        }
        if (!controller.signal.aborted) {
          setReferenceTickets(Array.from(new Map(tickets.map(ticket => [ticket.id, ticket])).values()));
          setReferencePrefixes(prefixes);
        }
      } catch {
        if (!controller.signal.aborted) setReferenceError("Ticket links could not be loaded. Reload the ticket to retry.");
      }
    })();
    return () => controller.abort();
  }, [id, referenceText]);

  async function loadTicket(showLoading = true, canLoadMaintenanceReference = true, background = false) {
    if (!id) return;
    const generation = ++ticketLoadGeneration.current;
    const lifetime = readLifetime.current;
    const startedEdit = editState.current.fingerprint;

    if (showLoading) setLoading(true);
    if (!background) setMessage("");

    try {
      const session = await getValidSession();
      if (!lifetime.active) return;
      const token = session?.access_token;
      if (!token) {
        setOrder(null);
        setMessage("Your CMPRI session has expired. Sign in again.");
        setLoading(false);
        return;
      }

      const response = await fetch(`/api/work-orders/${encodeURIComponent(id)}?include=mentions`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store", signal: lifetime.controller?.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!lifetime.active || generation !== ticketLoadGeneration.current) return;
      if (background && !canApplyTicketRefresh(startedEdit, editState.current)) {
        if (payload?.workOrder?.revision !== editState.current.revision) setMessage("This ticket changed while you were editing. Your unsaved text is preserved; saving an older revision will be rejected.");
        return;
      }
      if (!response.ok || !payload?.workOrder) {
        setOrder(null);
        setMessage(`Work order error: ${String(payload?.error || `HTTP ${response.status}`)}`);
        setLoading(false);
        return;
      }

      setMentionTickets(((payload.mentionTickets ?? []) as MentionTicket[]).filter((ticket) => !!ticket.id));
      if (generation !== ticketLoadGeneration.current) return;
      const row = payload.workOrder as WorkOrder;
      const loadedSearch = new URLSearchParams(window.location.search);
      if (loadedSearch.get("embedded") === "1" && window.parent !== window) window.parent.postMessage({type:"cmpri-work-order-loaded",workOrderId:row.id,workOrder:workOrderListSnapshot(row),modalToken:loadedSearch.get("modalToken")||""},window.location.origin);
      assetSelectionChanged.current = false;
      setOrder(row);
      setLocationId(row.location_id || "");
      if (row.can_correct_report) {
        void fetch("/api/rooms?mode=create", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" })
          .then(async response => {
            const result = await response.json();
            if (!response.ok || !Array.isArray(result.locations)) throw new Error(result.error || "Locations unavailable.");
            if (generation === ticketLoadGeneration.current) { setReportLocations(result.locations); setLocationError(""); }
          }).catch(error => { if (generation === ticketLoadGeneration.current) setLocationError(String(error.message)); });
      }
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
        locationId: row.location_id || "",
        issue: cleanTicketReportedIssue(row.issue || "", row.room || ""),
        assetId: row.asset_id || "",
        category: row.category || "General",
        priority: row.priority || "Medium",
        technicianName: row.technician_name || "",
        status: row.status || "Open",
        notes: row.notes || "",
        actionRootCause: row.action_root_cause || "",
        parts: row.parts || explicitPartSuggestion(loadedIssue),
        cost: row.cost == null ? "" : String(row.cost),
        hours: row.hours == null ? "" : String(row.hours),
        dueBy: normalizedDueBy,
      }));
      try {
        const identity = cmpriSessionRef.current;
        const key = identity ? `cmpri:ticket-draft:${identity.hotelId}:${identity.user.id}:${row.id}` : "";
        const recovered = !background && key ? JSON.parse(localStorage.getItem(key) || "null") : null;
        if (recovered?.version === 1 && recovered.fields && Number.isSafeInteger(recovered.revision)) {
          const f = recovered.fields;
          setLocationId(f.locationId); setIssue(f.issue); setAssetId(f.assetId); setCategory(f.category);
          setPriority(f.priority); setTechnicianName(f.technicianName); setStatus(f.status); setNotes(f.notes);
          setActionRootCause(f.actionRootCause); setParts(f.parts); setCost(f.cost); setHours(f.hours); setDueBy(f.dueBy);
          setNoteDraft(recovered.noteDraft || ""); setStagedNoteIds(recovered.stagedNoteIds || []);
          assetSelectionChanged.current = true;
          if (recovered.revision !== row.revision) {
            setOrder({ ...row, revision: recovered.revision });
            setMessage("Recovered draft: this ticket has changed. Your text is preserved. Compare with the saved ticket before combining changes; saving this older version will be rejected.");
          } else setMessage("Unsaved work recovered on this device.");
        }
      } catch { setMessage("The local draft could not be restored."); }
      recoveredDraft.current = true;
      setTicketReady(true);
      setSaveState("idle");

      // Render the ticket immediately. Reference data can finish loading in the
      // background; the user should not wait on assets/technicians just to read a work order.
      setLoading(false);
      if (canLoadMaintenanceReference) void loadMaintenanceReference().then(referenceAssets => {
        if (generation === ticketLoadGeneration.current && !row.asset_id && !assetSelectionChanged.current) {
          const guess = inferWorkOrder(loadedIssue, roomAssetsForInference(referenceAssets, row.location_id));
          if (guess.assetId) {
            setAssetId(guess.assetId); setSystemGuessAssetId(guess.assetId);
            // Reference hydration is a displayed default, not a user edit.
            setInitialFingerprint(previous => {
              const baseline = JSON.parse(previous || '{}');
              return JSON.stringify({...baseline,assetId:guess.assetId});
            });
          }
        }
      });
    } catch (error) {
      if (!lifetime.active || generation !== ticketLoadGeneration.current) return;
      if (!background) setOrder(null);
      setMessage(`Work order error: ${error instanceof Error ? error.message : String(error)}`);
      setLoading(false);
    }
  }

  async function loadManualForAsset(asset?: Asset, isCurrent: () => boolean = () => true) {
    if (!asset) return;
    let sourceAsset = asset;
    let knowledge: ManualKnowledge | null = null;
    let documentationStatus = "lookup_unavailable";
    let documentationReason = "The equipment’s uploaded document could not be checked. Only its approved document can provide instructions.";
    try {
      const session = await getValidSession();
      const token = session?.access_token;
      if (!token) return;
      const response = await fetch(`/api/maintenance-reference?assetId=${encodeURIComponent(asset.id)}&source=asset-upload`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = await response.json();
      const currentAsset = Array.isArray(payload?.assets) ? payload.assets.find((item: Asset) => item?.id === asset.id) : null;
      if (currentAsset) sourceAsset = { ...asset, ...currentAsset };
      const candidate = normalizeManualKnowledge(payload?.manualKnowledge);
      knowledge = candidate?.source?.source_kind === "asset-upload" && candidate.source.storage_path && /^[a-f0-9]{64}$/i.test(candidate.source.sha256 || "") && candidate.source.registered_file_id ? candidate : null;
      documentationStatus = String(payload?.documentation_status || (knowledge?.source?.verified ? "verified" : "not_found"));
      documentationReason = candidate && !knowledge
        ? "Only an approved document uploaded to this equipment can provide instructions."
        : String(payload?.documentation_reason || "The approved uploaded document has no instructions matching this report.");
    } catch {
      knowledge = null;
    } finally {
      if (isCurrent()) setManualResult({
        assetId: asset.id,
        documentationKey: sourceAsset.documentation_key,
        documentationRevisionId: sourceAsset.documentation_revision_id,
        documentationVerifiedAt: sourceAsset.documentation_verified_at,
        manufacturer: sourceAsset.manufacturer,
        modelFamily: sourceAsset.model_family,
        modelNumber: sourceAsset.model_number,
        knowledge,
        status: documentationStatus,
        reason: documentationReason,
      });
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
    const lifetime = readLifetime.current;
    (async () => {
      const allowed = await enforceSessionPreference();
      if (!lifetime.active) return;
      setEmbedded(isEmbedded);
      setModalToken(token);
      if (!allowed) {
        window.location.replace("/");
        return;
      }
      let canLoadMaintenanceReference = false;
      try {
        const session = await loadCmpriSession();
        if (!lifetime.active) return;
        setCmpriSession(session);
        cmpriSessionRef.current = session;
        canLoadMaintenanceReference = session.capabilities.includes("view_dashboard");
        const canViewTicket = session.capabilities.includes("view_dashboard") || session.capabilities.includes("view_work_orders") || session.capabilities.includes("edit_tickets") || session.capabilities.includes("review_tickets") || session.capabilities.includes("add_work_order_notes");
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
      await loadTicket(!hadPreview, canLoadMaintenanceReference);
      if (!lifetime.active) return;
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
    const stop = subscribeResources(["reference"], async () => {
      await loadManualForAsset(selectedAsset, () => current);
    });
    return () => { current = false; stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, selectedAsset?.id, selectedAsset?.documentation_key, selectedAsset?.documentation_revision_id, selectedAsset?.documentation_verified_at, selectedAsset?.manufacturer, selectedAsset?.model_family, selectedAsset?.model_number]);

  function handleAssetChange(newAssetId: string) {
    assetSelectionChanged.current = true;
    setManualResult(null);
    setAssetId(newAssetId);

    const asset = assets.find((item) => item.id === newAssetId);
    if (asset) {
      const nextCategory = categoryForAsset(asset);
      setCategory(nextCategory);
      if (roleKey(cmpriSession?.user.role) !== "technician") setPriority(priorityForCategory(nextCategory));
    }
  }

  const combinedDiagnosticText = `${issue} ${order?.reporter_notes || ""}`.trim();
  const trustedManualKnowledge = manualKnowledge?.source?.verified === true && manualKnowledge.source.source_kind === "asset-upload"
    && !!manualKnowledge.source.storage_path && /^[a-f0-9]{64}$/i.test(manualKnowledge.source.sha256 || "") && !!manualKnowledge.source.registered_file_id;
  const matchingSymptomRules = trustedManualKnowledge ? guideRulesForIssue(manualKnowledge, combinedDiagnosticText) : [];

  const manualSteps = Array.from(
    new Set(matchingSymptomRules.flatMap((rule) => rule.steps))
  );
  const checklistIssueSaved = issue.trim() === cleanTicketReportedIssue(order?.issue || "", order?.room || "").trim();
  const checklistContextUnsaved = !checklistIssueSaved || assetId !== (order?.asset_id || "") || locationId !== (order?.location_id || "");
  const checklistContext = deriveTroubleshootingChecklistContext({ issue: checklistIssueSaved ? order?.issue || "" : issue, reporter_notes: order?.reporter_notes || "", asset: selectedAsset || null }, manualKnowledge);
  const checklistDisabledReason = exitFlushing ? "Saving this visit's checklist activity before leaving."
    : !ticketReady || manualLoading || saving ? "Wait for the current work order and guidance to finish loading or saving."
    : checklistContextUnsaved
      ? "Save the reported issue, location, and equipment changes before updating this checklist." : undefined;
  const reportedCode = reportedDiagnosticCode(`${issue} ${order?.reporter_notes || ""}`);
  const sourcePassages = trustedManualKnowledge ? relevantSourcePassages(manualKnowledge?.source_passages || [], combinedDiagnosticText) : [];
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
      reportedCode ? normalizeDiagnosticCode(item.code) === reportedCode : score > 0
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

  const displayedSteps: ReturnType<typeof generalTroubleshootingFor> = [];

  const currentFingerprint = JSON.stringify({
    locationId,
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
  const hasUnsavedChanges = !!initialFingerprint && (currentFingerprint !== initialFingerprint || !!noteDraft.trim() || hasPendingNoteMedia);
  useLayoutEffect(() => {
    editState.current = { dirty: hasUnsavedChanges, fingerprint: currentFingerprint + noteDraft, revision: order?.revision || 0, saving };
  }, [hasUnsavedChanges, currentFingerprint, noteDraft, order?.revision, saving]);
  useEffect(() => {
    if (!ticketReady || !cmpriSession) return;
    const stop = subscribeResources(["orders"], async () => {
      await Promise.all([loadTicket(false, false, true), loadWorkOrderImages(true), loadExternalActivity()]);
    }, false);
    return stop;
    // Load functions read current editor state through refs; edits must not resubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ticketReady, cmpriSession]);

  function persistLocalDraft() {
    if (!cmpriSession || !order || !initialFingerprint || !recoveredDraft.current) return false;
    const key = `cmpri:ticket-draft:${cmpriSession.hotelId}:${cmpriSession.user.id}:${order.id}`;
    try {
      if (hasUnsavedChanges) localStorage.setItem(key, JSON.stringify({ version: 1, revision: order.revision, fields: JSON.parse(currentFingerprint), noteDraft, stagedNoteIds }));
      else localStorage.removeItem(key);
      setLocalDraftFailed(false);
      return true;
    } catch {
      setLocalDraftFailed(true);
      return false;
    }
  }
  useEffect(() => {
    // The warning reflects the result of an external browser-storage write.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    persistLocalDraft();
    // The form snapshot and identity below determine exactly what is stored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmpriSession, order, initialFingerprint, currentFingerprint, hasUnsavedChanges, noteDraft, stagedNoteIds]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (hasUnsavedChanges || exitFlushing) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsavedChanges, exitFlushing]);
  const runTicketExit = useCallback(async (leave: () => void) => {
    if (exitInFlight.current) return false;
    exitInFlight.current = true;
    setExitFlushing(true);
    setExitError("");
    const lifetime = readLifetime.current;
    try {
      if (partExitGuard.current) await partExitGuard.current();
      for (const flush of checklistExitFlushes.current) await flush();
      if (!lifetime.active || readLifetime.current !== lifetime) return false;
      leave();
      return true;
    } catch (error) {
      if (lifetime.active && readLifetime.current === lifetime) setExitError(error instanceof Error
        ? `This view stayed open: ${error.message}`
        : "The checklist activity could not be confirmed in the work-order note. Keep this view open and retry leaving.");
      return false;
    } finally {
      exitInFlight.current = false;
      if (lifetime.active && readLifetime.current === lifetime) setExitFlushing(false);
    }
  }, []);
  const closeEmbeddedTicket = useCallback(async (beforeClose?: () => void) => runTicketExit(() => {
    beforeClose?.();
    const pending = pendingExitAction.current;
    pendingExitAction.current = null;
    if (pending) { pending(); return; }
    if (embedded && window.parent !== window) {
      window.parent.postMessage(
        { type: "cmpri-work-order-cancelled", modalKind: "workOrder", workOrderId: order?.id, modalToken },
        window.location.origin
      );
      return;
    }
    router.push("/engineering");
  }), [embedded, modalToken, order?.id, router, runTicketExit]);
  function requestTicketNavigation(href: string) {
    if (saving || issueSaveCount.current > 0 || saveInFlight.current || exitInFlight.current) return;
    pendingExitAction.current = () => router.push(href);
    if (hasUnsavedChanges) { setShowCancelConfirm(true); return; }
    void closeEmbeddedTicket();
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


  function editSubmittedNote(entry: TicketHistoryEntry) {
    if (!entry.staged) return;
    const encoded = historyLine(entry);
    setNoteDraft(entry.text);
    setNotes((existing) => existing.split("\n").filter((line) => line.trim() !== encoded).join("\n"));
    setStagedNoteIds((lines) => lines.filter((line) => line !== encoded));
    requestAnimationFrame(() => document.getElementById("technician-note-editor")?.focus());
  }

  async function claimUnassignedWorkOrder() {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    try { await ticketWrites.current.enqueue(() => persistClaim(order?.id)); }
    catch { setMessage("Assignment error: Your changes could not be confirmed. Your draft is retained."); setSaving(false); }
    finally { saveInFlight.current = false; setSaving(false); }
  }

  async function persistClaim(ticketId?: string) {
    const order = orderRef.current;
    if (!order || order.id !== ticketId) return false;
    const assignedName = cmpriSession?.user.name?.trim();
    if (!assignedName) {
      setMessage("Your profile needs a name before you can take an unassigned work order.");
      return false;
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
      if (!response.ok || !payload.workOrder || payload.workOrder.id !== order.id || !Number.isSafeInteger(payload.workOrder.revision)) {
        throw new Error(payload.error || "This work order could not be assigned to you.");
      }
      const claimed = payload.workOrder as WorkOrder;
      setOrder({ ...order, ...claimed, technician_view_entries: order.technician_view_entries });
      setTechnicianName(assignedName);
      setInitialFingerprint(previous => JSON.stringify({ ...JSON.parse(previous || "{}"), technicianName: assignedName }));
      setSaveState("idle");
      setMessage("This work order is now assigned to you.");
      if (embedded && window.parent !== window) {
        await runTicketExit(() => window.parent.postMessage(
          { type: "cmpri-work-order-saved", modalKind: "workOrder", workOrderId: order.id, modalToken },
          window.location.origin,
        ));
      }
      return true;
    } catch (error) {
      setMessage(`Assignment error: ${error instanceof Error ? error.message : "This work order could not be assigned to you."}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveTicket(statusOverride?: string, notesOnly = false) {
    if (!order || !ticketReady || saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setSaveState("saving");
    try {
      return await ticketWrites.current.enqueue(() => persistTicket(statusOverride, notesOnly, order.id));
    } catch {
      setMessage("Save error: Your changes could not be confirmed. Your draft is retained.");
      setSaving(false); setSaveState("idle");
    } finally {
      saveInFlight.current = false;
      setSaving(false); setSaveState("idle");
    }
  }

  async function saveReportedIssue(text = issue) {
    if (!order || !ticketReady || !canEditField("issue")) return;
    setEditingIssue(false);
    issueSaveCount.current++;
    setIssueSaving(true);
    try {
      await ticketWrites.current.enqueue(async () => {
        const current = orderRef.current;
        if (!current || current.id !== order.id) return false;
        const normalized = cleanTicketReportedIssue(text, current.room || "");
        if (!normalized.trim() || normalized.length > 4000) {
          setMessage(!normalized.trim() ? "Reported Issue is required." : "Reported Issue must be 4,000 characters or fewer.");
          return false;
        }
        if (normalized === cleanTicketReportedIssue(current.issue || "", current.room || "")) return true;
        setMessage("");
        try {
          const session = await getValidSession();
          const response = await fetch(`/api/work-orders/${encodeURIComponent(current.id)}`, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${session?.access_token || ""}`, "Content-Type": "application/json" },
            body: JSON.stringify({ expected_revision: current.revision, issue: normalized }),
          });
          const payload = await response.json().catch(() => ({}));
          const saved = payload.workOrder as WorkOrder | undefined;
          if (!response.ok || !saved || saved.id !== current.id || !Number.isSafeInteger(saved.revision)) {
            throw new Error(payload.error || "Save could not be confirmed. Your draft is retained; check the saved ticket before retrying.");
          }
          setOrder({ ...current, ...saved, can_correct_report: saved.can_correct_report ?? current.can_correct_report });
          // Only this field was committed. Retain other drafts and text typed during the request.
          setIssue(latest => latest === text ? normalized : latest);
          setInitialFingerprint(previous => JSON.stringify({ ...JSON.parse(previous || "{}"), issue: normalized }));
          setMessage("Reported Issue saved.");
          if (embedded && window.parent !== window) await runTicketExit(() => window.parent.postMessage(
            { type: "cmpri-work-order-saved", modalKind: "workOrder", workOrderId: current.id, workOrder: workOrderListSnapshot(saved), modalToken }, window.location.origin));
          return true;
        } catch (error) {
          setMessage(`Save error: ${error instanceof Error ? error.message : "Reported Issue update failed."}`);
          return false;
        }
      });
    } catch {
      setMessage("Save error: Reported Issue could not be confirmed. Your draft is retained.");
    } finally {
      issueSaveCount.current--;
      setIssueSaving(issueSaveCount.current > 0);
    }
  }

  async function persistTicket(statusOverride?: string, notesOnly = false, ticketId?: string) {
    const order = orderRef.current;
    if (!order || !ticketReady || order.id !== ticketId) return false;
    const editorText = noteDraft.trim();
    const pendingLines = [...stagedNoteIds];
    if (editorText) pendingLines.push(historyLine({ id: "", timestamp: new Date().toISOString(), actor: currentActor, authorRole: cmpriSession ? accountRoleDisplayName(cmpriSession.user) : undefined, kind: "note", text: editorText }));
    const pendingTexts = pendingLines.flatMap(line => parseTicketHistory(line).map(entry => entry.text));
    const editorNotes = [notes.trim(), ...pendingLines.filter(line => !notes.split("\n").includes(line))].filter(Boolean).join("\n");
    const saveStatus = statusOverride ?? status;

    const roomChanged = canEditField("location_id") && locationId !== (order.location_id || "");
    const otherFieldEdits = pendingLines.length > 0 || assetSelectionChanged.current
      || category !== (order.category || "General") || priority !== (order.priority || "Medium")
      || technicianName !== (order.technician_name || "") || saveStatus !== (order.status || "Open")
      || actionRootCause !== (order.action_root_cause || "")
      || parts !== (order.parts || explicitPartSuggestion(cleanTicketReportedIssue(order.issue || "", order.room || "")))
      || cost !== (order.cost == null ? "" : String(order.cost)) || hours !== (order.hours == null ? "" : String(order.hours))
      || dueBy !== (order.due_by ? String(order.due_by).slice(0,10) : "");
    if (!notesOnly && roomChanged && otherFieldEdits) {
      setMessage("Save or discard other field edits before correcting Room/Location. Your edits are still here.");
      return false;
    }
    const normalizedIssue = cleanTicketReportedIssue(issue, order.room || "");
    if (!notesOnly && canEditField("issue") && !normalizedIssue.trim()) {
      setMessage("Reported Issue is required.");
      return false;
    }
    if (!notesOnly && normalizedIssue !== issue) setIssue(normalizedIssue);

    setSaving(true);
    setSaveState("saving");
    setMessage("");

    const asset = assets.find((item) => item.id === assetId);
    const fieldChanges: string[] = [];
    if (order.asset_id !== (asset?.id ?? null)) fieldChanges.push(`Asset: ${order.asset_name || "None"} → ${asset?.name || "None"}`);
    if ((order.category || "General") !== category) fieldChanges.push(`Category: ${order.category || "General"} → ${category}`);
    if ((order.priority || "Medium") !== priority) fieldChanges.push(`Priority: ${order.priority || "Medium"} → ${priority}`);
    if ((order.technician_name || "") !== technicianName.trim()) fieldChanges.push(`Technician: ${order.technician_name || "Unassigned"} → ${technicianName.trim() || "Unassigned"}`);
    if ((order.status || "Open") !== saveStatus) fieldChanges.push(`Status: ${order.status || "Open"} → ${saveStatus}`);
    const originalDue = order.due_by ? String(order.due_by).slice(0,10) : "";
    if (originalDue !== dueBy) fieldChanges.push(`Due By: ${originalDue || "None"} → ${dueBy || "None"}`);
    if (cleanTicketReportedIssue(order.issue || "", order.room || "") !== normalizedIssue) fieldChanges.push("Reported Issue updated");
    const changeLines = fieldChanges.map((text, index) => historyLine({ id: `change-${index}`, timestamp: new Date(Date.now() + index).toISOString(), actor: currentActor, kind: "change", text }));
    const notesWithChanges = [editorNotes.trim(), ...changeLines].filter(Boolean).join("\n");

    const updatePayload: Record<string, unknown> = {
      expected_revision: order.revision,
    };
    const capabilities = typeof cmpriSession !== "undefined" ? (cmpriSession?.capabilities ?? []) : ["edit_tickets"];
    if (notesOnly) {
      if (!pendingTexts.length) { setSaving(false); setSaveState("idle"); return true; }
      if (canAddWorkOrderNotes || canEditTicket || canReviewCurrentTicket) updatePayload.appendNotes = pendingTexts;
      else { setMessage("This account cannot add notes."); setSaving(false); setSaveState("idle"); return false; }
    } else if (canEditField("issue") && (!canEditTicket || (order.can_correct_report && !otherFieldEdits))) {
      if (pendingLines.length) {
        if (editingIssue) { setMessage("Finish editing, then save your staged notes before saving the report correction."); setSaving(false); setSaveState("idle"); return false; }
        updatePayload.appendNotes = pendingTexts;
      } else {
        if (normalizedIssue !== cleanTicketReportedIssue(order.issue || "", order.room || "")) updatePayload.issue = normalizedIssue;
        if (canEditField("location_id") && locationId !== (order.location_id || "")) updatePayload.location_id = locationId;
      }
    } else if (canEditField("issue")) {
      Object.assign(updatePayload, {
        issue: normalizedIssue,
        asset_id: assetId || null,
        asset_name: asset?.name ?? order.asset_name ?? "",
        category,
        priority,
        technician_name: technicianName.trim(),
        status: saveStatus,
        notes: notesWithChanges,
        action_root_cause: actionRootCause.trim(),
        parts: parts.trim(),
        cost: cost.trim() === "" ? 0 : Number(cost),
        hours: hours.trim() === "" ? 0 : Number(hours),
        due_by: dueBy || null,
      });
    } else if (canEditField("asset_id")) {
      Object.assign(updatePayload, {
        asset_id: assetId || null,
        category,
        status: saveStatus,
        notes: notesWithChanges,
      });
    } else if (canReviewCurrentTicket && capabilities.includes("review_tickets")) {
      if ((order.status || "Open") !== saveStatus) updatePayload.status = saveStatus;
      if (notesWithChanges !== (order.notes || "")) updatePayload.notes = notesWithChanges;
    } else if (canAddWorkOrderNotes && capabilities.includes("add_work_order_notes")) {
      if (pendingLines.length) updatePayload.appendNotes = pendingTexts;
    } else if (isTechnician) {
      setMessage("Take this work before editing its details.");
      setSaving(false);
      setSaveState("idle");
      return false;
    } else {
      setMessage("This account is view-only.");
      setSaving(false);
      setSaveState("idle");
      return false;
    }
    if (!notesOnly && canEditTicket && canEditField("location_id") && locationId !== (order.location_id || "")) {
      // Correcting the room must not commit inferred equipment, suggested parts, or defaults.
      for (const key of Object.keys(updatePayload)) {
        if (!["expected_revision", "issue"].includes(key)) delete updatePayload[key];
      }
      updatePayload.location_id = locationId;
      if (normalizedIssue === cleanTicketReportedIssue(order.issue || "", order.room || "")) delete updatePayload.issue;
    }
    if (Object.keys(updatePayload).length === 1) {
      setMessage("There are no changes to save.");
      setSaving(false);
      setSaveState("idle");
      return true;
    }

    let savedRow: WorkOrder | null = null;
    try {
      const session = await getValidSession();
      const token = session?.access_token || "";
      const appendOnly = Array.isArray(updatePayload.appendNotes);
      const response = await fetch(`/api/work-orders/${encodeURIComponent(order.id)}${appendOnly ? "/notes" : ""}`, {
        method: appendOnly ? "POST" : "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(appendOnly ? { notes: updatePayload.appendNotes, expected_revision: order.revision } : updatePayload),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.workOrder || payload.workOrder.id !== order.id || !Number.isSafeInteger(payload.workOrder.revision)) throw new Error(payload.error || "Save could not be confirmed. Your draft is retained; reload to check the saved ticket before retrying.");
      savedRow = (payload.workOrder || null) as WorkOrder | null;
    } catch (error) {
      setMessage(`Save error: ${error instanceof Error ? error.message : "Work order update failed."}`);
      setSaving(false);
      setSaveState("idle");
      // Keep unsaved edits and staged notes available for a deliberate retry.
      return false;
    }

    if (savedRow && !notesOnly && roomChanged) {
      roomContextGeneration.current++;
      setRoomOperationalContext({ ranker: null, rankerError: "", pm: null, guestName: "", roomStatus: "", checkoutDate: "", checkoutTime: "", checkoutError: "", loading: true });
    }
    if (savedRow) setOrder({ ...order, ...savedRow, can_correct_report: savedRow.can_correct_report ?? order.can_correct_report, creator_name: order.creator_name, creator_display_role: order.creator_display_role, technician_view_entries: order.technician_view_entries });
    if (statusOverride !== undefined) setStatus(saveStatus);
    const savedNotes = savedRow?.notes ?? notesWithChanges;
    setNotes(savedNotes);
    setStagedNoteIds([]);
    setNoteDraft("");
    if (notesOnly) {
      setInitialFingerprint(previous => { const base = JSON.parse(previous || "{}"); return JSON.stringify({ ...base, notes: savedNotes }); });
      setSaving(false); setSaveState("idle"); setMessage("Note saved.");
      return true;
    }
    if (Array.isArray(updatePayload.appendNotes) && (roomChanged || normalizedIssue !== cleanTicketReportedIssue(order.issue || "", order.room || ""))) {
      setSaving(false); setSaveState("idle"); setMessage("Notes saved. Save again to apply your report correction."); return true;
    }

    setInitialFingerprint(JSON.stringify({
      locationId, issue: normalizedIssue, assetId, category, priority, technicianName, status: saveStatus, notes: savedNotes,
      actionRootCause, parts, cost, hours, dueBy,
    }));
    setSaving(false);
    setMessage("Work order saved.");
    setSaveState("idle");
    if (embedded && window.parent !== window) await runTicketExit(() => window.parent.postMessage(
      { type: "cmpri-work-order-saved", modalKind: "workOrder", workOrderId: order.id, workOrder:workOrderListSnapshot(savedRow), modalToken }, window.location.origin));

    return true;
  }

  function exportUnsavedDraft() {
    const text = JSON.stringify({ workOrder: formatWorkOrder(order?.display_id), expectedRevision: order?.revision, fields: JSON.parse(currentFingerprint), noteDraft }, null, 2);
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "cmpri-work-order-draft.json"; link.click();
    URL.revokeObjectURL(url);
  }
  function closeAndKeepDraft() {
    if (saving || hasPendingNoteMedia) return;
    // Persist the current render synchronously: an effect may not have run yet,
    // and storage can fail after an earlier successful write.
    if (!persistLocalDraft()) return;
    closeEmbeddedTicket();
  }
  function discardLocalDraftAndClose() {
    if (saving || !cmpriSession || !order) return;
    try {
      // A storage failure must keep this editing visit open before its journal
      // is finalized. Retain in-memory edits and recovery until exit succeeds.
      localStorage.removeItem(`cmpri:ticket-draft:${cmpriSession.hotelId}:${cmpriSession.user.id}:${order.id}`);
    } catch { setMessage("The local draft could not be cleared. Your text is still here."); return; }
    void closeEmbeddedTicket(() => { recoveredDraft.current = false; });
  }
  const cancelTicket = useCallback(() => {
    if (saving || issueSaveCount.current > 0 || saveInFlight.current) return;
    if (hasUnsavedChanges) {
      setShowCancelConfirm(true);
      return;
    }
    closeEmbeddedTicket();
  }, [closeEmbeddedTicket, hasUnsavedChanges, saving]);

  useEffect(() => {
    if (!embedded) return;
    const handleModalCancelRequest = (event: Event) => {
      event.preventDefault();
      cancelTicket();
    };
    document.addEventListener("cmpri-modal-cancel-request", handleModalCancelRequest);
    return () => document.removeEventListener("cmpri-modal-cancel-request", handleModalCancelRequest);
  }, [embedded, cancelTicket]);

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
        {!embedded && (
          <Link href="/engineering" className="text-amber-400">
            ← Engineering Dashboard
          </Link>
        )}
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

  const rankedAssets = [...assignableAssetsForLocation(assets, order?.location_id, assetId)].sort((a, b) => {
    const delta = assetIssueScore(b) - assetIssueScore(a);
    if (delta !== 0) return delta;
    return a.name.localeCompare(b.name);
  });

  const assetOptions = [
    ...rankedAssets.map((asset) => {
      const score = assetIssueScore(asset);
      const exactLocation = !!order?.location_id && asset.location_id === order.location_id;
      const sameCategory = categoryForAsset(asset) === category;
      const group = !exactLocation
        ? asset.location_id === null ? "Templates - No Room Assignment" : "Current Ticket Equipment"
        : score >= 180
          ? "Best Match — This Location"
          : sameCategory
            ? "This Location — Same Category"
            : "This Location";
      return {
        value: asset.id,
          label: asset.location_name ? `${asset.name} - ${asset.location_name}` : `${asset.name}${asset.location_id === null ? " (Template - no room assignment)" : ""}`,
        group,
        keywords: [
          asset.asset_type,
          ...equipmentSearchAliases([asset.name, asset.manufacturer, asset.model_family].filter(Boolean).join(" ")),
          asset.model_family || "",
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
  const canAccessAssignedWork = canAccessWorkOrderByAssignment(cmpriSession && (profileIsChiefEngineer(cmpriSession.user) || profileIsEstablishedHoursChief(cmpriSession.user)) ? "Chief Engineer" : cmpriSession?.user.role, cmpriSession?.user.name, order);
  const canEditTicket = canAccessAssignedWork && Boolean(cmpriSession?.capabilities.includes("edit_tickets"));
  const canReviewTicket = Boolean(cmpriSession?.capabilities.includes("review_tickets"));
  const canAddWorkOrderNotes = Boolean(cmpriSession?.capabilities.includes("add_work_order_notes"));
  const canReopenTicket = Boolean(cmpriSession?.capabilities.includes("reopen"));
  const chief = !!cmpriSession && (profileIsChiefEngineer(cmpriSession.user) || profileIsEstablishedHoursChief(cmpriSession.user));
  const pendingField = (key: string) => pendingTicketField(chief, initialFingerprint, currentFingerprint, key)
    ? <span data-pending-field={key} aria-label="Unsaved change" title="Unsaved change" className="text-red-500" style={{ fontSize: "inherit" }}> !</span>
    : null;
  const isTechnician = !chief && roleKey(cmpriSession?.user.role) === "technician";
  const canClaimWorkOrder = isTechnician &&
    canEditTicket &&
    !String(order.technician_name || "").trim() &&
    ["Open", "In Progress"].includes(String(order.status || "Open"));
  const canReviewCurrentTicket = canReviewTicket && order.status === "Pending Verification";
  const editableFields: readonly WorkOrderEditableField[] = [...workOrderEditableFields({
    role: chief ? "Chief Engineer" : cmpriSession?.user.role,
    canEdit: canEditTicket,
    canReview: canReviewCurrentTicket,
    canAddNotes: canAddWorkOrderNotes && ["Open", "In Progress"].includes(String(order.status || "")),
    unassigned: !String(order.technician_name || "").trim(),
    canClaimUnassigned: canClaimWorkOrder,
  }), ...(order.can_correct_report ? ["issue", "location_id"] as const : [])];
  const canSubmitTicketNote = ticketReady && canSubmitWorkOrderNote({
    role: chief ? "Chief Engineer" : cmpriSession?.user.role,
    canEdit: canEditTicket,
    canReview: canReviewCurrentTicket,
    canAddNotes: canAddWorkOrderNotes,
    status: order.status,
    unassigned: !String(order.technician_name || "").trim(),
    canClaimUnassigned: canClaimWorkOrder,
  });
  const canEditField = (field: WorkOrderEditableField) => ticketReady && editableFields.includes(field);
  const canEditWorkOrder = editableFields.some((field) => field !== "technician_name" && field !== "notes");
  const statusValues = (() => {
    if (chief && canEditField("status")) return ["Pending Verification", "Open", "In Progress", "Completed", "Will Not Do", "Closed"];
    if (canReviewCurrentTicket && !canEditTicket) {
      return status === "Pending Verification" ? ["Pending Verification", "Open", "Will Not Do"] : [status];
    }
    if (!canEditField("status")) return [status];
    if (isTechnician) {
      const values = ["Open", "In Progress", "Completed"];
      return values.includes(status) ? values : [status];
    }
    if (status === "Closed") return canReopenTicket ? ["Closed", "In Progress", "Completed"] : ["Closed"];
    const values = ["Open", "In Progress", "Completed", "Will Not Do", "Closed"];
    return status === "Pending Verification" ? ["Pending Verification", ...values] : values;
  })();
  const statusOptions = Array.from(new Set(statusValues)).map((value) => ({ value, label: value }));
  function ticketMentionLabel(ticket: MentionTicket) {
    return formatWorkOrder(ticket.display_id, `WO-${ticket.id.slice(0, 8)}`);
  }

  function openMentionedTicket(ticket: MentionTicket) {
    if (embedded && window.parent !== window) {
      window.parent.postMessage(
        { type: "cmpri-open-related-work-order", modalKind: "workOrder", workOrderId: order?.id, targetWorkOrderId: ticket.id, modalToken },
        window.location.origin
      );
      return;
    }
    requestTicketNavigation(`/work-orders/${encodeURIComponent(ticket.id)}`);
  }

  function renderHistoryText(text: string) {
    const urlRanges = plainTextParts(text).filter(part => part.href); const refs = workOrderReferences(text).filter(ref => !urlRanges.some(url => ref.start < url.end && ref.end > url.start));
    const legacyTargets = new Map<number, MentionTicket>();
    // Keep historical internal-ID mentions working without changing their links.
    for (const match of text.matchAll(/@(?:WO-)?[a-f0-9-]{8,36}\b/gi)) {
      if (urlRanges.some(url => match.index! < url.end && match.index! + match[0].length > url.start)) continue;
      if (refs.some(ref => match.index! < ref.end && match.index! + match[0].length > ref.start)) continue;
      const id = match[0].replace(/^@(?:WO-)?/i, "").toLowerCase();
      const resolvedId = referencePrefixes[id.replaceAll("-", "")];
      const ticket = referenceTickets.find(candidate => candidate.id === resolvedId);
      if (ticket) {
        legacyTargets.set(match.index!, ticket);
        refs.push({ start: match.index!, end: match.index! + match[0].length, number: workOrderNumber(ticket.display_id) || "", label: ticketMentionLabel(ticket) });
      }
    }
    const output: React.ReactNode[] = referenceError ? [<span key="reference-error" role="status" className="block text-xs text-amber-300">{referenceError}</span>] : [];
    let at = 0;
    for (const ref of refs.sort((a,b) => a.start - b.start)) {
      const matches = referenceTickets.filter(candidate => workOrderNumber(candidate.display_id) === ref.number);
      const ticket = legacyTargets.get(ref.start) || (matches.length === 1 ? matches[0] : undefined);
      output.push(<span key={`text-${at}`}><WorkOrderMentionText text={text.slice(at, ref.start)} mentions={mentionDirectory} /></span>);
      output.push(ticket ? <button key={`mention-${ref.start}`} type="button" onClick={() => openMentionedTicket(ticket)} className="font-semibold text-sky-300 underline decoration-sky-500/60 underline-offset-2 hover:text-sky-200" title={`Open ${ref.label} - ${ticket.room || "No location"}`}>{ref.label}</button> : <span key={`mention-${ref.start}`} className="text-slate-400">{ref.label}</span>);
      at = ref.end;
    }
    output.push(<span key="remaining"><WorkOrderMentionText text={text.slice(at)} mentions={mentionDirectory} /></span>);
    return output;
  }
  const parsedHistory = parseTicketHistory(notes, order.created_at);
  const stagedLineSet = new Set(stagedNoteIds);
  const historyEntries: TicketHistoryEntry[] = parsedHistory.map((entry) => ({
    ...entry,
    staged: entry.kind === "note" && stagedLineSet.has(historyLine(entry)),
  }));
  for (const view of order.technician_view_entries || []) {
    historyEntries.push({
      id: `technician-view-${view.id}`,
      timestamp: view.viewed_at,
      actor: view.technician_name || "Technician",
      kind: "system",
      text: "Technician Viewed this work order",
      locked: true,
    });
  }
  const authoritativeHistory = externalActivity.history || [];
  for (const event of authoritativeHistory) {
    const text = workOrderHistoryText(event, event.recorded_at);
    historyEntries.push({
      id: `db-${event.id}`,
      timestamp: event.recorded_at || order.created_at || new Date(0).toISOString(),
      actor: event.actor_name || "CMPRI User",
      kind: event.event_type === "created" ? "system" : "change",
      text,
      locked: true,
    });
  }
  if (order.created_at && !authoritativeHistory.some((event) => event.event_type === "created")) {
    historyEntries.push({ id: "created", timestamp: order.created_at, actor: "System", kind: "system", text: "Work order created" });
  }
  const uniqueHistory = new Map<string, TicketHistoryEntry>();
  for (const entry of historyEntries) uniqueHistory.set(`${entry.timestamp}|${entry.actor}|${entry.authorRole || ""}|${entry.kind}|${entry.text}`, entry);
  historyEntries.splice(0, historyEntries.length, ...Array.from(uniqueHistory.values()));
  historyEntries.sort((a,b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const roomOccupancy = roomStatusBadge(order.room_status || roomOperationalContext.roomStatus);
  const checkout = checkoutLabel(roomOperationalContext.checkoutDate, roomOperationalContext.checkoutTime);

  return (
    <main aria-busy={exitFlushing} className="min-h-screen bg-slate-950 text-[16px] text-white">
      {exitFlushing && <p role="status" className="sr-only">Saving checklist activity before leaving this work order.</p>}
      <div inert={exitFlushing} className="mx-auto max-w-7xl px-3 pb-4 sm:px-4">
        <div data-preview-locked-pane className="sticky top-0 z-20 -mx-3 flex flex-wrap items-start justify-between gap-2 border-b border-slate-800 bg-slate-950/95 px-3 py-2 backdrop-blur sm:-mx-4 sm:px-4">
          <div data-preview-mobile-number><button
              type="button"
              title="Copy work order number"
              onClick={() => { if (order.display_id) void navigator.clipboard?.writeText(formatWorkOrder(order.display_id)); }}
              className="whitespace-nowrap rounded-full border border-orange-500/50 bg-orange-950/45 px-2 py-0.5 text-[10px] font-bold text-orange-200"
            >
              {formatWorkOrder(order.display_id)}
            </button></div><div className="order-2 min-w-0 w-full sm:order-none sm:w-auto sm:flex-1">
            {!embedded && (
              <Link
                href="/engineering"
                onClick={event => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault(); requestTicketNavigation("/engineering");
                }}
                className="text-xs font-semibold text-amber-400 hover:text-amber-300"
              >
                ← Engineering Dashboard
              </Link>
            )}
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-xl border border-sky-900 bg-slate-900/70 p-2">
              <div className="min-w-0 flex-1">
                <div data-preview-detail-title className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                  <div className="min-w-0">
                    <h1 className="flex min-w-0 items-center gap-1.5 text-lg font-bold leading-tight text-white">
                      <span className="truncate">{order.room || "Work Order"}</span>
                    </h1>

                  </div>
                  {roomOccupancy && <span className={`inline-flex whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-tight ${roomOccupancy.className}`}>{roomOccupancy.label}</span>}
                  {checkout && <span className={`inline-flex whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-tight ${checkout.className}`}>{checkout.label}</span>}
                  {priority && <span className={`inline-flex whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-tight ${priorityClass(priority)}`}>{priorityLabel(priority)}</span>}
                  <PartsStatusPill status={order.parts_status} />
                  <span className={`inline-flex whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-tight ${statusClass(status)}`}>{normalizeKpiStatus(status)}</span>
                </div>
                <div data-work-order-guest className="cmpri-detail-guest-row"><WorkOrderGuestIndicators guest={order as unknown as Record<string,unknown>} /></div>
                <div className="mt-1 flex min-w-0 flex-col items-start gap-y-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-x-2">
                  <p className="w-full min-w-0 break-words text-sm leading-5 text-white sm:flex-1" title={issue || "No reported issue"}>{issue || "No reported issue"}</p>
                  <p className="w-full truncate text-[11px] leading-tight text-sky-200/75 sm:max-w-[45%] sm:shrink-0 sm:text-right" title={technicianName || "Unassigned"}>Assigned to: {technicianName || "Unassigned"}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="order-1 ml-auto grid shrink-0 justify-items-end gap-1 self-start sm:order-none">
            <button data-preview-desktop-number
              type="button"
              title="Copy work order number"
              onClick={() => { if (order.display_id) void navigator.clipboard?.writeText(formatWorkOrder(order.display_id)); }}
              className="whitespace-nowrap rounded-full border border-orange-500/50 bg-orange-950/45 px-2 py-0.5 text-[10px] font-bold text-orange-200"
            >
              {formatWorkOrder(order.display_id)}
            </button>
            <WorkOrderImportPill order={order} />

          </div><div data-preview-locked-actions className="preview-locked-actions">
              <button
                type="button"
                onClick={cancelTicket}
                disabled={saving || issueSaving || exitFlushing}
                className="min-h-9 whitespace-nowrap rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-900 disabled:opacity-60"
              >
                Cancel
              </button>
              {(editableFields.length > 0 || canReviewCurrentTicket) && <button
                type="button"
                onClick={() => { void saveTicket(); }}
                disabled={saving || exitFlushing || saveState === "saved"}
                className={`min-h-9 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors disabled:opacity-80 ${
                  saveState === "saved"
                    ? "border-emerald-500 bg-emerald-600 text-white"
                    : saveState === "saving"
                      ? "border-sky-900 bg-sky-950/70 text-sky-200"
                      : hasUnsavedChanges
                        ? "border-sky-500 bg-sky-700 text-white ring-2 ring-sky-400/20 hover:bg-sky-600"
                        : "border-sky-500 bg-sky-700 text-white hover:bg-sky-600"
                }`}
              >
                {saveState === "saving"
                  ? "Saving..."
                  : saveState === "saved"
                    ? "Saved"
                    : hasUnsavedChanges
                      ? canAddWorkOrderNotes && !canEditWorkOrder && !canReviewCurrentTicket ? "Save Notes" : "Save Changes"
                      : canAddWorkOrderNotes && !canEditWorkOrder && !canReviewCurrentTicket ? "Save Notes" : "Save Work Order"}
              </button>}
            </div>
        </div>

        {message && (
          <div className="mt-2 rounded-xl border border-slate-700 bg-slate-900 p-2 text-sm">
            {message}
            {hasUnsavedChanges && <button type="button" onClick={exportUnsavedDraft} className="ml-2 min-h-9 text-sky-300 underline">Download draft copy</button>}
          </div>
        )}

        {exitFlushing && <p role="status" className="mt-2 text-sm text-sky-200">Saving checklist activity to this work order before leaving…</p>}
        {exitError && <p role="alert" className="mt-2 rounded-xl border border-amber-500 bg-amber-950/40 p-2 text-sm text-amber-100">{exitError}</p>}

        {localDraftFailed && hasUnsavedChanges && (
          <div role="alert" className="mt-2 rounded-xl border border-amber-500 bg-amber-950/40 p-2 text-sm text-amber-100">
            Your changes could not be saved on this device. Keep this view open and save the work order, or download a copy of your text before leaving.
            <button type="button" onClick={exportUnsavedDraft} className="ml-2 min-h-9 text-sky-300 underline">Download draft copy</button>
          </div>
        )}

        {cmpriSession?.capabilities.includes("view_dashboard") && (roomOperationalContext.ranker || order?.room) && !roomOperationalContext.loading && roomOperationalContext.checkoutError && (
          <p role="alert" className="mt-2 text-xs text-red-300">Room checkout details are unavailable: {roomOperationalContext.checkoutError}</p>
        )}

        <div aria-busy={saving} className="mt-2 grid min-w-0 gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]">
          <div className="min-w-0 space-y-2">
            <section data-reported-issue className="rounded-xl border border-slate-800 bg-slate-900 p-1.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold leading-tight tracking-tight">Reported Issue{pendingField("issue")}</h2>
                  {issueSaving && <span role="status" className="text-xs text-sky-200">Saving issue...</span>}
                  {editingIssue && <button type="button" onClick={() => { void saveReportedIssue(); }} className="min-h-9 rounded-lg border border-amber-400 px-3 text-xs text-amber-100">Done</button>}
                </div>
                <div className="text-right text-[10px] leading-tight text-slate-500">
                  <div>Created by <span className="font-semibold text-slate-300">{order.creator_name || "—"}</span>{order.creator_display_role && <span className="text-sky-200"> · {order.creator_display_role}</span>}</div>
                  <div>{formatDateTime(order.created_at)}</div>
                </div>
              </div>

              {editingIssue && canEditField("issue") ? (
                <>
                  <textarea
                    aria-label="Reported Issue"
                    onBlur={(event) => { void saveReportedIssue(event.currentTarget.value); }}
                    autoFocus
                    disabled={saving}
                    required
                    value={issue}
                    onChange={(event) => setIssue(event.target.value)}
                    rows={2}
                    className="mt-1 max-h-20 w-full resize-y overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm text-white outline-none focus:border-amber-400"
                  />
                  <div className="mt-1 rounded-lg border border-sky-500/25 bg-sky-950/20 px-2 py-1 text-[10px] leading-tight text-sky-100/80">
                    Editing an existing ticket never creates additional work orders. Additional problems entered here remain attached to this ticket as sub-issues unless someone deliberately creates a separate work order.
                  </div>
                </>
              ) : (
                <button type="button" disabled={!canEditField("issue") || saving} onClick={() => setEditingIssue(true)} aria-label="Edit reported issue" className="mt-0.5 w-full whitespace-pre-wrap break-words py-0.5 text-left text-sm leading-5 text-slate-200">{issue || "No issue"}</button>
              )}

              {order.can_correct_report && (
                <div className="mt-2">
                  <label htmlFor="report-location" className="text-xs font-semibold text-slate-400">Room/Location{pendingField("locationId")}</label>
                  {editingField === "location_id" ? <select autoFocus onBlur={() => setEditingField(null)} id="report-location" aria-label="Room/Location" value={locationId} onChange={event => setLocationId(event.target.value)} disabled={saving || !reportLocations.length} className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm">
                    {!reportLocations.some(location => location.id === locationId) && <option value={locationId}>{order.room || "Select location"}</option>}
                    {reportLocations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}
                  </select> : <button type="button" disabled={saving} onClick={() => setEditingField("location_id")} className="min-h-10 text-sm">{reportLocations.find(location => location.id === locationId)?.name || order.room}</button>}
                  {locationError && <p role="alert" className="text-xs text-red-300">{locationError}</p>}
                  {locationId !== (order.location_id || "") && <p className="text-xs text-amber-300">Saving corrects the room and reported issue only. Equipment and other ticket details stay unchanged; Engineering must verify equipment for the corrected room.</p>}
                </div>
              )}
              {equipmentLocationMismatch && <p role="alert" className="mt-2 text-xs text-amber-300">Saved equipment belongs to another location. Its guide is hidden until Engineering verifies the equipment for this room.</p>}

              {order.reporter_notes && (
                <div className="mt-2 rounded-lg border border-slate-700 bg-slate-950/60 p-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reporter Notes</div>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-slate-300"><PlainTextLinks text={order.reporter_notes} /></p>
                </div>
              )}

              {status === "Pending Verification" && canReviewTicket && (
                <div className="mt-2 flex justify-end">
                  <button type="button" onClick={() => { void saveTicket("Open"); }} disabled={saving} className="rounded-lg border border-purple-400/50 bg-purple-950/40 px-3 py-2 text-xs font-bold text-purple-100 hover:bg-purple-900/50 disabled:opacity-60">Approve → Open</button>
                </div>
              )}

              <div data-preview-metadata className="mt-1 grid gap-1.5 sm:grid-cols-3">
                <div className="rounded-lg border border-slate-800 bg-slate-950/55 p-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Asset / Equipment{pendingField("assetId")}</div>
                  {editingField === "asset_id" && canEditField("asset_id") ? <div className="mt-1"><SearchableSelect onDismiss={chief ? () => setEditingField(null) : undefined} value={assetId} onChange={handleAssetChange} disabled={saving || assetReferenceLoading || Boolean(assetReferenceError)} placeholder={assetReferenceLoading ? "Loading equipment…" : assetReferenceError ? "Equipment unavailable" : "Asset / Equipment"} options={assetOptions} topSuggestions={3} expandOnOpen footerActionLabel={canEditField("asset_name") ? "+ Add New Asset" : undefined} onFooterAction={canEditField("asset_name") ? () => setShowAddAsset(true) : undefined} />{assetReferenceError && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-300"><span role="alert">{assetReferenceError}</span><button type="button" onClick={() => void loadMaintenanceReference()} className="font-semibold underline">Retry loading equipment</button></div>}{systemGuessAssetId && systemGuessAssetId === assetId && <p className="mt-2 text-xs font-semibold text-emerald-400">System best guess</p>}</div> : <button type="button" disabled={!canEditField("asset_id") || saving} onClick={() => setEditingField("asset_id")} aria-label="Edit asset id" className="cmpri-ticket-field mt-1 min-h-8 w-full text-left text-sm text-slate-200">{selectedAsset?.name || order.asset_name || "Not identified"}</button>}
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950/55 p-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Category{pendingField("category")}</div>
                  {editingField === "category" && canEditField("category") ? <div className="mt-1"><SearchableSelect onDismiss={chief ? () => setEditingField(null) : undefined} value={category} onChange={setCategory} placeholder="Category" options={categoryOptions} topSuggestions={2} /></div> : <button type="button" disabled={!canEditField("category") || saving} onClick={() => setEditingField("category")} aria-label="Edit category" className="cmpri-ticket-field mt-1 min-h-8 w-full text-left text-sm text-slate-200">{category || "General"}</button>}
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950/55 p-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Priority{pendingField("priority")}</div>
                  {editingField === "priority" && canEditField("priority") ? <div className="mt-1"><SearchableSelect onDismiss={chief ? () => setEditingField(null) : undefined} value={priority} onChange={setPriority} placeholder="Priority" options={priorityOptions} topSuggestions={2} /></div> : <button type="button" disabled={!canEditField("priority") || saving} onClick={() => setEditingField("priority")} aria-label="Edit priority" className="cmpri-ticket-field mt-1 min-h-8 w-full text-left text-sm text-slate-200">{priority || "Medium"}</button>}
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950/55 p-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Technician{pendingField("technicianName")}</div>
                  {editingField === "technician_name" && canEditField("technician_name") ? <div className="mt-1"><SearchableSelect onDismiss={chief ? () => setEditingField(null) : undefined} value={technicianName} onChange={setTechnicianName} placeholder="Technician" options={technicianOptions} topSuggestions={2} /></div> : <button type="button" disabled={!canEditField("technician_name") || saving} onClick={() => setEditingField("technician_name")} aria-label="Edit technician name" className="cmpri-ticket-field mt-1 min-h-8 w-full text-left text-sm text-slate-200">{technicianName || "Unassigned"}</button>}
                  {canClaimWorkOrder && <button type="button" onClick={() => void claimUnassignedWorkOrder()} disabled={saving} className="mt-1 rounded-lg border border-emerald-400/50 bg-emerald-950/40 px-2 py-1 text-[11px] font-bold text-emerald-100 hover:bg-emerald-900/50 disabled:opacity-50">{saving ? "Taking work…" : "Take this work"}</button>}
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950/55 p-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status{pendingField("status")}</div>
                  {editingField === "status" && canEditField("status") ? <div className="mt-1"><SearchableSelect onDismiss={chief ? () => setEditingField(null) : undefined} value={status} onChange={setStatus} placeholder="Status" options={statusOptions} topSuggestions={2} expandOnOpen={chief} /></div> : <button type="button" disabled={!canEditField("status") || saving} onClick={() => setEditingField("status")} aria-label="Edit status" className="cmpri-ticket-field mt-1 min-h-8 w-full text-left text-sm text-slate-200">{status || "Open"}</button>}
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950/55 p-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Due By{pendingField("dueBy")}</div>
                  {editingField === "due_by" && canEditField("due_by") ? <input disabled={saving} autoFocus aria-label="Due By" onBlur={() => setEditingField(null)} type="date" value={dueBy} onChange={(event) => setDueBy(event.target.value)} className="mt-1 min-h-8 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm outline-none focus:border-amber-400" /> : <button type="button" disabled={!canEditField("due_by") || saving} onClick={() => setEditingField("due_by")} aria-label="Edit due by" className="cmpri-ticket-field mt-1 min-h-8 w-full text-left text-sm text-slate-200">{dueBy || "No due date"}</button>}
                </div>
              </div>
            </section>


            <section data-preview-conversation className="rounded-2xl border border-slate-800 bg-slate-900 p-2">
              <h2 className="text-sm font-bold tracking-tight text-slate-100">{notesLanguage === "es" ? "Notas e historial de la orden" : "Notes & Ticket History"}</h2>
              <div ref={historyScrollRef} className="mt-2 max-h-[8.5rem] overflow-y-auto rounded-lg border border-slate-700 bg-slate-950">
                {historyEntries.length ? historyEntries.map((entry) => {
                  const when = new Date(entry.timestamp);
                  const visibleTime = Number.isNaN(when.getTime()) ? entry.timestamp : when.toLocaleString([], { month: "numeric", day: "numeric", year: "2-digit", hour: "numeric", minute: "2-digit" });
                  const hoverTime = Number.isNaN(when.getTime()) ? entry.timestamp : when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
                  return (
                    <div key={entry.id} className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[7rem_6rem_minmax(0,1fr)_auto] items-start gap-1 border-b border-slate-800 px-2 py-1 text-xs leading-tight last:border-b-0">
                      <span className="text-slate-500" title={hoverTime}>{visibleTime}</span>
                      <span className="truncate font-semibold text-sky-200">{entry.actor.trim().split(/\s+/)[0] || "CMPRI"}</span>
                      <span className="text-slate-300">{renderHistoryText(entry.text)}</span>
                      {entry.locked && <span className="text-xs font-semibold text-amber-300">Locked</span>}
                      {entry.staged && <button type="button" disabled={saving} onClick={() => editSubmittedNote(entry)} className="font-semibold text-sky-300 hover:text-sky-200">Edit</button>}
                    </div>
                  );
                }) : <div className="px-2 py-1.5 text-xs text-slate-500">No ticket history yet.</div>}<WorkOrderAttachmentHistory items={workOrderImages} onRemove={image=>void removeSavedPhoto(image)} removing={!!removingPhotoId || photoUploading}/>
              </div>
            {workOrderImageError&&<div role="alert" className="text-xs text-red-200">{workOrderImageError}<button type="button" onClick={()=>void loadWorkOrderImages()} disabled={workOrderImagesLoading}>Retry attachments</button></div>}{workOrderImagesLoading&&<p role="status" className="text-xs text-slate-400">Loading attachments…</p>}{photoUploadError&&<p role="alert" className="text-xs text-red-200">{photoUploadError}</p>}{photoUploadMessage&&<p role="status" className="text-xs text-emerald-300">{photoUploadMessage}</p>}

              <div className="relative">
                <WorkOrderNoteComposer label={noteHeading(cmpriSession ? accountRoleDisplayName(cmpriSession.user) : undefined, notesLanguage)} disabled={saving || !canSubmitTicketNote} value={noteDraft} onChange={setNoteDraft} mentions={mentionDirectory} tickets={mentionTickets} />
                {mentionDirectoryError && <p role="status" className="mt-1 text-xs text-amber-300">{mentionDirectoryError}</p>}
              </div>
              <WorkOrderMediaComposer key={order.id} workOrderId={order.id} disabled={saving || !canSubmitTicketNote} hasNote={!!noteDraft.trim()} onSubmitNote={()=>saveTicket(undefined,true)} onUploaded={loadWorkOrderImages} onPendingChange={setHasPendingNoteMedia} onBusyChange={setPhotoUploading}/>
            </section>


            <details className="rounded-2xl border border-slate-800 bg-slate-900 p-1">
              <summary className="list-item cursor-pointer">
                <h2 className="text-base font-bold leading-tight tracking-tight text-amber-400">
                  Suggested Troubleshooting
                </h2>
                {selectedAsset && (
                  <span className="truncate text-[11px] text-slate-500">
                    {manualLoading
                      ? "Reading the equipment’s uploaded document..."
                      : checklistContext.steps.length
                        ? "Instructions from this equipment’s uploaded document"
                        : "Describe the problem to find matching instructions"}
                  </span>
                )}
              </summary>

              {!selectedAsset && (
                <div className="mt-0.5 rounded-xl border border-slate-700 bg-slate-950 p-0.5 text-sm text-slate-300">
                  Choose the equipment to read its uploaded manual.
                </div>
              )}

              {selectedAsset && !manualLoading && !trustedManualKnowledge && (
                <div className="mt-1 rounded-xl border border-amber-500/30 bg-amber-950/15 p-1 text-sm text-amber-100">
                  {manualReason || (manualStatus === "lookup_unavailable"
                    ? "The uploaded equipment document could not be checked. Try again or ask Engineering to review the attachment."
                    : manualStatus === "identity_incomplete"
                      ? "Engineering needs to save this equipment’s manufacturer and model before its uploaded manual can be checked."
                      : manualStatus === "no_guidance"
                        ? "The uploaded document matches the equipment, but has no readable troubleshooting instructions."
                      : manualStatus === "ambiguous"
                        ? "More than one approved document matches this equipment. Ask Engineering to choose the intended document."
                        : "No approved uploaded document is available for this equipment.")}
                </div>
              )}

                {selectedAsset && trustedManualKnowledge && cmpriSession && (
                  <WorkOrderTroubleshootingChecklist
                    workOrderId={order.id}
                    visitId={troubleshootingVisitId}
                    registerExitFlush={registerExitFlush}
                    session={cmpriSession}
                    expectedContextIdentity={checklistContext.contextIdentity}
                    ticketRevision={order.revision}
                    disabledReason={checklistDisabledReason}
                    previewSteps={checklistContextUnsaved ? checklistContext.steps : undefined}
                    manualUrl={guideDocuments[0]?.url}
                    reportedIssue={issue}
                    equipmentName={selectedAsset.name}
                    sourceFileName={guideDocuments[0]?.name}
                    assetId={selectedAsset.id}
                    sourceSha256={manualKnowledge?.source?.sha256 || ""}
                  />
                )}

              <div className="mt-0.5 max-h-[26rem] overflow-y-auto pr-1">
                {manualKnowledge?.source?.title && (
                  <div className="rounded-lg border border-slate-800 bg-slate-950 p-1">
                    <p className="text-sm font-semibold">Uploaded manual reference</p>
                    <p className={`mt-1 text-xs ${trustedManualKnowledge ? "text-emerald-400" : "text-slate-500"}`}>{trustedManualKnowledge ? "Approved document uploaded to this equipment" : "Equipment reference uploaded — verification pending"}</p>
                    {(manualKnowledge.manufacturer || manualKnowledge.equipment) && (
                      <p className="text-xs leading-tight text-slate-400">{[manualKnowledge.manufacturer, manualKnowledge.equipment].filter(Boolean).join(" · ")}</p>
                    )}
                    {selectedAsset?.documentation_key && (
                      <p className="mt-1 break-all text-[11px] text-slate-500">Documentation key: {selectedAsset.documentation_key}</p>
                    )}
                    <p className="text-[11px] leading-3 text-slate-400">Instructions are read directly from the approved document linked above.</p>
                  </div>
                )}

                {selectedAsset && trustedManualKnowledge && !sourcePassages.length && !manualSteps.length && !relevantErrorCodes.length && <p className="mt-1 text-sm text-slate-400">The uploaded manual has no instructions matching this report. You can open the document linked above to read it.</p>}

                {reportedCode && !matchingErrorCode && (
                  <p className="mt-1 text-sm text-slate-400">
                    Reported code {reportedCode} has no exact matching entry in verified documentation for the selected asset.
                  </p>
                )}

                {relevantErrorCodes.length > 0 && (
                  <div className="mt-1 space-y-0">
                    <div>
                      <h3 className="text-sm font-semibold text-red-300">Fault / Diagnostic Code Reference</h3>
                      <p className="text-xs leading-tight text-slate-500">
                        {reportedCode
                          ? "The reported code is listed first when the manual contains it."
                          : "Potentially relevant manual codes are references only; verify the actual displayed equipment code before applying a code-specific action."}
                      </p>
                    </div>
                    {relevantErrorCodes.map((item) => {
                      const exact = !!reportedCode && normalizeDiagnosticCode(item.code) === reportedCode;
                      return (
                        <div key={`${item.code}-${item.problem}`} className={`rounded-xl border p-1 ${exact ? "border-red-400/50 bg-red-950/25" : "border-slate-700 bg-slate-950"}`}>
                          <div className="flex flex-wrap items-center gap-0.5">
                            <p className="font-semibold text-red-300">Code {item.code}</p>
                            {exact && <span className="rounded-full border border-red-400/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-200">Reported code</span>}
                          </div>
                          <p className="mt-0.5 text-sm font-medium text-slate-100">{item.problem}</p>
                          <p className="mt-0.5 text-sm text-slate-300"><span className="font-semibold text-slate-200">Solution / Action:</span> {item.action}</p>

                        </div>
                      );
                    })}
                  </div>
                )}

                {sourcePassages.length > 0 && (
                  <section className="mt-1 space-y-0">
                    <h3 className="text-sm font-semibold text-sky-300">PDF troubleshooting and diagnostic pages</h3>
                    <p className="text-xs text-slate-400">Verbatim reference text from the document linked above. These excerpts do not assert that an action has been performed.</p>
                    {sourcePassages.map((passage, index) => (
                      <details key={`${passage.source_file_name}-${passage.page}-${index}`} className="rounded-lg border border-slate-700 p-0.5">
                        <summary className="cursor-pointer text-sm">{passage.kind === "diagnostic" ? "Diagnostic reference" : "Troubleshooting reference"}</summary>
                        <pre className="mt-0.5 whitespace-pre-wrap font-sans text-sm leading-tight text-slate-300">{passage.text}</pre>
                      </details>
                    ))}
                  </section>
                )}
                {displayedSteps.length > 0 && (
                  <div className="mt-1">
                    <h3 className="text-sm font-semibold text-amber-300">General issue-based checks</h3>
                    <ol className="mt-1 space-y-0 text-sm text-slate-300">
                      {displayedSteps.map((step, index) => {
                        return (
                          <li key={`${step}-${index}`} className="rounded-lg border border-slate-800 bg-slate-950/60 p-0.5">
                            <div className="flex gap-0.5">
                              <span className="font-semibold text-amber-400">{index + 1}.</span>
                              <span className="flex-1">{step}</span>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                )}

                {trustedManualKnowledge && manualSteps.length === 0 && !manualKnowledge?.source_passages?.length && displayedSteps.length === 0 && relevantErrorCodes.length === 0 && !manualLoading && (
                  <p className="text-sm text-slate-400">
                    No instructions match this description yet. Describe what you see or hear in the reported issue.
                  </p>
                )}
              </div>
            </details>

            {["Completed", "Closed", "Will Not Do"].includes(status) && (
              <details className="rounded-2xl border border-slate-800 bg-slate-900 p-2">
                <summary className="cursor-pointer text-sm font-semibold">Closure Details{pendingField("actionRootCause")}</summary>
                <p className="mt-1 text-xs text-slate-500">
                  Record the final action and root cause only when closing the ticket.
                </p>
                {editingField === "action_root_cause" ? <textarea autoFocus onBlur={() => setEditingField(null)} aria-label="action root cause"
                  value={actionRootCause}
                  onChange={(event) => setActionRootCause(event.target.value)}
                  disabled={!canEditField("action_root_cause") || saving}
                  rows={3}
                  placeholder="Repair performed, root cause, or reason not completed..."
                  className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 p-2 text-sm text-white outline-none placeholder:text-slate-600 focus:border-amber-400"
                /> : <button type="button" disabled={!canEditField("action_root_cause") || saving} onClick={() => setEditingField("action_root_cause")} aria-label="Edit action root cause" className="cmpri-ticket-field block min-h-8 w-full whitespace-pre-wrap text-left text-sm">{actionRootCause || "None"}</button>}
              </details>
            )}

          </div>

          <aside className="min-w-0 space-y-2">
            {(externalActivity.purchases?.length || externalActivity.enseo?.length || externalActivity.warranties?.length || externalActivity.followups?.length) ? (
              <section className="rounded-2xl border border-orange-500/30 bg-slate-900 p-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-orange-300">Linked External Activity</p>
                    <h2 className="mt-1 text-sm font-semibold">Parts, Shipments & Service Tickets</h2>
                  </div>
                  <Link href="/engineering/purchasing" onClick={event => {
                    if (embedded && window.parent !== window || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault(); requestTicketNavigation("/engineering/purchasing");
                  }} className="text-xs font-semibold text-amber-300 hover:underline">View all</Link>
                </div>

                {!!externalActivity.purchases?.length && (
                  <div className="mt-2 space-y-2">
                    {externalActivity.purchases.map((purchase) => (
                      <div key={purchase.id} className="rounded-xl border border-slate-800 bg-slate-950 p-2">
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
                  <div className="mt-2 border-t border-slate-800 pt-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-sky-300">Enseo</p>
                    {externalActivity.enseo.map((ticket) => <p key={ticket.id} className="mt-1 text-sm text-slate-300">{ticket.ticket_number ? `Ticket ${ticket.ticket_number}` : "Enseo ticket"}{ticket.enseo_endpoint ? ` · ${ticket.enseo_endpoint}` : ticket.room_number ? ` · Room ${ticket.room_number}` : ""} · {ticket.status || "Updated"}</p>)}
                  </div>
                )}

                {!!externalActivity.warranties?.length && (
                  <div className="mt-2 border-t border-slate-800 pt-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-purple-300">Warranty / RMA</p>
                    {externalActivity.warranties.map((item) => <p key={item.id} className="mt-1 text-sm text-slate-300">{item.rma_number ? `RMA ${item.rma_number}` : item.warranty_case_number ? `Case ${item.warranty_case_number}` : "Warranty case"} · {item.status || "Open"}</p>)}
                  </div>
                )}

                {!!externalActivity.followups?.length && (
                  <div className="mt-2 border-t border-slate-800 pt-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-amber-300">Supplier Follow-up</p>
                    {externalActivity.followups.map((item) => <p key={item.id} className="mt-1 text-sm text-slate-300">{item.status || "Vendor Contacted — Awaiting Response"}</p>)}
                  </div>
                )}
              </section>
            ) : null}

            <section>
            <details id="cmpri-labor-parts" className="rounded-2xl border border-slate-800 bg-slate-900 p-1">
              <summary className="list-item cursor-pointer">
                <span id="cmpri-parts-status" className="float-right ml-1" />
                <h2 className="w-fit text-base font-bold leading-tight tracking-tight text-amber-400">Labor & Parts</h2>
              </summary>
              {order?.id && cmpriSession?.capabilities.includes("manage_assets") && <WorkOrderSupplies key={`${cmpriSession.hotelId}:${cmpriSession.user.id}:${order.id}`} jobId={order.id} cacheScope={`${cmpriSession.hotelId}:${cmpriSession.user.id}`} issue={issue} notes={notes} disabled={saving || hasUnsavedChanges} onRecorded={() => loadTicket(false, false, true)} registerExitGuard={registerPartExitGuard}/> }

              {order.parts?.trim() && <p className="mt-1 text-xs text-slate-400">Previously recorded parts: {order.parts}</p>}

              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Hours{pendingField("hours")}
                  </span>
                  {editingField === "hours" ? <input autoFocus onBlur={() => setEditingField(null)} aria-label="hours"
                    type="number"
                    step="0.25"
                    min="0"
                    value={hours}
                    onChange={(event) => setHours(event.target.value)}
                    disabled={!canEditField("hours") || saving}
                    className="mt-1 min-h-8 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm outline-none focus:border-amber-400"
                  /> : <button type="button" disabled={!canEditField("hours") || saving} onClick={() => setEditingField("hours")} aria-label="Edit hours" className="cmpri-ticket-field block min-h-8 w-full whitespace-pre-wrap text-left text-sm">{hours || "None"}</button>}
                </label>

                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Cost{pendingField("cost")}
                  </span>
                  {editingField === "cost" ? <input autoFocus onBlur={() => setEditingField(null)} aria-label="cost"
                    type="number"
                    step="0.01"
                    min="0"
                    value={cost}
                    onChange={(event) => setCost(event.target.value)}
                    disabled={!canEditField("cost") || saving}
                    className="mt-1 min-h-8 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm outline-none focus:border-amber-400"
                  /> : <button type="button" disabled={!canEditField("cost") || saving} onClick={() => setEditingField("cost")} aria-label="Edit cost" className="cmpri-ticket-field block min-h-8 w-full whitespace-pre-wrap text-left text-sm">{cost || "None"}</button>}
                </label>
              </div>
            </details>
            </section>

          </aside>
        </div>

        {cmpriSession?.capabilities.includes("view_dashboard") && (roomOperationalContext.loading || roomOperationalContext.ranker || order?.room) && (
          <section className="mt-2 grid gap-1.5 rounded-xl border border-cyan-500/30 bg-slate-900 p-1.5">
            {roomOperationalContext.loading ? <p className="text-sm text-slate-400">Loading live room context…</p> : <>
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-1.5">
                <b className="text-sm">PM checks and quarterly room forms</b>
                {roomOperationalContext.pm?.error
                  ? <p className="mt-1 text-xs text-red-300">{roomOperationalContext.pm.error}</p>
                  : <p className="mt-1 text-xs leading-tight text-slate-400">PM work is entered through the live PM workspace. Technician changes remain pending until a System Administrator confirms them; work orders no longer write directly to the corporate workbook.</p>}
                <Link href="/engineering/preventive-maintenance" onClick={event => {
                  if (embedded && window.parent !== window || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault(); requestTicketNavigation("/engineering/preventive-maintenance");
                }} className="mt-1 inline-flex rounded-lg border border-cyan-500/40 bg-cyan-950/30 px-2 py-0.5 text-[11px] font-bold text-cyan-100 hover:bg-cyan-900/40">Open Preventive Maintenance</Link>
              </div>
            </>}
          </section>
        )}

      </div>

      {showCancelConfirm && (
        <div className="cmpri-modal-backdrop fixed inset-0 z-[70] flex items-center justify-center bg-black/80" onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          if (exitFlushing) return;
          pendingExitAction.current = null;
          setShowCancelConfirm(false);
        }}>
          <div role="dialog" aria-modal="true" className="cmpri-modal-shell border border-slate-700 bg-slate-900 shadow-2xl">
            <h2 className="text-xl font-bold">Leave this ticket view?</h2>
            <p className="mt-2 text-sm text-slate-400">Your changes have not been saved to the work order. You can keep a draft on this device if browser storage is available. Leaving this view does not change the ticket status.</p>
            {localDraftFailed && <p role="alert" className="mt-2 text-sm text-amber-300">The draft could not be saved on this device. Keep editing, save the work order, or download a copy before leaving.</p>}
            {hasPendingNoteMedia && <p role="alert" className="mt-2 text-sm text-amber-300">Selected attachments are not saved in a device draft. Submit or remove them before closing and keeping your text.</p>}
            {exitError && <p role="alert" className="mt-2 text-sm text-amber-300">{exitError}</p>}
            {exitFlushing && <p role="status" className="mt-2 text-sm text-sky-200">Saving checklist activity before leaving…</p>}
            <div className="mt-6 flex justify-end gap-3">
              <button type="button" disabled={saving || exitFlushing} onClick={discardLocalDraftAndClose} className="min-h-10 rounded-lg border border-red-500 px-3 text-sm text-red-200">Discard draft and close</button>
              <button type="button" onClick={exportUnsavedDraft} className="min-h-10 rounded-lg border border-sky-600 px-3 text-sm text-sky-200">Download draft copy</button>
              <button
                type="button"
                autoFocus
                disabled={exitFlushing}
                onClick={() => { pendingExitAction.current = null; setShowCancelConfirm(false); }}
                className="rounded-lg border border-slate-600 px-5 py-3 text-sm font-semibold text-slate-200 hover:bg-slate-800"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={closeAndKeepDraft}
                disabled={saving || exitFlushing || hasPendingNoteMedia}
                className="rounded-lg bg-red-600 px-5 py-3 text-sm font-bold text-white hover:bg-red-500"
              >
                Close and keep draft
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddAsset && order && (
        <div className="cmpri-modal-backdrop fixed inset-0 z-[120] flex items-center justify-center bg-black/75" role="dialog" aria-modal="true" aria-label="Add New Asset" onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          setShowAddAsset(false);
        }}>
          <div className="cmpri-modal-shell border border-slate-700 bg-slate-950 shadow-2xl">
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


    </main>
  );
}
