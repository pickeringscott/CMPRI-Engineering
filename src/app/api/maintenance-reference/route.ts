import * as baseline from "@/lib/server/pre-consolidation/maintenance-reference-route";
import { dispatchConsolidation } from "@/lib/server/consolidation-stage";
import { listRegisteredAssetFiles } from "@/lib/server/asset-file-register";
import { NextRequest, NextResponse } from "next/server";
import { HOTEL_ID } from "@/lib/constants";
import { allows } from "@/lib/server/access";
import { requireCapability } from "@/lib/server/auth";
import { roleAllows } from "@/lib/server/roles";
import { manualMatchesEquipment } from "@/lib/manual-document-match";
import {
  extractManualPdfText,
  manualPdfMatchesEquipment,
  manualPdfSha256,
} from "@/lib/manual-pdf-knowledge";
import { loadVerifiedCatalogManuals } from "@/lib/server/verified-manual-catalog";
import { readUploadedAssetMaintenanceReference } from "@/lib/server/uploaded-asset-guide";

const DOCUMENTATION_BUCKET = "asset-documentation";
const VERIFY_MARKER = "_cmpri-verification.json";
export const runtime = "nodejs";
export const maxDuration = 60;

type KnowledgePayload = Record<string, unknown> & {
  manufacturer?: string;
  model_family?: string;
  model_number?: string;
  source?: Record<string, unknown>;
};

type AssetReference = {
  documentation_verified_at?: string | null;
  documentation_revision_id?: string | null;
  id: string;
  location_id: string | null;
  active: boolean | null;
  manufacturer: string | null;
  model_family: string | null;
  model_number: string | null;
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
            ...(item.source_url ? { source_url: String(item.source_url) } : {}),
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
            ...(item.source_url ? { source_url: String(item.source_url) } : {}),
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
      ...(item.source_url ? { source_url: String(item.source_url) } : {}),
    });
  }

  return {
    manufacturer: String(sourcePayload.manufacturer ?? ""),
    equipment: String(sourcePayload.equipment ?? sourcePayload.asset ?? ""),
    model_family: String(sourcePayload.model_family ?? source.model_family ?? ""),
    model_number: String(sourcePayload.model_number ?? source.model_number ?? ""),
    source: {
      type: String(source.type ?? sourcePayload.document_type ?? ""),
      title: String(source.title ?? sourcePayload.title ?? sourcePayload.document_title ?? ""),
      verified: (source.verified ?? sourcePayload.verified) === true,
      manufacturer: String(source.manufacturer ?? sourcePayload.manufacturer ?? ""),
      model_family: String(source.model_family ?? sourcePayload.model_family ?? ""),
      source_file_name: String(source.source_file_name ?? sourcePayload.source_file_name ?? ""),
      file_url: String(source.file_url ?? sourcePayload.file_url ?? ""),
      pdf_url: String(source.pdf_url ?? sourcePayload.pdf_url ?? ""),
    },
    source_passages: Array.isArray(sourcePayload.source_passages) ? sourcePayload.source_passages : [],
    error_codes,
    symptom_rules: combinedSymptomRules,
    general_checks,
    manual_tests,
  };
}

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get('source') === 'asset-upload') return readUploadedAssetMaintenanceReference(request);
  const staged = await dispatchConsolidation(request, baseline.GET);
  if (staged) return staged;
  const auth = await requireCapability(request, "view_dashboard");
  if (!auth) return NextResponse.json({ error: "Dashboard access is required." }, { status: 403 });
  const dataClient = auth.admin;
  const assetFields = "id, location_id, asset_type, name, asset_tag, active, status, manufacturer, model_family, model_number, serial_number, generation, install_year, documentation_key, documentation_verified_at, documentation_revision_id";
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
  const documentationWarnings: string[] = [];
  const selectedAsset = assetId ? usableAssets.find((asset) => String(asset.id) === assetId) : undefined;

  if (assetId && !selectedAsset) {
    return NextResponse.json({ error: "Selected equipment is not available at CMPRI." }, { status: 404 });
  }

  if (selectedAsset) {
    const { data: storedDocs, error: storageError } = await listRegisteredAssetFiles(dataClient, assetId);
    if (storageError) return NextResponse.json({ error: "Equipment PDF links could not be loaded." }, { status: 503 });
    const preferred = storedDocs.find(f => f.preferred);
    const files = preferred ? storedDocs.filter(f => f.storage_path === preferred.storage_path) : storedDocs;
    const assetDocumentsVerified = !selectedAsset.documentation_revision_id && (Boolean(selectedAsset.documentation_verified_at) || files.some((file) => String(file.name || "") === VERIFY_MARKER));
    const pdfFiles = files.filter((file) => String(file.name || "").toLowerCase().endsWith(".pdf"));
    const matchingDocuments: Array<{
      name: string;
      text: string;
      sha256: string;
      storagePath: string;
      documentKey: string | null;
      documentManufacturer: string;
      documentType: string | null;
      modelFamily: string | null;
      catalogVerified: boolean;
      knowledgeKey: string | null;
      knowledge?: Record<string, unknown> | null;
      selectedModel?: string;
    }> = [];
    if (assetDocumentsVerified && selectedAsset.manufacturer && (selectedAsset.model_family || selectedAsset.model_number)) {
      for (const file of pdfFiles) {
        const storagePath = file.storage_path;
        const { data: stored, error: downloadError } = await dataClient.storage
          .from(DOCUMENTATION_BUCKET)
          .download(storagePath);
        if (downloadError || !stored) {
          documentationWarnings.push(`${file.name}: saved PDF could not be read.`);
          continue;
        }
        const bytes = new Uint8Array(await stored.arrayBuffer());
        let text: string;
        try {
          text = await extractManualPdfText(bytes);
        } catch {
          documentationWarnings.push(`${file.name}: saved file is not a readable PDF.`);
          continue;
        }
        if (text && manualPdfMatchesEquipment(text, selectedAsset)) {
          matchingDocuments.push({
            name: file.name,
            text,
            sha256: manualPdfSha256(bytes),
            storagePath,
            documentKey: null,
            documentManufacturer: selectedAsset.manufacturer || "",
            documentType: "Uploaded equipment document",
            modelFamily: selectedAsset.model_family,
            catalogVerified: false,
            knowledgeKey: null,
          });
        }
      }
    }

    let catalogWarnings: string[] = [];
    try {
      const catalog = await loadVerifiedCatalogManuals(dataClient, selectedAsset);
      catalogWarnings = catalog.warnings;
      documentationWarnings.push(...catalog.warnings);
      matchingDocuments.push(...catalog.documents.map((document) => ({
        name: document.name,
        text: document.text,
        sha256: document.sha256,
        storagePath: document.storagePath,
        documentKey: document.documentKey,
        documentManufacturer: document.manufacturer,
        documentType: document.documentType,
        modelFamily: document.modelFamily,
        catalogVerified: true,
        knowledgeKey: document.knowledgeKey,
        knowledge: document.knowledge,
        selectedModel: document.selectedModel,
      })));
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : "Verified manufacturer documentation could not be loaded.",
      }, { status: 503 });
    }

    if (!matchingDocuments.length) {
      documentationStatus = !selectedAsset.manufacturer || (!selectedAsset.model_family && !selectedAsset.model_number)
        ? "identity_incomplete"
        : catalogWarnings.length
          ? "catalog_verification_failed"
          : assetDocumentsVerified || !storageError
            ? "no_exact_match"
            : "lookup_unavailable";
    } else {
      // Read only catalog-linked, pre-ingested knowledge. A GET must never
      // generate paid AI guidance or substitute generic equipment advice.
      const reviewed: Array<{ document: typeof matchingDocuments[number]; payload: KnowledgePayload }> = [];
      for (const document of matchingDocuments) {
        if (!document.catalogVerified) continue;
        const payload = document.knowledge as KnowledgePayload | null;
        const source = objectRecord(payload?.source);
        if (!payload || source.verified !== true || source.source_file_name !== document.name ||
            !manualMatchesEquipment(document.selectedModel ? { ...selectedAsset, manufacturer: document.documentManufacturer, model_number: document.selectedModel, model_family: document.modelFamily } : selectedAsset, payload)) continue;
        reviewed.push({ document, payload });
      }
      if (!reviewed.length) {
        documentationStatus = "no_guidance";
      } else {
        const primary = reviewed[0];
        const sourceUrls = new Map<string, string>();
        for (const { document } of reviewed) {
          const { data: signed, error } = await dataClient.storage.from(DOCUMENTATION_BUCKET).createSignedUrl(document.storagePath, 3600);
          if (error || !signed?.signedUrl) return NextResponse.json({ error: "Verified manual link could not be created." }, { status: 503 });
          sourceUrls.set(document.name, signed.signedUrl);
        }
        const entries = (key: string) => reviewed.flatMap(({ document, payload }) => Array.isArray(payload[key])
          ? (payload[key] as unknown[]).map(entry => typeof entry === "object" && entry !== null
            ? { ...entry, source_url: sourceUrls.get(document.name), source_file_name: document.name } : entry) : []);
        manualKnowledge = {
          manufacturer: selectedAsset.manufacturer || "",
          model_family: selectedAsset.model_family || primary.document.modelFamily || "",
          model_number: primary.document.selectedModel || selectedAsset.model_number || "",
          source: {
            ...objectRecord(primary.payload.source),
            source_file_name: primary.document.name,
            source_files: reviewed.map(({ document }) => document.name),
            verified: true,
          },
          source_passages: entries("source_passages"),
          error_codes: entries("error_codes"),
          symptom_rules: entries("symptom_rules"),
          manual_tests: entries("manual_tests"),
          general_checks: entries("general_checks"),
        };
      }
          if (manualKnowledge) {
            const primaryFile = String(objectRecord(manualKnowledge.source).source_file_name || "");
            const primaryDoc = matchingDocuments.find((document) => document.name === primaryFile) || matchingDocuments[0];
            const { data: signed, error: signedError } = await dataClient.storage
              .from(DOCUMENTATION_BUCKET)
              .createSignedUrl(primaryDoc.storagePath, 60 * 60);
            if (signedError || !signed?.signedUrl) {
              return NextResponse.json({ error: "Verified PDF preview could not be created." }, { status: 503 });
            }
            manualKnowledge = {
              ...manualKnowledge,
              source: { ...objectRecord(manualKnowledge.source), file_url: signed.signedUrl },
            };
            documentationStatus = "verified";
          }
    }

    manualKnowledge = enrichManualKnowledge(manualKnowledge);
  }

  return NextResponse.json({
    technicians,
    assets: usableAssets,
    manualKnowledge,
    asset_id: selectedAsset?.id || null,
    documentation_key: selectedAsset?.documentation_key || null,
    documentation_status: documentationStatus,
    documentation_warnings: documentationWarnings,
    can_edit_equipment: allows(auth.principal, "manage_assets"),
  }, { headers: { "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization" } });
}
