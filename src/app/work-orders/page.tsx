"use client";
import WorkOrderMediaControl from "@/components/WorkOrderMediaControl";
import { subscribeResources } from "@/lib/events/browser";
import PoolStatus from "@/components/desktop/PoolStatus";

import { formatWorkOrder } from "@/lib/work-order-reference.js";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { queuedAssetRefresh, isAssetListRefresh } from "@/lib/asset-list-refresh.js";
import { cmpriLocationSection } from "@/lib/cmpri-location-groups";
import { creationAssetsForLocation } from "@/lib/work-orders/assignable-assets";
import ModalNavigationButton from "@/components/ModalNavigationButton";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { getValidSession } from "@/lib/supabase/client";
import { loadCmpriSession, type CmpriClientSession } from "@/lib/auth/client-session";

import AccountSummary from "@/components/AccountSummary";

import SearchableSelect from "@/components/SearchableSelect";
import { classifyAsset } from "@/lib/asset-category";
import { priorityForCategory, inferWorkOrder, separateIssueFromReporterNotes } from "@/lib/work-order-suggestions";
import { equipmentOptionLabel } from "@/lib/equipment-selection";
import { troubleshootingStepAlreadyDone } from "@/lib/troubleshooting-completed-steps";
import { categoryOptions } from "@/lib/work-order-categories";
import { validFirstName } from "@/lib/work-order-attribution";
import { uploadWorkOrderAttachment } from "@/lib/work-order-attachment-upload";
import { likelyDuplicate } from "@/lib/work-order-duplicates";
import {
  cleanIssueLocationPrefix,
  createSuggestionFromIssueClause,
  detectMultipleCreateIssues,
  findLocationFromText,
  type RelatedIssueSuggestion,
  type WorkOrderLocation as Location,
} from "@/lib/work-order-creation";
import { normalizeManualKnowledge, type ManualKnowledge } from "@/lib/manual-knowledge";
import { roomStatusBadge } from "@/lib/room-availability";
import { keepCreateFormOpen } from "@/lib/work-order-create-presentation";
import { isSubmitOnlyRole } from "@/lib/server/roles";

type WorkOrderDraft = {
  id: string;
  created_by: string;
  creator_name?: string | null;
  creator_role?: string | null;
  creator_display_role?: string | null;
  can_edit?: boolean;
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
  binder_tag?: string | null;
  quantity?: number | null;
  active: boolean;
  status: string;
  manufacturer: string | null;
  model_number: string | null;
  serial_number: string | null;
  generation: string | null;
  install_year: number | null;
  documentation_key: string | null;
};

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
type CreatedWorkOrder = { id: string; display_id: string; status: string };
type SelectedWorkOrderPhoto = { file: File; previewUrl: string; uploadId: string };
type PendingPhotoUpload = Pick<CreatedWorkOrder, "id" | "display_id"> & { photo: SelectedWorkOrderPhoto };

function WorkOrderPhotoPreview({ photo, onRemove, removeLabel }: { photo: SelectedWorkOrderPhoto; onRemove?: () => void; removeLabel: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-slate-700 bg-slate-950/70 p-1.5">
      <div className="relative shrink-0">
        {photo.file.type.startsWith("video/")?<video src={photo.previewUrl} controls className="size-12 rounded object-cover"/>:<Image unoptimized src={photo.previewUrl} alt="" width={48} height={48} className="size-12 rounded object-cover"/>}
        {onRemove && <button type="button" onClick={onRemove} aria-label={`${removeLabel}: ${photo.file.name}`} title={removeLabel} className="absolute -left-1 -top-1 grid size-6 place-items-center rounded-full border border-red-500/70 bg-slate-950 text-base font-bold leading-none text-red-500 shadow hover:bg-slate-900 focus-visible:outline-2 focus-visible:outline-white">×</button>}
      </div>
      <span className="min-w-0 max-w-40 truncate text-xs text-slate-300" title={photo.file.name}>{photo.file.name}</span>
    </div>
  );
}

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

  return assets.filter((asset) => asset.location_id === location.id && asset.active !== false);
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

  const [photos, setPhotos] = useState<SelectedWorkOrderPhoto[]>([]);
  const [photoUploadError, setPhotoUploadError] = useState("");
  const [canReplacePhoto, setCanReplacePhoto] = useState(false);
  const [photoToReplaceUploadId, setPhotoToReplaceUploadId] = useState("");
  const [pendingPhotoUploads, setPendingPhotoUploads] = useState<PendingPhotoUpload[]>([]);
  const [retryingPhotoUpload, setRetryingPhotoUpload] = useState(false);
  const photoFileInputRef = useRef<HTMLInputElement>(null);
  const photoCameraInputRef = useRef<HTMLInputElement>(null);
  const photoPreviewUrlsRef = useRef(new Set<string>());

  useEffect(() => () => {
    photoPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    photoPreviewUrlsRef.current.clear();
  }, []);

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
  const [formLanguage, setFormLanguage] = useState<"en" | "es">("en");
  useEffect(() => {
    // Defer browser-only preferences until after the server markup is hydrated.
    const timer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem("cmpri:work-order-language");
        if (saved === "en" || saved === "es") setFormLanguage(saved);
      } catch {}
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const [staffFirstName, setStaffFirstName] = useState("");
  const [cmpriSession, setCmpriSession] = useState<CmpriClientSession | null>(null);
  const [drafts, setDrafts] = useState<WorkOrderDraft[]>([]);
  const [reviewDraft, setReviewDraft] = useState<WorkOrderDraft | null>(null);
  const draftRequestRef = useRef(0);
  const [activeDraftId, setActiveDraftId] = useState("");
  const [activeDraftRevision, setActiveDraftRevision] = useState<number | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const autoOpenedDraftRef = useRef("");



  const apiHeaders = useCallback(async (includeJson = false) => {
    const session = await getValidSession();
    if (!session?.access_token) throw new Error("Sign in again to continue.");
    return {
      ...(includeJson ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${session.access_token}`,
    };
  }, []);

  const loadDrafts = useCallback(async () => {
    const requestId = ++draftRequestRef.current;
    setDrafts([]);
    setReviewDraft(null);
    try {
      const session = await getValidSession();
      if (!session?.access_token) throw new Error("Sign in again to load drafts.");
      const params = new URLSearchParams(window.location.search);
      const reviewId = params.get("reviewDraft") === "1" ? params.get("draftId") : null;
      const response = await fetch(`/api/work-orders/drafts?scope=own${reviewId ? `&review_draft_id=${encodeURIComponent(reviewId)}` : ""}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      const current = await getValidSession();
      if (requestId !== draftRequestRef.current || current?.user.id !== session.user.id) return;
      if (!response.ok) throw new Error(payload.error || "Drafts could not be loaded.");
      setDrafts(((payload.drafts || []) as WorkOrderDraft[]).filter(draft => draft.created_by === session.user.id));
      if (reviewId && payload.review_draft?.id === reviewId && payload.review_draft.can_edit) setReviewDraft(payload.review_draft);
    } catch (error) {
      if (requestId === draftRequestRef.current) setMessage(error instanceof Error ? error.message : "Drafts could not be loaded.");
    }
  }, []);

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

  const referenceLifetime = useRef({ active: true });
  useEffect(() => {
    const lifetime = { active: true };
    referenceLifetime.current = lifetime;
    return () => { lifetime.active = false; };
  }, []);

  const loadLocations = useCallback(async () => {
    const lifetime = referenceLifetime.current;
    try {
      const response = await fetch("/api/rooms?mode=create", {
        headers: await apiHeaders(),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!lifetime.active) return;
      if (!response.ok || !Array.isArray(payload.locations)) {
        throw new Error(payload.error || "Locations could not be loaded.");
      }
      setLocations(payload.locations as Location[]);
    } catch (error) {
      if (!lifetime.active) return;
      setMessage(`Location error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (lifetime.active) setLoadingLocations(false);
    }
  }, [apiHeaders]);

  const [assetRefreshError, setAssetRefreshError] = useState("");
  const loadAssets = useMemo(() => queuedAssetRefresh(async () => {
    const lifetime = referenceLifetime.current;
    try {
      const response = await fetch("/api/assets?mode=create", {
        headers: await apiHeaders(),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!lifetime.active) return;
      if (!response.ok || !Array.isArray(payload.assets)) {
        throw new Error(payload.error || "Equipment could not be loaded.");
      }
      setAssets((payload.assets as Asset[]).filter((asset) => asset.active !== false));
      setAssetRefreshError("");
    } catch (error) {
      if (!lifetime.active) return;
      setAssetRefreshError(`Equipment list could not be refreshed: ${error instanceof Error ? error.message : String(error)}. Retry the list; do not add the asset again.`);
    } finally {
      if (lifetime.active) setLoadingAssets(false);
    }
  }), [apiHeaders]);

  useEffect(() => {
    const changed = (event: MessageEvent) => {
      if (isAssetListRefresh(event, window.location.origin, window.parent, modalToken)) void loadAssets();
    };
    window.addEventListener("message", changed);
    return () => window.removeEventListener("message", changed);
  }, [loadAssets, modalToken]);

  const loadWorkOrders = useCallback(async (canViewCandidates = false) => {
    const lifetime = referenceLifetime.current;
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
      if (!lifetime.active) return;
      if (!response.ok || !Array.isArray(payload.work_orders)) throw new Error(payload.error || "Existing work orders could not be checked.");
      setWorkOrders(payload.work_orders as WorkOrder[]);
    } catch (error) {
      if (!lifetime.active) return;
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
  }, [loadDrafts]);

  useEffect(() => {
    if (!cmpriSession) return;
    const stopRooms = subscribeResources(["rooms"], loadLocations);
    const stopAssets = subscribeResources(["reference"], async () => { await loadAssets(); });
    const stopOrders = subscribeResources(["orders"], async () => {
      await loadWorkOrders(cmpriSession.capabilities.includes("view_work_orders") || cmpriSession.capabilities.includes("add_work_order_notes"));
    });
    return () => { stopRooms(); stopAssets(); stopOrders(); };
  }, [cmpriSession, loadLocations, loadAssets, loadWorkOrders]);

  const selectedLocation =
    locations.find(
      (location) =>
        location.id === locationId
    );
  const selectedLocationStatus = roomStatusBadge(selectedLocation?.room_status);

  // Front Desk shares the existing common-area groups; guest-room inventory stays excluded.
  const availableAssets = creationAssetsForLocation(assets, selectedLocation?.id, assetId, locations);

  const normalizedCurrentRole = currentRole.toLowerCase().replace(/[_-]+/g, " ").trim();
  const currentRoleKey = normalizedCurrentRole.replace(/\s+/g, "");
  const canViewTroubleshootingGuide = [
    "engineer", "engineers", "engineering", "chiefengineer", "engineeringmanager", "regionalmaintenance", "regionalengineer",
    "technician", "maintenancetechnician",
  ].includes(currentRoleKey);
  const isFrontDeskUser = ["frontdesk", "frontdeskmanager", "assistantgm", "assistantgeneralmanager", "assistantmanager"].includes(currentRoleKey);
  const isSubmitOnlyUser = isSubmitOnlyRole(currentRole);
  const keepOpenAfterCreate = Boolean(cmpriSession && keepCreateFormOpen(cmpriSession.user, cmpriSession.capabilities.includes("submit")));
  const submittingRef = useRef(false);
  const submittedDisplayIdsRef = useRef<string[]>([]);
  const canSetEngineeringFields = Boolean(cmpriSession?.capabilities.includes("edit_tickets") || cmpriSession?.capabilities.includes("review_tickets"));
  const systemAssignedTechnicalFields = isSubmitOnlyUser || !canSetEngineeringFields;
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
    _newNotes: string,
    locationOverride?: Location
  ) {
    const issueText = separateIssueFromReporterNotes(newIssue).issue.trim();

    if (!issueText) {

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
          issueText,
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
      issueText,
      workingAssets,
    );
    const shouldAutoSelectAsset = !manualAsset || Boolean(locationOverride) || systemAssignedTechnicalFields;
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
      (!manualCategory || locationOverride || systemAssignedTechnicalFields)
    ) {
      setCategory(
        smartCategory
      );
    }

    if (
      smartCategory &&
      (!manualPriority || locationOverride || systemAssignedTechnicalFields)
    ) {
      setPriority(
        priorityForCategory(
          smartCategory
        )
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
    if (nextLocation && issue.trim()) applySmartSuggestions(issue, "", nextLocation);
  }



  function handleAssetChange(
    newAssetId: string
  ) {
    setManualAsset(true);
    setAssetId(newAssetId);

    if (!newAssetId) {
      const assetlessIssue = separateIssueFromReporterNotes(issue).issue;
      const assetlessSuggestion = inferWorkOrder(assetlessIssue, assetsForLocation(selectedLocation, assets));
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
    applySmartSuggestions(smartIssue, "", detectedLocation?.id !== locationId ? detectedLocation || undefined : undefined);
  }

  function handleNotesChange(
    newNotes: string
  ) {
    setNotes(newNotes);
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

  const restoreDraft = useCallback((draft: WorkOrderDraft) => {
    if (draft.created_by !== cmpriSession?.user.id && !draft.can_edit) return;
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
  }, [cmpriSession?.user.id]);

  useEffect(() => {
    if (!cmpriSession) return;
    const requestedDraftId = new URLSearchParams(window.location.search).get("draftId") || "";
    if (!requestedDraftId || requestedDraftId === autoOpenedDraftRef.current) return;
    const draft = drafts.find((item) => item.id === requestedDraftId) || (reviewDraft?.id === requestedDraftId ? reviewDraft : null);
    if (!draft) return;
    autoOpenedDraftRef.current = requestedDraftId;
    const timer = window.setTimeout(() => restoreDraft(draft), 0);
    return () => window.clearTimeout(timer);
  }, [activeDraftId, cmpriSession, drafts, reviewDraft, restoreDraft]);

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
        asset_id: systemAssignedTechnicalFields ? null : (asset?.id || null),
        asset_name: systemAssignedTechnicalFields ? "" : (asset?.name || ""),
        category: systemAssignedTechnicalFields ? "General" : category,
        priority: systemAssignedTechnicalFields ? "Medium" : priority,
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

  function resetWorkOrderForm(force = false) {
    if (pendingPhotoUploads.length > 0 && !force) {
      setMessage("Retry the pending photo upload before discarding this created work order.");
      return;
    }
    setActiveDraftId("");
    setReviewDraft(null);
    setActiveDraftRevision(null);
    setStaffFirstName("");
    setLocationId("");
    setAssetId("");
    setCategory("General");
    setIssue("");
    setPriority("Medium");
    setNotes("");
    photoPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    photoPreviewUrlsRef.current.clear();
    setPhotos([]);
    setPhotoUploadError("");
    setCanReplacePhoto(false);
    setPhotoToReplaceUploadId("");
    setPendingPhotoUploads([]);
    setRetryingPhotoUpload(false);
    if (photoFileInputRef.current) photoFileInputRef.current.value = "";
    if (photoCameraInputRef.current) photoCameraInputRef.current.value = "";

    setManualLocation(false);
    setManualAsset(false);
    setManualCategory(false);
    setManualPriority(false);


    setMainWorkOrderCreated(false);
  }

  function removeSelectedPhoto(uploadId: string) {
    if (loading || createState !== "idle" || mainWorkOrderCreated || retryingPhotoUpload || pendingPhotoUploads.length > 0) return;
    const photo = photos.find((selected) => selected.uploadId === uploadId);
    if (!photo) return;
    URL.revokeObjectURL(photo.previewUrl);
    photoPreviewUrlsRef.current.delete(photo.previewUrl);
    setPhotos((current) => current.filter((selected) => selected.uploadId !== uploadId));
  }

  function acceptSelectedPhotos(files: FileList | File[] | null, fromCamera = false) {
    const selected = Array.from(files || []).slice(0, fromCamera ? 1 : undefined);
    if (!selected.length) return;

    if (photoToReplaceUploadId) {
      const previous = photos.find((photo) => photo.uploadId === photoToReplaceUploadId);
      if (previous) {
        URL.revokeObjectURL(previous.previewUrl);
        photoPreviewUrlsRef.current.delete(previous.previewUrl);
      }
      const replacement = { file: selected[0], previewUrl: URL.createObjectURL(selected[0]), uploadId: crypto.randomUUID() };
      photoPreviewUrlsRef.current.add(replacement.previewUrl);
      setPhotos((current) => current.map((photo) => photo.uploadId === photoToReplaceUploadId ? replacement : photo));
      setPendingPhotoUploads((current) => current.map((pending) => pending.photo.uploadId === photoToReplaceUploadId
        ? { ...pending, photo: replacement }
        : pending));
      setPhotoToReplaceUploadId("");
    } else {
      const newPhotos = selected.map((file) => {
        const previewUrl = URL.createObjectURL(file);
        photoPreviewUrlsRef.current.add(previewUrl);
        return { file, previewUrl, uploadId: crypto.randomUUID() };
      });
      setPhotos((current) => [
        ...current,
        ...newPhotos,
      ]);
    }

    setPhotoUploadError("");
    setCanReplacePhoto(false);
    if (photoFileInputRef.current) photoFileInputRef.current.value = "";
    if (photoCameraInputRef.current) photoCameraInputRef.current.value = "";
  }

  function afterSuccessfulCreate(callback: () => void, delay: number) {
    if (keepOpenAfterCreate) callback();
    else window.setTimeout(callback, delay);
  }

  function notifyCreateModal(type: "cmpri-work-order-cancelled" | "cmpri-work-order-created", displayId?: string) {
    if (type === "cmpri-work-order-created" && keepOpenAfterCreate) {
      resetWorkOrderForm(true);
      setCreateState("idle");
      const ids = displayId ? formatWorkOrder(displayId) : submittedDisplayIdsRef.current.join(", ");
      setMessage(tx(`Submitted successfully${ids ? `: ${ids}` : ""}. Ready for the next ticket.`, `Enviado correctamente${ids ? `: ${ids}` : ""}. Listo para la siguiente orden.`));
      return true;
    }
    if (!embedded || window.parent === window || !modalToken) return false;
    window.parent.postMessage(
      { type, modalKind: "create", ...(displayId ? { displayId } : {}), modalToken },
      window.location.origin,
    );
    return true;
  }

  function finishCancelCreateForm() {
    const leavingCreatedTicket = pendingPhotoUploads.length > 0;
    resetWorkOrderForm(leavingCreatedTicket);
    setBatchCreateSuggestions([]);
    setShowBatchCreateDialog(false);
    setShowRelatedWorkOrderDialog(false);
    setCreateState("idle");
    setMessage(leavingCreatedTicket ? tx("The work order and any saved photos were kept. Remaining photo uploads were cancelled.", "Se conservaron la orden y las fotos guardadas. Se cancelaron las cargas de fotos pendientes.") : "");
    setShowCancelConfirm(false);
    if (notifyCreateModal("cmpri-work-order-cancelled")) return;
    if (!isSubmitOnlyUser && cmpriSession?.landing === "/engineering") {
      router.push("/engineering");
    }
  }

  function requestCancelCreateForm() {
    if (loading || draftBusy || retryingPhotoUpload) return;
    if (createHasUnsavedChanges || activeDraftId || pendingPhotoUploads.length > 0) {
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
    if (loading || draftBusy || retryingPhotoUpload) return;
    if (activeDraftId && pendingPhotoUploads.length === 0) {
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

    const inferred = inferWorkOrder(suggestion.issue, possibleAssets);
    return possibleAssets.find((asset) => asset.id === inferred.assetId);
  }

  function resolveSuggestionLocation(suggestion: RelatedIssueSuggestion): Location | null {
    if (suggestion.locationId) {
      const matched = locations.find((item) => item.id === suggestion.locationId);
      if (matched) return matched;
    }
    return locations.find((item) => item.id === locationId) ?? null;
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
      if (pendingPhotoUploads.length > 0) {
        setMessage("The work order was created. Retry its pending photo upload before continuing.");
        return;
      }
      resetWorkOrderForm();
      notifyCreateModal("cmpri-work-order-created");
    }
  }

  async function createRelatedWorkOrders() {
    if (pendingPhotoUploads.length > 0) {
      setMessage("Retry the pending photo upload before creating related work orders.");
      return;
    }
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

    const displayIds = result.workOrders.filter((item) => item.display_id).map((item) => formatWorkOrder(item.display_id));
    setShowRelatedWorkOrderDialog(false);
    if (result.photoUploadPending) {
      setMessage("Related work orders were created, but their photo upload is pending. Retry the photo upload to finish.");
      setCreatingRelatedWorkOrders(false);
      setCreateState("created");
      return;
    }
    setMessage(isSubmitOnlyUser
      ? `${rows.length} related request${rows.length === 1 ? "" : "s"} submitted for Engineering verification${displayIds.length ? `: ${displayIds.join(", ")}` : "."}`
      : `${rows.length} related work order${rows.length === 1 ? "" : "s"} created${displayIds.length ? `: ${displayIds.join(", ")}` : "."}`);
    await loadWorkOrders(Boolean(cmpriSession?.capabilities.includes("view_work_orders") || cmpriSession?.capabilities.includes("add_work_order_notes")));
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
    const location = resolveSuggestionLocation(suggestion);
    if (!location) {
      setMessage("Select a room/location before creating this work order.");
      return;
    }

    const relatedAsset = resolveRelatedAsset(suggestion, location);
    const duplicate = possibleDuplicateFor(suggestion.issue, location, relatedAsset?.id ?? null);
    if (duplicate) {
      setMessage(`Possible duplicate detected: ${formatWorkOrder(duplicate.display_id, "existing work order")} — ${duplicate.issue || "similar active issue"}. Review the existing ticket before creating a new one.`);
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
    if (result.photoUploadPending) {
      setBatchCreateSuggestions(remaining);
      setShowBatchCreateDialog(false);
      setCreateState("created");
      setMessage("The work order was created, but its photo upload is pending. Retry the photo upload to finish.");
      return;
    }
    if (remaining.length === 0) {
      await clearSubmittedDraft();
      await loadWorkOrders(Boolean(cmpriSession?.capabilities.includes("view_work_orders") || cmpriSession?.capabilities.includes("add_work_order_notes")));
      setShowBatchCreateDialog(false);
      setBatchCreateSuggestions([]);
      setCreateState("created");
      setMessage(isSubmitOnlyUser
        ? "Request submitted for Engineering verification."
        : "Work order created.");
      afterSuccessfulCreate(() => {
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
      const rowLocation = resolveSuggestionLocation(suggestion) ?? location;
      const relatedAsset = resolveRelatedAsset(suggestion, rowLocation);
      return {
        location_id: rowLocation.id,
        asset_id: relatedAsset?.id ?? null,
        asset_name: relatedAsset?.name ?? suggestion.assetName,
        category: suggestion.category,
        issue: suggestion.issue,
        priority: suggestion.priority,
        notes: notes ? `Submitted together from one report. Original note: ${notes}` : "Submitted together from one report.",
      };
    });

    const firstDuplicate = rows.find((row) => {
      const duplicate = possibleDuplicateFor(String(row.issue || ""), locations.find((item) => item.id === row.location_id) ?? location, typeof row.asset_id === "string" ? row.asset_id : null);
      return Boolean(duplicate);
    });
    if (firstDuplicate) {
      const duplicate = possibleDuplicateFor(String(firstDuplicate.issue || ""), locations.find((item) => item.id === firstDuplicate.location_id) ?? location, typeof firstDuplicate.asset_id === "string" ? firstDuplicate.asset_id : null);
      setMessage(`Possible duplicate detected: ${formatWorkOrder(duplicate?.display_id, "existing work order")} — ${duplicate?.issue || "similar active issue"}. Review the existing ticket before creating a new one.`);
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
    await loadWorkOrders(Boolean(cmpriSession?.capabilities.includes("view_work_orders") || cmpriSession?.capabilities.includes("add_work_order_notes")));
    setCreatingBatchWorkOrders(false);
    setShowBatchCreateDialog(false);
    setCreateState("created");
    if (result.photoUploadPending) {
      setBatchCreateSuggestions([]);
      setMessage("Work orders were created, but their photo upload is pending. Retry the photo upload to finish.");
      return;
    }
    setMessage(isSubmitOnlyUser
      ? `${rows.length} requests submitted for Engineering verification.`
      : `${rows.length} work orders created.`);

    afterSuccessfulCreate(() => {
      resetWorkOrderForm();
      setBatchCreateSuggestions([]);
      setCreateState("idle");
      notifyCreateModal("cmpri-work-order-created");
    }, 900);
  }

  async function submitWorkOrders(orders: Record<string, unknown> | Record<string, unknown>[]): Promise<{
    error: { message: string } | null;
    workOrders: CreatedWorkOrder[];
    photoUploadPending: boolean;
  }> {
    if (submittingRef.current) return { error: { message: "Submission is already in progress." }, workOrders: [], photoUploadPending: false };
    if (pendingPhotoUploads.length > 0) {
      return {
        error: { message: "Retry the pending photo upload before creating more work orders." },
        workOrders: [],
        photoUploadPending: true,
      };
    }
    submittingRef.current = true;
    try {
      const session = await getValidSession();
      if (!session) {
        return { error: { message: "Sign in again before submitting." }, workOrders: [], photoUploadPending: false };
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
          workOrders: [],
          photoUploadPending: false,
        };
      }
      const workOrders = Array.isArray(result.work_orders) ? result.work_orders as CreatedWorkOrder[] : [];
      if (!workOrders.length || workOrders.some((order) => !order.id)) {
        return { error: { message: "Unable to confirm the saved ticket. Check the list before retrying." }, workOrders: [], photoUploadPending: false };
      }
      submittedDisplayIdsRef.current = workOrders.map((order) => formatWorkOrder(order.display_id));
      let photoUploadPending = false;
      if (photos.length && workOrders.length) {
        for (let photoIndex = 0; photoIndex < photos.length; photoIndex += 1) {
          const selectedPhoto = photos[photoIndex];
          for (let workOrderIndex = 0; workOrderIndex < workOrders.length; workOrderIndex += 1) {
            const workOrder = workOrders[workOrderIndex];
            const upload = await uploadWorkOrderAttachment(workOrder.id, selectedPhoto.file, session.access_token, selectedPhoto.uploadId);
            if (!upload.ok) {
              const failedUploads = photos.slice(photoIndex).flatMap((remainingPhoto, remainingPhotoIndex) =>
                workOrders.slice(remainingPhotoIndex === 0 ? workOrderIndex : 0).map(({ id, display_id }) => ({
                  id,
                  display_id,
                  photo: remainingPhoto,
                })),
              );
              setPendingPhotoUploads(failedUploads);
              setPhotoUploadError(`Photo upload failed for ${formatWorkOrder(workOrder.display_id)}: ${upload.message}`);
              setCanReplacePhoto(upload.canReplace);
              setPhotoToReplaceUploadId(upload.canReplace ? selectedPhoto.uploadId : "");
              photoUploadPending = true;
              break;
            }
          }
          if (photoUploadPending) break;
        }
      }
      return {
        error: null,
        workOrders,
        photoUploadPending,
      };
    } catch {
      return {
        error: { message: "Submission could not be confirmed. Check the work-order list before retrying." },
        workOrders: [],
        photoUploadPending: false,
      };
    } finally {
      submittingRef.current = false;
    }
  }

  async function retryPendingPhotoUploads() {
    if (retryingPhotoUpload || pendingPhotoUploads.length === 0) return;
    let session;
    try {
      session = await getValidSession();
    } catch {
      setPhotoUploadError("Your sign-in could not be verified. Retry after reconnecting.");
      return;
    }
    if (!session) {
      setPhotoUploadError("Sign in again before retrying the photo upload.");
      return;
    }

    setRetryingPhotoUpload(true);
    try {
      const pending = pendingPhotoUploads;
      let failedUploads: typeof pending = [];
      for (let index = 0; index < pending.length; index += 1) {
        const workOrder = pending[index];
        const upload = await uploadWorkOrderAttachment(workOrder.id, workOrder.photo.file, session.access_token, workOrder.photo.uploadId);
        if (!upload.ok) {
          failedUploads = pending.slice(index);
          setPhotoUploadError(`Photo upload failed for ${formatWorkOrder(workOrder.display_id)}: ${upload.message}`);
          setCanReplacePhoto(upload.canReplace);
          setPhotoToReplaceUploadId(upload.canReplace ? workOrder.photo.uploadId : "");
          break;
        }
      }
      setPendingPhotoUploads(failedUploads);
      if (failedUploads.length === 0) {
        setPhotoUploadError("");
        setCanReplacePhoto(false);
        setMessage("Photo upload completed successfully.");
        setBatchCreateSuggestions([]);
        afterSuccessfulCreate(() => {
          if (notifyCreateModal("cmpri-work-order-created", pending[0]?.display_id)) return;
          resetWorkOrderForm(true);
          setCreateState("idle");
        }, 900);
      }
    } finally {
      setRetryingPhotoUpload(false);
    }
  }

  function chooseReplacementPhoto() {
    if (!canReplacePhoto || !photoToReplaceUploadId) return;
    photoFileInputRef.current?.click();
  }

  function continueWithoutPhoto() {
    if (!canReplacePhoto || retryingPhotoUpload || pendingPhotoUploads.length === 0) return;
    const skippedUploads = pendingPhotoUploads;
    setPendingPhotoUploads([]);
    photoPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    photoPreviewUrlsRef.current.clear();
    setPhotos([]);
    setPhotoUploadError("");
    setCanReplacePhoto(false);
    setPhotoToReplaceUploadId("");
    setBatchCreateSuggestions([]);
    if (photoFileInputRef.current) photoFileInputRef.current.value = "";
    if (photoCameraInputRef.current) photoCameraInputRef.current.value = "";
    setMessage(skippedUploads.length === 1
      ? "Photo upload was skipped. The created work order remains saved."
      : `Photo upload was skipped. The ${skippedUploads.length} created work orders remain saved.`);
    afterSuccessfulCreate(() => {
      if (notifyCreateModal("cmpri-work-order-created", skippedUploads[0]?.display_id)) return;
      resetWorkOrderForm(true);
      setCreateState("idle");
    }, 900);
  }

  async function createWorkOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current || loading || createState !== "idle") return;
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

    const issueWithLocationRemoved = cleanIssueLocationPrefix(issue, locations, location).issue;
    const separated = separateIssueFromReporterNotes(issueWithLocationRemoved);
    const normalizedIssue = cleanIssueLocationPrefix(separated.issue, locations, location).issue;
    const submittedNotes = [notes.trim(), separated.reporterNotes].filter(Boolean).join("\n");
    if (!normalizedIssue.trim()) {
      setMessage("Reported Issue is required.");
      setLoading(false);
      setCreateState("idle");
      return;
    }
    if (normalizedIssue !== issue) setIssue(normalizedIssue);
    if (submittedNotes !== notes) setNotes(submittedNotes);

    const duplicate = possibleDuplicateFor(normalizedIssue, location, assetId || null);
    if (duplicate) {
      setMessage(`Possible duplicate detected: ${formatWorkOrder(duplicate.display_id, "existing work order")} — ${duplicate.issue || "similar active issue"}. Review the existing ticket before creating a new one.`);
      setLoading(false);
      setCreateState("idle");
      return;
    }

    const multipleCreateIssues = detectMultipleCreateIssues(normalizedIssue, locations, location);
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
      notes: submittedNotes,
    });

    if (result.error) {
      setMessage(result.error.message);
      setLoading(false);
      setCreateState("idle");
      return;
    }

    const displayId = formatWorkOrder(result.workOrders[0]?.display_id);
    await clearSubmittedDraft();
    await loadWorkOrders(Boolean(cmpriSession?.capabilities.includes("view_work_orders") || cmpriSession?.capabilities.includes("add_work_order_notes")));

    if (result.photoUploadPending) {
      setMessage(`Work order ${displayId} created. Its photo upload failed; retry the photo upload to finish.`);
      setLoading(false);
      setCreateState("created");
      return;
    }

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

    afterSuccessfulCreate(() => {
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
        badge: roomStatusBadge(location.room_status) || undefined,
        keywords: [
          location.room_number ?? "",
          location.area ?? "",
          location.location_type ?? "",
          location.room_status ?? "",
        ],
      }));
  }, [locations]);
  const createHasUnsavedChanges = Boolean(
    issue.trim() || locationId || notes.trim() || assetId || staffFirstName.trim() || photos.length > 0
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
      label: `${equipmentOptionLabel(asset)}${asset.location_id === null ? " (Template - no room assignment)" : asset.location_id !== locationId ? ` — ${locations.find(location => location.id === asset.location_id)?.name || "Common area"}` : ""}`,
      group: asset.location_id !== locationId ? cmpriLocationSection(locations.find(location => location.id === asset.location_id) || selectedLocation!) : undefined,
      keywords: [
        asset.asset_type,
        asset.manufacturer ?? "",
        asset.model_number ?? "",
        asset.asset_tag ?? "",
        asset.binder_tag ?? "",
      ],
    })),
    { value: "", label: tx("No specific asset / equipment", "Sin equipo específico") },
  ];

  const detectedCreateIssues = issue.trim() ? detectMultipleCreateIssues(issue, locations, selectedLocation) : [];
  const activeDraft = drafts.find((draft) => draft.id === activeDraftId) || (reviewDraft?.id === activeDraftId ? reviewDraft : null);
  const approvingDraft = Boolean(activeDraft && activeDraft.created_by !== cmpriSession?.user.id);

  const trustedTroubleshootingKnowledge = troubleshootingKnowledge?.source?.verified === true ? troubleshootingKnowledge : null;
  const trustedManualUrl = trustedTroubleshootingKnowledge?.source?.file_url || trustedTroubleshootingKnowledge?.source?.pdf_url;
  const troubleshootingEvidence = `${issue} ${notes}`.toLowerCase();
  const matchingTroubleshootingSteps = trustedTroubleshootingKnowledge?.symptom_rules
    ?.filter((rule) => !rule.match?.length || rule.match.some((phrase) => troubleshootingEvidence.includes(phrase.toLowerCase())))
    .flatMap((rule) => rule.steps) ?? [];
  const troubleshootingSteps = Array.from(new Set(matchingTroubleshootingSteps))
    .filter((step) => !troubleshootingStepAlreadyDone(step, notes));


  return (
    <main className="min-h-[100svh] bg-slate-950 p-1 text-white">
      <div data-work-order-form-layout className="mx-auto w-full max-w-none lg:w-[66vw]">
        {drafts.length > 0 && (
          <section className="mb-2 rounded-xl border border-slate-800 bg-slate-900 p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-bold text-white">Saved Drafts</h2>
                <p className="text-xs text-slate-400">Your saved drafts. Authorized draft review is available from the Engineering dashboard.</p>
              </div>
              <span className="rounded-full border border-slate-700 px-2.5 py-1 text-xs font-semibold text-slate-300">{drafts.length}</span>
            </div>
            <div className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
              {drafts.map((draft) => {
                const ownDraft = draft.created_by === cmpriSession?.user.id;
                const canEditDraft = ownDraft || Boolean(draft.can_edit);
                const active = activeDraftId === draft.id;
                return (
                  <div key={draft.id} className={`rounded-xl border p-3 ${active ? "border-sky-500 bg-sky-950/25" : "border-slate-800 bg-slate-950/55"}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-slate-100">{draft.room || "Room / Location"} · {draft.issue}</p>
                        <p className="mt-1 text-xs text-slate-500">{ownDraft ? "Your draft" : `Created by ${draft.creator_name || "another employee"}${draft.creator_display_role ? ` · ${draft.creator_display_role}` : ""}`}{draft.updated_at ? ` · Updated ${new Date(draft.updated_at).toLocaleString()}` : ""}</p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {canEditDraft
                          ? <button type="button" disabled={draftBusy} onClick={() => restoreDraft(draft)} className="rounded-lg border border-sky-600/60 px-3 py-1.5 text-xs font-bold text-sky-200 hover:bg-sky-950/60 disabled:opacity-50">{ownDraft ? "Load" : "Review / Edit"}</button>
                          : <span className="px-3 py-1.5 text-xs font-semibold text-slate-500">Read-only</span>}
                        {draft.can_delete && <button type="button" disabled={draftBusy} onClick={() => void deleteDraft(draft)} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-bold text-slate-200 hover:bg-slate-800 disabled:opacity-50">Discard</button>}
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
            <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-gradient-to-r from-slate-900 to-slate-950 px-3 py-2 md:static">
              {cmpriSession && !embedded && (
                <div className="mr-auto flex min-w-0 flex-col items-start leading-tight">
                  <p className="text-[14pt] font-bold leading-none tracking-tight"><span className="text-amber-300">CMPRI</span>{" "}<span className="text-amber-300">Engineering</span></p>
                  <AccountSummary user={cmpriSession.user} />
                  {isSubmitOnlyUser && !isFrontDeskUser && <ModalNavigationButton href="/profile" className="mt-1 rounded-lg border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-800">{tx("Manage Profile", "Administrar perfil")}</ModalNavigationButton>}
                </div>
              )}
              {cmpriSession && embedded && isSubmitOnlyUser && !isFrontDeskUser && <ModalNavigationButton href="/profile" className="mr-auto rounded-lg border border-slate-700 px-2 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-800">{tx("Manage Profile", "Administrar perfil")}</ModalNavigationButton>}


              {cmpriSession && !embedded && <><PoolStatus controlOnly/></>}
              <div data-preview-create-actions className="flex flex-wrap items-center justify-end gap-1">
                <WorkOrderMediaControl uploadInputRef={photoFileInputRef} disabled={(pendingPhotoUploads.length > 0 && !canReplacePhoto) || retryingPhotoUpload || loading} onSelect={files=>acceptSelectedPhotos(files)} />
                <button type="button" onClick={requestCancelCreateForm} disabled={loading || draftBusy || retryingPhotoUpload} className="min-h-10 rounded-lg border border-slate-600 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-60">{tx("Cancel", "Cancelar")}</button>
                {!isSubmitOnlyUser && <button type="button" onClick={() => void saveDraft()} disabled={loading || draftBusy || loadingLocations || loadingAssets} className="min-h-10 rounded-lg border border-sky-600/70 bg-sky-950/40 px-3 py-2 text-xs font-semibold text-sky-200 hover:bg-sky-900/50 disabled:opacity-60">{draftBusy ? tx("Saving Draft...", "Guardando borrador...") : activeDraftId ? tx("Update Draft", "Actualizar borrador") : tx("Save Draft", "Guardar borrador")}</button>}
                <button type="submit" disabled={loading || loadingLocations || loadingAssets || createState === "created"} className={`min-h-10 rounded-full border px-3 py-2 text-xs font-bold transition-colors disabled:opacity-80 ${createState === "created" ? "border-emerald-500 bg-emerald-600 text-white" : createState === "creating" ? "border-sky-900 bg-sky-950/70 text-sky-200" : "border-sky-500 bg-sky-700 text-white hover:bg-sky-600"}`}>
                  {createState === "creating" ? tx("Submitting...", "Enviando...") : createState === "created" ? tx("Submitted", "Enviado") : approvingDraft ? tx("Approve & Submit Draft", "Aprobar y enviar borrador") : isSubmitOnlyUser ? tx("Submit Request", "Enviar solicitud") : tx("Create Work Order", "Crear orden")}
                </button>
              </div>
            </div>

            {(photos.length > 0 || photoUploadError) && <div className="space-y-2">
              {photos.length > 0 && <div className="flex flex-wrap gap-2" aria-label="Selected photo previews">{photos.map((photo) => <WorkOrderPhotoPreview key={photo.uploadId} photo={photo} removeLabel={tx("Remove selected photo", "Quitar foto seleccionada")} onRemove={!loading && createState === "idle" && !mainWorkOrderCreated && !retryingPhotoUpload && pendingPhotoUploads.length === 0 ? () => removeSelectedPhoto(photo.uploadId) : undefined} />)}</div>}
              {photoUploadError && <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px]"><span role="alert" className="text-amber-300">{photoUploadError}</span>{canReplacePhoto && pendingPhotoUploads.length > 0 && <><button type="button" onClick={chooseReplacementPhoto} className="rounded border border-amber-500/70 px-2 py-1 font-semibold text-amber-200 hover:bg-amber-950/40">Choose a different photo</button><button type="button" onClick={continueWithoutPhoto} disabled={retryingPhotoUpload} className="rounded border border-slate-500/70 px-2 py-1 font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-60">Continue without photo</button></>}{pendingPhotoUploads.length > 0 && !canReplacePhoto && <button type="button" onClick={() => void retryPendingPhotoUploads()} disabled={retryingPhotoUpload} className="rounded border border-amber-500/70 px-2 py-1 font-semibold text-amber-200 hover:bg-amber-950/40 disabled:opacity-60">{retryingPhotoUpload ? "Retrying photo upload..." : "Retry photo upload"}</button>}</div>}
            </div>}

            {isFrontDeskUser && <label className="block">
              <span className="mb-1 block text-sm font-medium"> {tx("Your first name", "Tu nombre")} <span className="text-red-300">*</span></span>
              <input required maxLength={80} type="text" inputMode="text" name="staff-first-name" autoComplete="off" autoCorrect="off" autoCapitalize="words" spellCheck={false} data-lpignore="true" data-1p-ignore="true" data-form-type="other" value={staffFirstName} onChange={event => setStaffFirstName(event.target.value)} placeholder={tx("First name", "Nombre")} disabled={loading || creatingBatchWorkOrders || creatingRelatedWorkOrders} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none focus:border-amber-400" />
              <span className="mt-1 block text-xs text-slate-400"> {tx("Required for each report submitted through the shared front-desk account.", "Obligatorio para cada reporte enviado desde la cuenta compartida de recepción")} </span>
            </label>}

            <label className="block">
              <span className="mb-1 block text-sm font-medium"> {tx("Room / Location", "Habitación / Ubicación")} </span>
              <SearchableSelect
                required
                value={locationId}
                onChange={(value) => handleLocationChange(value)}
                disabled={loadingLocations}
                placeholder={loadingLocations ? tx("Loading locations...", "Cargando ubicaciones...") : tx("Room / Location", "Habitación / Ubicación")}
                options={locationOptions}
                topSuggestions={2}
              />
              {selectedLocation && (selectedLocationStatus ? (
                <span className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${selectedLocationStatus.className}`}>
                  Room condition: {selectedLocationStatus.label}
                </span>
              ) : <span className="mt-1 block text-xs text-slate-500">Room status not reported today.</span>)}
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium"> {tx("Issue", "Problema")} </span>
              <textarea
                required
                value={issue}
                disabled={loading}
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
                {assetRefreshError && <p role="alert" className="mb-2 text-xs text-amber-200">{assetRefreshError} <button type="button" onClick={() => void loadAssets()} className="underline">Retry equipment list</button></p>}
                {locationId && issue.trim() && !assetId && <p role="status" className="mb-2 text-xs text-amber-200">{tx("No confirmed equipment match for this location. You can submit; Engineering will verify the equipment.", "No hay equipo confirmado para esta ubicación. Puedes enviar; Ingeniería verificará el equipo.")}</p>}
                {!canSetEngineeringFields ? (
                  <output className="block w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-200">
                    {!locationId
                      ? tx("Select location first", "Selecciona la ubicación primero")
                      : createAssetOptions.find((option) => option.value === assetId)?.label
                        ?? tx("No specific asset / equipment", "Sin equipo específico")}
                  </output>
                ) : (
                  <SearchableSelect
                    value={assetId}
                    onChange={handleAssetChange}
                    disabled={!locationId || loadingAssets}
                    placeholder={!locationId ? tx("Select location first", "Selecciona la ubicación primero") : tx("Asset / Equipment", "Equipo / Activo")}
                    options={createAssetOptions}
                    topSuggestions={3}
                    showSuggestionsOnOpen={false}
                    expandOnOpen
                  />
                )}
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium"> {tx("Category", "Categoría")} </span>
                {!canSetEngineeringFields ? (
                  <output className="block w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-200">
                    {isSpanish ? (categoryLabelEs[category] || category) : category}
                  </output>
                ) : (
                  <SearchableSelect
                    value={category}
                    onChange={(value) => { setManualCategory(true); setCategory(value); }}
                    placeholder={tx("Category", "Categoría")}
                    topSuggestions={2}
                    options={categoryOptions(category).map((option) => ({ ...option, label: isSpanish ? (categoryLabelEs[option.value] || option.label) : option.label }))}
                  />
                )}
                {!canSetEngineeringFields && <p className="mt-2 text-xs font-semibold text-emerald-400"> {tx("System best guess · Engineering verifies after submission", "Mejor estimación del sistema · Ingeniería verifica después del envío")} </p>}
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium"> {tx("Priority", "Prioridad")} </span>
                {!canSetEngineeringFields ? (
                  <output className="block w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-200">
                    {isSpanish ? ({ Urgent: "Urgente", High: "Alta", Medium: "Media", Low: "Baja" } as Record<string, string>)[priority] : priority}
                  </output>
                ) : (
                  <SearchableSelect
                    value={priority}
                    onChange={(value) => { setManualPriority(true); setPriority(value); }}
                    placeholder={tx("Priority", "Prioridad")}
                    topSuggestions={2}
                    options={['Urgent','High','Medium','Low'].map((value) => ({ value, label: isSpanish ? ({ Urgent: 'Urgente', High: 'Alta', Medium: 'Media', Low: 'Baja' } as Record<string,string>)[value] : value }))}
                  />
                )}
                {!canSetEngineeringFields && <p className="mt-2 text-xs font-semibold text-emerald-400"> {tx("System best guess · locked for submit-only roles", "Mejor estimación del sistema · bloqueado para funciones de solo envío")} </p>}
              </label>
            </div>

            <label className="block">
              <span className="mb-1 block text-sm font-medium"> {tx("Notes / Actions Taken", "Notas / Acciones realizadas")} </span>
              <textarea
                value={notes}
                disabled={loading}
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
                    <p className="mt-1 text-xs text-slate-400">Only verified guidance for the selected equipment and reported issue is shown.</p>
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
                {!selectedCreateAsset && <p className="mt-3 text-xs text-slate-400">Select equipment to check for an exact verified manual match.</p>}
                {troubleshootingError && <p role="status" className="mt-3 text-xs text-amber-200">{troubleshootingError}</p>}
                {troubleshootingSteps.length > 0
                  ? <ol className="mt-3 space-y-2 text-sm text-slate-300">
                    {troubleshootingSteps.map((step, index) => (
                      <li key={`${step}-${index}`} className="flex gap-2">
                        <span className="font-semibold text-amber-400">{index + 1}.</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                  : selectedCreateAsset && !troubleshootingLoading && !troubleshootingError && (
                    <p className="mt-3 text-xs text-slate-400">{matchingTroubleshootingSteps.length
                      ? "The matched checks are already recorded as completed or ruled out in Notes / Actions Taken."
                      : "No issue-matched troubleshooting steps from verified documentation are available for this equipment."}</p>
                  )}
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
          <div className="cmpri-modal-backdrop fixed inset-0 z-[70] flex items-center justify-center bg-black/80" onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            setShowCancelConfirm(false);
          }}>
            <div role="dialog" aria-modal="true" aria-labelledby="create-cancel-title" className="cmpri-modal-shell border border-slate-700 bg-slate-900 shadow-2xl">
              <h2 id="create-cancel-title" className="text-xl font-bold">{pendingPhotoUploads.length > 0 ? tx("Cancel remaining photo uploads?", "¿Cancelar las cargas de fotos pendientes?") : tx("Cancel work-order creation?", "¿Cancelar la creación de la orden?")}</h2>
              <p className="mt-2 text-sm text-slate-400">{pendingPhotoUploads.length > 0 ? tx("The work order already exists. It and any saved photos will be kept. Photos still waiting to upload will not be saved.", "La orden ya existe. Se conservarán la orden y las fotos guardadas. No se guardarán las fotos pendientes de cargar.") : tx("Your unsaved work and selected photos will be discarded. Any saved draft for this work will also be deleted.", "Se descartarán el trabajo no guardado y las fotos seleccionadas. También se eliminará cualquier borrador guardado de este trabajo.")}</p>
              <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button type="button" autoFocus disabled={draftBusy} onClick={() => setShowCancelConfirm(false)} className="rounded-lg border border-slate-600 px-5 py-3 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-60">{tx("Keep Editing", "Seguir editando")}</button>
                <button type="button" disabled={draftBusy} onClick={() => void confirmCancelCreateForm()} className="rounded-lg bg-red-600 px-5 py-3 text-sm font-bold text-white hover:bg-red-500 disabled:opacity-60">{draftBusy ? tx("Discarding...", "Descartando...") : tx("Confirm Cancel", "Confirmar cancelación")}</button>
              </div>
            </div>
          </div>
        )}

        {showBatchCreateDialog && selectedLocation && (
          <div className="cmpri-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/70" onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            setShowBatchCreateDialog(false);
            setBatchCreateSuggestions([]);
          }}>
            <div role="dialog" aria-modal="true" aria-labelledby="batch-work-orders-title" className="cmpri-modal-shell border border-slate-700 bg-slate-900 shadow-2xl">
              <h2 id="batch-work-orders-title" className="text-xl font-bold">{batchCreateSuggestions.length} work orders detected</h2>
              <p className="mt-1 text-sm text-slate-400">CMPRI found multiple maintenance issues in one report. Review them before anything is submitted. You can edit an issue or remove one that should not become a separate work order.</p>

              <div className="mt-2 max-h-[58vh] space-y-1.5 overflow-y-auto pr-1">
                {batchCreateSuggestions.map((suggestion, index) => {
                  const rowLocation = resolveSuggestionLocation(suggestion) ?? selectedLocation;
                  const relatedAsset = resolveRelatedAsset(suggestion, rowLocation);
                  const duplicate = possibleDuplicateFor(suggestion.issue, rowLocation);
                  return (
                    <div key={suggestion.key} className="rounded-xl border border-slate-700 bg-slate-950 p-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Work Order {index + 1}</p>
                          <div className="mt-1">
                            <SearchableSelect
                              value={rowLocation.id}
                              onChange={(value) => {
                                const nextLocation = locations.find((item) => item.id === value) || null;
                                setBatchCreateSuggestions((current) => current.map((item, itemIndex) =>
                                  itemIndex === index ? { ...item, locationId: nextLocation?.id ?? null, locationName: nextLocation?.name ?? "" } : item
                                ));
                              }}
                              options={locationOptions}
                              placeholder={tx("Room / Location", "Habitación / Ubicación")}
                            />
                          </div>
                          <input
                            value={suggestion.issue}
                            onChange={(event) => {
                              const nextIssue = event.target.value;
                              setBatchCreateSuggestions((current) => current.map((item, itemIndex) =>
                                itemIndex === index ? createSuggestionFromIssueClause(nextIssue, itemIndex, locations, resolveSuggestionLocation(item)) : item
                              ));
                            }}
                            className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm outline-none focus:border-amber-400"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => handleBatchSuggestionRemoval(index)}
                          className="rounded-lg border border-red-500/50 px-3 py-1 text-xs font-semibold text-red-300 hover:bg-red-950/40"
                        >
                          Remove
                        </button>
                      </div>
                      <div className="mt-1.5 grid gap-1.5 text-xs text-slate-300 sm:grid-cols-3">
                        <span><span className="text-slate-500">Asset:</span> {relatedAsset?.name ?? suggestion.assetName}</span>
                        <span><span className="text-slate-500">Category:</span> {suggestion.category}</span>
                        <span><span className="text-slate-500">Priority:</span> {suggestion.priority}</span>
                      </div>
                      {duplicate && (
                        <p className="mt-1.5 rounded-lg border border-orange-500/40 bg-orange-950/30 px-2 py-1 text-xs font-semibold text-orange-200">Possible duplicate: {formatWorkOrder(duplicate.display_id, "existing work order")} — {duplicate.issue || "similar active issue"}</p>
                      )}
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        <button type="button" onClick={() => void createSingleBatchWorkOrder(suggestion)} className="rounded-lg border border-amber-500/50 bg-amber-950/30 px-3 py-1 text-xs font-bold text-amber-100 hover:bg-amber-900/40">Submit This</button>
                        <button type="button" onClick={() => handleBatchSuggestionRemoval(index)} className="rounded-lg border border-red-500/50 px-3 py-1 text-xs font-bold text-red-200 hover:bg-red-950/40">Remove</button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button type="button" autoFocus disabled={creatingBatchWorkOrders} onClick={() => { setShowBatchCreateDialog(false); setBatchCreateSuggestions([]); }} className="rounded-lg border border-slate-600 px-4 py-1.5 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50">Back to Form</button>
                <button type="button" disabled={creatingBatchWorkOrders || batchCreateSuggestions.length < 2} onClick={() => void createBatchWorkOrders()} className="rounded-lg bg-amber-400 px-4 py-1.5 text-sm font-bold text-slate-950 disabled:opacity-60">
                  {creatingBatchWorkOrders ? "Submitting..." : `Submit All (${batchCreateSuggestions.length})`}
                </button>
              </div>
            </div>
          </div>
        )}

        {showRelatedWorkOrderDialog &&
          selectedLocation && (
            <div className="cmpri-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/70" onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.preventDefault();
              event.stopPropagation();
              cancelRelatedWorkOrders();
            }}>
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="related-work-orders-title"
                className="cmpri-modal-shell border border-slate-700 bg-slate-900 shadow-2xl"
              >
                <h2
                  id="related-work-orders-title"
                  className="text-xl font-bold"
                >
                  Are you sure you want to create these work orders?
                </h2>

                <p className="mt-1 text-sm text-slate-400">
                  Review the separate issues found in the technician notes. Category, priority, and troubleshooting will still be saved, but they are intentionally hidden from this confirmation.
                </p>

                <div className="mt-2 max-h-[55vh] space-y-1.5 overflow-y-auto pr-1">
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
                          className="rounded-xl border border-slate-700 bg-slate-950 p-2"
                        >
                          <div className="grid gap-1.5 sm:grid-cols-[110px_1fr]">
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

                <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={
                      cancelRelatedWorkOrders
                    }
                    disabled={
                      creatingRelatedWorkOrders
                    }
                    className="rounded-lg border border-slate-600 px-4 py-1.5 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"
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
                    className="rounded-lg bg-amber-400 px-4 py-1.5 text-sm font-bold text-slate-950 disabled:opacity-60"
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
