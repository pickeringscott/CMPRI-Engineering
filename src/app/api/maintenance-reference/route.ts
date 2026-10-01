import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireCapability } from "@/lib/server/auth";
import { roleAllows } from "@/lib/server/roles";

const DOCUMENTATION_BUCKET = "asset-documentation";
const VERIFY_MARKER = "_cmpri-verification.json";

type KnowledgePayload = Record<string, unknown> & {
  source?: Record<string, unknown>;
};

type AssetReference = {
  id: string;
  location_id: string | null;
  active: boolean | null;
  documentation_key: string | null;
  [key: string]: unknown;
};

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function pageList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter((page) => Number.isInteger(page) && page > 0);
}

function documentationFileMatches(file: { name?: string; metadata?: Record<string, unknown> | null }, sourceFileName: string) {
  const expected = sourceFileName.trim().toLowerCase();
  if (!expected) return false;
  return String(file.name || "").toLowerCase() === expected ||
    String(file.metadata?.original_name || "").trim().toLowerCase() === expected;
}

function manualTestMatches(titleValue: unknown, testValue: unknown) {
  const text = `${String(titleValue || "")} ${String(testValue || "")}`.toLowerCase();
  const matches = new Set<string>();
  const add = (...values: string[]) => values.forEach((value) => matches.add(value));

  if (/power cycle|reboot|restart/.test(text)) add("power cycle", "reboot", "restart", "no signal", "black screen", "frozen", "not working");
  if (/no visible display|no power|display|console/.test(text)) add("no power", "display", "screen blank", "dead", "won't start", "will not start");
  if (/door|lock|unlock|credential/.test(text)) add("door", "lock", "unlock", "key not working", "credential denied", "won't unlock", "will not unlock");
  if (/battery|low-battery|dead-battery/.test(text)) add("battery", "low battery", "dead battery", "no response", "red light");
  if (/clock|date\/time|date and time|time reset/.test(text)) add("clock", "wrong time", "date time", "time reset", "credential denied", "key not working");
  if (/motor rotation|drive fault|motor wiring|drive wiring/.test(text)) add("motor", "not spinning", "won't turn", "will not turn", "drive fault", "not rotating");
  if (/spray|rinse|solenoid|inlet valve/.test(text)) add("rinse", "spray", "water", "fill", "valve", "solenoid");
  if (/backwash|filter pressure|clean-filter pressure/.test(text)) add("backwash", "filter", "high pressure", "low flow", "pressure rises", "poor flow");
  if (/airflow|cfm|dehumid/.test(text)) add("airflow", "humid", "humidity", "muggy", "dehumidification", "pool room");
  if (/water flow|gpm|pressure drop|exchanger|scal/.test(text)) add("water flow", "low flow", "pressure", "pool not heating", "water not heating", "scale", "scaling");
  if (/temperature|temp sensor|thermostat/.test(text)) add("temperature", "temp", "thermostat", "not cooling", "not heating");

  return [...matches];
}

function enrichManualKnowledge(payload: KnowledgePayload | null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const asObject = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const sourcePayload = asObject(payload);
  const source = asObject(sourcePayload.source ?? sourcePayload.document);
  const rawCodes = sourcePayload.error_codes ?? sourcePayload.errorCodes ?? sourcePayload.diagnostic_codes ?? [];
  const rawRules = sourcePayload.symptom_rules ?? sourcePayload.symptomRules ?? sourcePayload.troubleshooting ?? sourcePayload.guidance ?? [];
  const error_codes = Array.isArray(rawCodes)
    ? rawCodes
        .map((entry: unknown) => {
          const item = asObject(entry);
          return {
            code: String(item.code ?? item.id ?? "").trim(),
            problem: String(item.problem ?? item.description ?? item.meaning ?? "").trim(),
            action: String(item.action ?? item.solution ?? item.corrective_action ?? "").trim(),
            source_pages: pageList(item.source_pages ?? item.pages),
          };
        })
        .filter((item) => item.code && (item.problem || item.action))
    : [];

  const symptom_rules = Array.isArray(rawRules)
    ? rawRules
        .map((entry: unknown) => {
          if (typeof entry === "string") return { match: [], steps: [entry] };
          const item = asObject(entry);
          const matchRaw = item.match ?? item.matches ?? item.symptoms ?? item.keywords ?? [];
          const stepsRaw = item.steps ?? item.actions ?? item.suggestions ?? item.troubleshooting ?? [];
          return {
            match: Array.isArray(matchRaw) ? matchRaw.map(String) : [String(matchRaw || "")].filter(Boolean),
            steps: Array.isArray(stepsRaw) ? stepsRaw.map(String) : [String(stepsRaw || "")].filter(Boolean),
            source_pages: pageList(item.source_pages ?? item.pages),
          };
        })
        .filter((item) => item.steps.length > 0)
    : [];

  const generalChecksRaw = sourcePayload.general_checks ?? sourcePayload.generalChecks ?? sourcePayload.general_checks_list ?? [];
  const general_checks = stringList(generalChecksRaw);
  const rawManualTests = Array.isArray(sourcePayload.manual_tests)
    ? sourcePayload.manual_tests as unknown[]
    : Array.isArray(sourcePayload.manualTests)
      ? sourcePayload.manualTests as unknown[]
      : [];

  const manual_tests = rawManualTests
    .map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const item = asObject(entry);
      const title = String(item.title ?? item.name ?? "").trim();
      const testText = [item.test, item.action, item.step, item.steps]
        .flatMap((value) => Array.isArray(value) ? value : [value])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
        .join(" ")
        .trim();
      const steps = Array.isArray(item.steps)
        ? item.steps.map((value) => String(value ?? "").trim()).filter(Boolean)
        : testText ? [testText] : [];
      const matchSource = item.match ?? item.matches ?? item.symptoms ?? item.keywords ?? [];
      const match = Array.isArray(matchSource)
        ? matchSource.map((value) => String(value ?? "").trim()).filter(Boolean)
        : matchSource
          ? [String(matchSource).trim()].filter(Boolean)
          : [];
      if (!title && !testText && !steps.length && !match.length) return null;
      return {
        title: title || undefined,
        test: testText || undefined,
        action: String(item.action ?? "").trim() || undefined,
        steps,
        match,
        source_pages: pageList(item.source_pages ?? item.pages),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => !!entry);

  const combinedSymptomRules = [...symptom_rules];

  if (general_checks.length) {
    combinedSymptomRules.push({
      match: [],
      steps: general_checks,
      source_pages: pageList(sourcePayload.source_pages ?? sourcePayload.pages),
    });
  }

  for (const entry of rawManualTests) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = asObject(entry);
    const title = String(item.title ?? item.name ?? "").trim();
    const testText = String(item.test ?? item.action ?? item.step ?? (Array.isArray(item.steps) ? item.steps.join(" ") : item.steps ?? "")).trim();
    const match = manualTestMatches(title, testText);
    if (!match.length) continue;
    const steps = Array.isArray(item.steps)
      ? item.steps.map((value) => String(value ?? "").trim()).filter(Boolean)
      : testText
        ? [testText]
        : [];
    if (!steps.length) continue;
    combinedSymptomRules.push({
      match,
      steps,
      source_pages: pageList(item.source_pages ?? item.pages),
    });
  }

  return {
    manufacturer: String(sourcePayload.manufacturer ?? ""),
    equipment: String(sourcePayload.equipment ?? sourcePayload.asset ?? ""),
    source: {
      type: String(source.type ?? sourcePayload.document_type ?? ""),
      title: String(source.title ?? sourcePayload.title ?? sourcePayload.document_title ?? ""),
      verified: (source.verified ?? sourcePayload.verified) === true,
      source_file_name: String(source.source_file_name ?? sourcePayload.source_file_name ?? ""),
      file_url: String(source.file_url ?? sourcePayload.file_url ?? ""),
      pdf_url: String(source.pdf_url ?? sourcePayload.pdf_url ?? ""),
    },
    error_codes,
    symptom_rules: combinedSymptomRules,
    general_checks,
    manual_tests,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireCapability(request, "view_dashboard");
  if (!auth) return NextResponse.json({ error: "Dashboard access is required." }, { status: 403 });
  const dataClient = auth.admin;
  const assetFields = "id, location_id, asset_type, name, asset_tag, active, status, manufacturer, model_number, serial_number, generation, install_year, documentation_key";
  const assetId = request.nextUrl.searchParams.get("assetId")?.trim() || "";

  const [{ data: memberships, error: membershipError }, assetResult] = await Promise.all([
    dataClient
      .from("hotel_members")
      .select("user_id")
      .eq("hotel_id", HOTEL_ID)
      .eq("active", true),
    (async () => {
      if (assetId) {
        const result = await dataClient
          .from("assets")
          .select(assetFields)
          .eq("hotel_id", HOTEL_ID)
          .eq("id", assetId)
          .maybeSingle();
        if (result.error) return { data: null, error: result.error };
        return { data: result.data ? [result.data] : [], error: null };
      }
      const allAssets: Record<string, unknown>[] = [];
      const pageSize = 1000;
      for (let offset = 0; ; offset += pageSize) {
        const result = await dataClient
          .from("assets")
          .select(assetFields)
          .eq("hotel_id", HOTEL_ID)
          .order("name", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (result.error) return result;
        allAssets.push(...((result.data || []) as Record<string, unknown>[]));
        if ((result.data || []).length < pageSize) {
          return { data: allAssets, error: null };
        }
      }
    })(),
  ]);

  if (membershipError || assetResult.error) {
    return NextResponse.json({ error: "Maintenance reference data could not be loaded." }, { status: 503 });
  }
  const rawAssets = (assetResult.data || []) as AssetReference[];
  const locationIds = Array.from(new Set(rawAssets.map((asset) => String(asset.location_id || "")).filter(Boolean)));
  const locationNames = new Map<string, string>();
  if (locationIds.length) {
    const { data: locations } = await dataClient.from("locations")
      .select("id, name")
      .eq("hotel_id", HOTEL_ID)
      .in("id", locationIds);
    for (const location of locations || []) locationNames.set(String(location.id), String(location.name || ""));
  }
  const assets: Array<AssetReference & { location_name: string }> = rawAssets.map((asset) => ({
    ...asset,
    location_name: locationNames.get(String(asset.location_id || "")) || "",
  }));

  const memberIds = (memberships || []).map((item) => String(item.user_id || "")).filter(Boolean);
  let profiles: Array<{ id: string; full_name: string | null; role: string | null; active: boolean | null }> = [];
  if (memberIds.length) {
    const result = await dataClient
      .from("profiles")
      .select("id, full_name, role, active")
      .in("id", memberIds)
      .eq("active", true)
      .order("full_name", { ascending: true });
    if (result.error) {
      return NextResponse.json({ error: "Technician reference data could not be loaded." }, { status: 503 });
    }
    profiles = result.data || [];
  }

  const technicians = profiles.filter((profile) =>
    roleAllows(profile.role, "edit_tickets") || roleAllows(profile.role, "close_tickets"),
  );
  const usableAssets = (assets ?? []).filter((asset) => asset.active !== false);

  let manualKnowledge: KnowledgePayload | null = null;
  let documentationStatus = assetId ? "unresolved" : "no_asset";
  const selectedAsset = assetId ? usableAssets.find((asset) => String(asset.id) === assetId) : undefined;

  if (assetId && !selectedAsset) {
    return NextResponse.json({ error: "Selected equipment is not available at CMPRI." }, { status: 404 });
  }

  if (selectedAsset) {
    async function readCache(cacheKey?: string | null) {
      const key = String(cacheKey || "").trim();
      if (!key) return { payload: null, failed: false };
      const { data, error } = await dataClient
        .from("troubleshooting_cache")
        .select("payload")
        .eq("hotel_id", HOTEL_ID)
        .eq("cache_key", key)
        .maybeSingle();
      if (error) return { payload: null, failed: true };
      return { payload: (data?.payload || null) as KnowledgePayload | null, failed: false };
    }

    const documentationKey = typeof selectedAsset.documentation_key === "string" ? selectedAsset.documentation_key.trim() : "";
    const cacheResult = await readCache(documentationKey);
    manualKnowledge = cacheResult.payload;
    documentationStatus = !documentationKey
      ? "unassigned"
      : cacheResult.failed
        ? "lookup_unavailable"
        : manualKnowledge
          ? "unverified"
          : "not_found";

    // A storage upload is attached only when the keyed knowledge record names
    // that exact PDF. The asset-level verification marker alone cannot identify
    // which of several uploaded files is the source for this guide.
    const prefix = `${HOTEL_ID}/${assetId}`;
    const source = objectRecord(manualKnowledge?.source);
    const sourceFileName = String(source.source_file_name || "").trim();
    if (manualKnowledge && sourceFileName) {
      const { data: storedDocs, error: storageError } = await dataClient.storage
        .from(DOCUMENTATION_BUCKET)
        .list(prefix, { limit: 100, sortBy: { column: "created_at", order: "desc" } });
      const files = storedDocs || [];
      const verified = !storageError && files.some((file) => String(file.name || "") === VERIFY_MARKER);
      const sourcePdf = !storageError && files.find((file) =>
        String(file.name || "").toLowerCase().endsWith(".pdf") && documentationFileMatches(file, sourceFileName),
      );
      if (sourcePdf && verified) {
        const storagePath = `${prefix}/${sourcePdf.name}`;
        const { data: signed } = await dataClient.storage
          .from(DOCUMENTATION_BUCKET)
          .createSignedUrl(storagePath, 60 * 60);
        if (signed?.signedUrl) {
          const sourceRecord = objectRecord(manualKnowledge.source);
          manualKnowledge = {
            ...manualKnowledge,
            source: {
              ...sourceRecord,
              type: sourceRecord.type || "Equipment Documentation",
              title: sourceRecord.title || sourceFileName,
              file_url: signed.signedUrl,
            },
          };
        }
      }
    }

    manualKnowledge = enrichManualKnowledge(manualKnowledge);
    if (manualKnowledge) {
      documentationStatus = objectRecord(manualKnowledge.source).verified === true ? "verified" : "unverified";
    }
  }

  return NextResponse.json({
    technicians,
    assets: usableAssets,
    manualKnowledge,
    asset_id: selectedAsset?.id || null,
    documentation_key: selectedAsset?.documentation_key || null,
    documentation_status: documentationStatus,
    can_edit_equipment: allows(auth.principal, "manage_assets"),
  }, { headers: { "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization" } });
}
