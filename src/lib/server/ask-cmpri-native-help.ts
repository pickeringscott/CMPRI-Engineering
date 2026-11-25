import "server-only";
import { NextRequest, NextResponse } from "next/server";
import guideLessons from "@/components/beginners-guide/guide-lessons.json";
import { ASK_CMPRI_GUIDE } from "@/components/beginners-guide/ask-cmpri-guide";
import { LOYALTY_TIERS } from "@/lib/loyalty-tier";
import { PM_TEMPLATES, PM_ROOM_NUMBERS, PM_WORKBOOK_SOURCE } from "@/lib/pm/catalog";
import { WINTER_TASKS, WINTER_YEAR } from "@/lib/winter-preparedness";
import { requireUser } from "@/lib/server/auth";
import { ROOM_OPERATIONS_IMPORT_CONTRACT } from "@/lib/server/room-operations-import-schema";
import { CMPRI_DOCUMENTATION_INTEGRITY_RULES, CMPRI_NATIVE_WORKFLOW_GUIDANCE, CMPRI_NATIVE_POOL_LOG_GUIDANCE, CMPRI_WRITE_ACTION_GUIDANCE, ROOM_OPERATIONS_REPORTING_INSTRUCTIONS } from "@/lib/ai/cmpri-operation-guidance";

/** Static, source-owned application help. No example is a property record. */
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Authorization" };
const SECTIONS = ["guide", "pm", "winter", "room-import", "room-ranker", "notes", "manuals", "weather", "airport", "rules", "all"] as const;
type Section = (typeof SECTIONS)[number];

function guide(query: string) {
  const roles = Object.entries(guideLessons.roles);
  const index = roles.map(([role, content]) => ({
    role, title: content.title, responsibility: content.responsibility,
    lessons: content.lessons.map(lesson => ({ key: lesson.key, title: lesson.title, purpose: lesson.purpose })),
  }));
  if (!query) return {
    source: "CMPRI Beginner's Guide", kind: "guide-index", roles: index,
    askCmpri: { key: ASK_CMPRI_GUIDE.key, title: ASK_CMPRI_GUIDE.title },
    instruction: "Use q with a feature name, lesson key or free-text search terms to read the full matching guide lessons. q=* reads all lessons. These are instructions and illustrated examples, not live property records.",
  };
  const terms = query.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
  const matches = (value: unknown) => query === "*" || terms.some(term => JSON.stringify(value).toLocaleLowerCase().includes(term));
  // Keep role-specific instructions intact; they describe existing app policy
  // rather than adding a separate permission model to Ask.
  return {
    source: "CMPRI Beginner's Guide", kind: "guide-lessons", query,
    roles: roles.flatMap(([role, content]) => {
      const lessons = content.lessons.filter(matches);
      return lessons.length ? [{ role, title: content.title, responsibility: content.responsibility, lessons }] : [];
    }),
    askCmpri: matches(ASK_CMPRI_GUIDE) ? ASK_CMPRI_GUIDE : undefined,
    instruction: "Guide examples and screenshots are training material, not live work orders, guests, dates or completion evidence. Native operations supply current records and enforce each signed-in account's permissions.",
  };
}

const notes = {
  source: "CMPRI Notepad document validator",
  screen: "/notepad",
  read: "notepad.read returns only notes visible to the current authenticated property account, including legacy personal Notes and Staff Notes. Use the same returned notes for all Notepad questions and edits. Names and roles come from this active property directory; only active, taggable people may be @mentioned.",
  save: {
    operation: "notepad.save", patch: "notepad.patch preserves every omitted document field on the server",
    id: "UUID for this note", changeId: "UUID; reuse only for an identical retry",
    expectedRevision: "null for new notes; the loaded nonnegative integer revision for existing notes (legacy notes start at 0)",
    expectedLegacyVersion: "For revision0, include the exact legacyVersion from the loaded note; otherwise omit. This prevents replacing changes from an older Notes or Staff Notes client during first import.",
    document: {
      title: "String, at most 120 characters; only the creator can rename an existing note",
      audience: "Required {all:boolean,roles:string[],people:UUID[]}. New notes default to Just me: all:false and both arrays empty. All Roles is all:true. Engineering selects engineer and technician. Use returned role/person IDs, and change recipients only when requested; @mentioning someone alone never changes sharing.",
      content: "HTML string, at most 1000000 characters. Native save allows safe paragraphs, headings, spans, formatting, lists and checkboxes. Preserve existing data-item-id identities on unchanged lines. Font and color are safe inline styles. A checklist item is <div class=note-check data-item-id=ID><input type=checkbox checked><span class=task-label>Text</span></div>; omit checked for an unfinished item. data-completed-by and data-completed-at are stamped by the server. @mentions use span class=mention data-mention-kind=person|role data-mention-id=returnedID with visible @name text.",
      priority: "Low | Normal | High | Urgent; the UI labels Urgent as Urgent! and shows a red exclamation before the title",
      fontSize: "Number from 6 to 96",
      fontFamily: "Text font name, at most 120 characters; fallback Comic Sans MS",
      titleFontFamily: "Title font name, at most 120 characters; only the creator can change it on an existing note",
      ink: "Required array, at most 5000 strokes. Preserve existing S Pen handwriting and drawing layers when editing text; [] for new text-only notes.",
      itemThreads: "Required map from existing data-item-id to reply arrays. Reply is {id,authorId,at,text,replies:[]}; text at most4000 characters. Native save stamps new author/time and protects other authors' reply text. Removing an item removes its full nested thread.",
      attachments: "Required array of {id,kind:file|gif,name,type?,size?,gifId?}. Files use actual finalized native upload UUID/type/size; GIFs use a verified GIPHY ID. Preserve existing registered attachments. Signed URLs are read-only and omitted on save.",
    },
    delete: "Use document:null and the loaded expectedRevision; native ownership permission is authoritative.",
    bodyLimit: "2 MiB; only id, expectedRevision, changeId and document are accepted at the top level.",
  },
  stroke: { id: "nonempty unique string", color: "safe color", size: "number 1..24", points: "At most 100000 {x:0..800,y:0..1100,p:0..1} finite numeric points" },
  instruction: "Read an existing complete note before changing it. Preserve content, drawing, mentions, replies, recipients, attachments and formatting not involved in the requested change. Notepad replaces the former Staff Notes tab inside Ask CMPRI and the standalone Notes page; old links open this same feature.",
};

const roomRanker = {
  source: "CMPRI active ticket Room Ranker",
  operation: "room_ranker.read",
  response: "rooms:[{id,number,floor,rank,issues:[{id,location_id,room,issue,priority,ranker_base_priority,status}]}],refreshedAt",
  screen: "/engineering/room-ranking",
  rankRules: {
    originalPriority: "Use ranker_base_priority when present, otherwise priority. Count original Low and Medium separately.",
    C: "Any original High/Urgent issue, four or more original Low issues, or three or more original Medium issues.",
    B: "If not C: any original Medium issue or three or more original Low issues.",
    A: "All remaining active guest rooms, including rooms with no active issue.",
    excluded: ["Completed", "Closed", "Will Not Do"],
    automaticEscalation: "Three original Low issues escalate displayed priority to Medium; four or more original Low or three or more original Medium escalate to Urgent. Rank still uses the preserved original priorities, so escalation does not feed itself.",
  },
  queries: "Read the complete snapshot, then filter rooms by rank A/B/C, number or floor, group/count/sort before limiting displayed rows. number is the guest-room label; id is the native location identity. Read issues for the actual reason a room has its rank. A room number appearing in a general-location ticket does not make that ticket a guest-room issue.",
  actions: "Rank is derived from native work orders. Read the actual issue before proposing a requested status/priority/issue change through native work-order operations; reread the ranker afterward. There is no independent rank setter. Source links use /engineering/room-ranking?room=ID and /work-orders/ISSUE_ID.",
  controls: "The Room Ranker screen has A/B/C/All filters, floor expansion, and additional issue dialogs. These are browser presentation controls; Ask can return the same filtered data and exact room/issue links without claiming it changed a browser's local floor settings.",
};

const weather = {
  source: "CMPRI Weather native source selectors",
  coverage: "Weather modal: current conditions, forecasts, alerts, history, radar/maps, astronomy and the Airport view.",
  access: "Every Ask CMPRI Weather lookup verifies the current signed-in account and uses the same Weather role admission as the dashboard. Public-source availability does not grant an otherwise excluded CMPRI role access through Ask.",
  screen: "/previews/cmpri-weather-preview.html",
  conditions: { operation: "weather.read", query: { part: ["observation", "history", "alerts", "forecast", "dashboard"] }, default: "With part omitted, the route returns its complete fixed-location weather bundle." },
  map: {
    operation: "weather.map",
    sources: {
      winterImpacts: "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/wpc_wssi/MapServer/4",
      radarCatalog: "https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer",
    },
    metadata: "Set the operation's url query to the exact source root followed by ?f=json. Read actual fields, renderer and advertised times before the source's /query request.",
    hotelWinterImpactQuery: {
      pathSuffix: "/query",
      query: { f: "json", where: "1=1", geometry: "-88.251416,40.138080", geometryType: "esriGeometryPoint", inSR: "4326", outSR: "4326", spatialRel: "esriSpatialRelIntersects", outFields: "impact,issue_time,start_time,end_time,idp_filedate", returnGeometry: "true", resultRecordCount: "1000" },
    },
    regionalWinterImpactQuery: "For regional polygons use an actual requested extent as geometry JSON {xmin,ymin,xmax,ymax,spatialReference:{wkid:3857}}, geometryType:esriGeometryEnvelope,inSR:3857,outSR:4326,spatialRel:esriSpatialRelIntersects with the same verified impact/time fields. This is the native Weather map request shape. A transfer limit requires pagination using resultOffset or a narrower extent before a complete count can be claimed.",
    instruction: "WSSI layer 4 is the overall Days 1–3 forecast, not an observed road report. Keep each feature's issue/start/end time and stale/expired status. A provider error/unavailable response is not usable forecast evidence. No returned polygons alone does not prove roads are safe. Reported winter-road conditions remain unavailable because the native IDOT feed is unverified.",
  },
  wms: {
    operation: "weather.wms", products: ["reflectivity", "velocity", "precipitation", "cloudCover"],
    operations: ["capabilities", "map", "legend"],
    instruction: "Read capabilities first with product and op=capabilities only. Use the returned layer, style and time values. Map also needs a Web Mercator bbox, width and height (1..1500). Optional format is image or json; capabilities accepts no format. NDFD cloudCover requires an exact advertised forecast valid time and the native verified sky layer; no cloud-cover PNG legend is available.",
  },
  basemap: { operation: "weather.basemap", datasets: ["topo", "imagery", "relief", "roads", "places"], instruction: "Use the native fixed USGS datasets and advertised metadata; imagery is reference aerial photography with varying acquisition dates, not live weather." },
  astronomy: { operation: "weather.astronomy", instruction: "Uses the native hotel location. Keep source timestamps, forecast uncertainty and visibility limitations with sun, moon, eclipse and aurora answers." },
  airport: { operations: ["willard.flights", "willard.tracker", "willard.layout"], help: "Read app.help section=airport for the current flight board, nearby aircraft and airport reference geometry. They are separate sources." },
  controls: "Open the Weather screen for map layers, radar playback, pan/zoom, fullscreen and weather/airport tabs. These are local browser controls, not saved CMPRI mutations. Ask can read the same native sources, filter their records and retrieve native images; it must not claim a local map control changed without an actual UI action.",
  instruction: "Observed conditions, forecast, history and map imagery are distinct sources. Preserve source update/retrieval times and explicit unavailable states. Never infer a precise quantity from image brightness alone.",
};

const airport = {
  source: "CMPRI Willard Airport native sources",
  screen: "/previews/cmpri-weather-preview.html",
  airport: "CMI / KCMI", timeZone: "America/Chicago",
  flights: {
    operation: "willard.flights", rows: ["boards.arrivals.flights", "boards.departures.flights"],
    fields: ["id", "flight", "airline", "location", "iata", "date", "time", "status"],
    instruction: "Read current published arrivals/departures from the actual board. Preserve each board's status,sourceUrl,retrievedAt,providerDate,explicitEmpty,error. Unknown/unavailable flights are null, not an empty board. Codeshares remain separate published rows. Current data does not supply arbitrary future/historical dates or separate scheduled/estimated/actual movement times; do not calculate a delay from missing evidence. Beginner's Guide flight examples are training data only.",
  },
  tracker: {
    operation: "willard.tracker", rows: "aircraft", radiusNm: 50,
    fields: ["hex", "callsign", "registration", "type", "lat", "lon", "altitudeFeet", "speedKnots", "track", "seenSeconds", "positionAgeSeconds"],
    instruction: "ADSB.lol provides observed nearby positions around the native KCMI center. Preserve live/stale/unavailable status,observedAt,retrievedAt,retryAt,invalidAircraftCount,source and license/attribution. null measurements are unknown; altitudeFeet may be 'ground'. Position age is distinct from message/retrieval age. Nearby aircraft cannot be labeled Willard arrivals/departures from position alone, and receiver coverage can be incomplete.",
  },
  layout: {
    operation: "willard.layout", rows: "collection.features", layerMetadata: "layers",
    instruction: "Use source-verified KCMI runway/taxiway/apron GeoJSON and corresponding source metadata. Overall status available/partial/stale/unavailable differs from per-layer status. Retain source checks,featureCount,invalidFeatureCount,effectivePeriod,sourceDataEditedAt and referenceOnly:true. FAA reference status is not current NOTAM or operating clearance. Missing geometry stays unavailable; aircraft position comes from tracker, not layout.",
  },
  actions: "These are native read-only sources. Use the Weather screen's Airport view for the interactive board/map; no native endpoint changes flights, aircraft or airport operating status.",
};

const manuals = {
  source: "CMPRI stored manual review and applicability validators",
  integrityRules: CMPRI_DOCUMENTATION_INTEGRITY_RULES,
  reviewedFields: {
    title: "Required nonblank string <=500", manufacturer: "Required string <=200", models: "Required explicit array of at most 100 model strings, each <=200",
    selected_model: "Required string <=200; empty or a member of models", applicability: ["reference", "confirmed_model"],
    notes: "Required string <=4000", reason: "Required string 5..2000",
    extracted_fields: "Optional object with string values <=300 for asset_type, model_family, serial_number, generation and install_year only",
    preferred: "Optional boolean", quarantine_acknowledged: "Optional boolean; explicit acknowledgment is required for a catalog mismatch warning",
    applicability_review: { asset_id: "Actual selected physical asset UUID", confirmed: true, manufacturer: "Loaded identity", model_number: "Loaded identity", model_family: "Loaded identity", serial_number: "Loaded identity" },
    serial_range: "Optional null or {kind:'numeric',from:string,to:string}; from/to must contain 1..32 digits and be ascending. Do not invent a range absent from the reviewed source.",
  },
  instruction: "The native stored-PDF inspection returns the original file identity, checksum, asset identity, suggestions and updated_at. Review the actual source before claiming confirmed_model or review_confirmed. Native save serializes reviewedFields as the multipart fields value. Applicability review records the selected physical asset; a changed model or serial identity remains a visible warning. File hashes and storage identities must come from actual native files.",
};

/** Called only through the code-owned native dispatcher, with original auth. */
export async function readAskNativeHelp(request: NextRequest): Promise<Response> {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: "Sign in is required." }, { status: 401, headers: HEADERS });
  const section = request.nextUrl.searchParams.get("section") || "guide";
  if (!SECTIONS.includes(section as Section)) return NextResponse.json({ error: "Choose an available help section.", sections: SECTIONS }, { status: 400, headers: HEADERS });
  const query = request.nextUrl.searchParams.get("q")?.trim() || "";
  const result: Record<string, unknown> = { source: "CMPRI application instructions", sections: SECTIONS };
  if (section === "guide" || section === "all") result.guide = guide(query);
  if (section === "pm" || section === "all") result.pm = {
    source: PM_WORKBOOK_SOURCE, templates: PM_TEMPLATES.filter(template => !query || query === "*" || JSON.stringify(template).toLocaleLowerCase().includes(query.toLocaleLowerCase())),
    roomNumbers: PM_ROOM_NUMBERS,
    instruction: "These are CMPRI's actual PM template definitions, field IDs, checklists, cadence, eligible months and source references. They are not saved completion records. Read preventive_maintenance.read for actual entries, revision, review status and the selected week's work.",
  };
  if (section === "winter" || section === "all") result.winter = { year: WINTER_YEAR, tasks: WINTER_TASKS, instruction: "Read winter.read for actual saved completion states and revisions. These are the native checklist definitions only." };
  if (section === "room-import" || section === "all") result.roomImport = {
    ...ROOM_OPERATIONS_IMPORT_CONTRACT,
    workflowRules: CMPRI_WRITE_ACTION_GUIDANCE["room_operations.import"],
    reportingRules: ROOM_OPERATIONS_REPORTING_INSTRUCTIONS,
    nativeTransport: "The full shared import contract above retains external wrapper syntax. Native room_operations.import accepts source:paste|file, validate_only and one report_data or original-CSV mode. Native Drive files are obtained by room_operations.drive_reports and validated/saved with room_operations.guest_reports_import; room_operations.drive_import is the native one-click action only on an explicitly requested import. A source:drive input requires the existing preview/commit adapter, not direct POST to room_operations. Preserve full validation, same-evidence confirmation and readback/reporting rules for every transport.",
    loyalty: {
      tiersInAscendingOrder: LOYALTY_TIERS,
      instruction: "Use the authorized room_operations.read snapshot for actual current and incoming guests. Keep the current stay and incoming/block stay separate. A blank or unrecognized membership value is unknown, not Base. Bonvoy/Marriott Bonvoy prefixes and Elite suffixes normalize to the named tier; member/base member normalize to Base. Filter, compare, count and sort the actual guest rows using these levels, with unknown handled separately. Do not infer guest tier from room type or guest name.",
    },
  };
  if (section === "notes" || section === "all") result.notes = notes;
  if (section === "room-ranker" || section === "all") result.roomRanker = roomRanker;
  if (section === "manuals" || section === "all") result.manuals = manuals;
  if (section === "weather" || section === "all") result.weather = weather;
  if (section === "airport" || section === "all") result.airport = airport;
  if (section === "rules" || section === "all") result.rules = {
    policy: CMPRI_NATIVE_WORKFLOW_GUIDANCE.native_policy,
    writeWorkflows: { ...CMPRI_WRITE_ACTION_GUIDANCE, "pool_log.save": CMPRI_NATIVE_POOL_LOG_GUIDANCE },
    nativeWorkflows: CMPRI_NATIVE_WORKFLOW_GUIDANCE,
    roomOperationsReporting: ROOM_OPERATIONS_REPORTING_INSTRUCTIONS,
    documentationIntegrity: CMPRI_DOCUMENTATION_INTEGRITY_RULES,
  };
  return NextResponse.json(result, { headers: HEADERS });
}
