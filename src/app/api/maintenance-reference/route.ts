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

function normalizedModelPattern(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[%*]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function normalizedModel(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function modelMatchesPattern(modelValue: unknown, patternValue: unknown) {
  const model = normalizedModel(modelValue);
  const pattern = normalizedModelPattern(patternValue);
  if (!model || !pattern) return false;
  return model.includes(pattern) || pattern.includes(model);
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
  if (!payload) return null;

  const rawRules = Array.isArray(payload.symptom_rules) ? [...payload.symptom_rules] : [];
  const generalChecks = stringList(payload.general_checks);
  if (generalChecks.length) {
    rawRules.push({ match: [], steps: generalChecks, guidance_type: "general_checks" });
  }

  if (Array.isArray(payload.manual_tests)) {
    for (const entry of payload.manual_tests) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      const testText = String(item.test || item.steps || item.action || "").trim();
      if (!testText) continue;
      const title = String(item.title || "").trim();
      const matches = manualTestMatches(title, testText);
      // Manual tests are intentionally not emitted as empty-match rules. A
      // technical test belongs on the ticket only when its subject matches
      // the reported symptom; otherwise it remains available in the source
      // document instead of becoming always-on troubleshooting noise.
      if (!matches.length) continue;
      rawRules.push({
        match: matches,
        steps: [title ? `${title}: ${testText}` : testText],
        source_pages: pageList(item.source_pages ?? item.pages),
        guidance_type: "manual_test",
      });
    }
  }

  return { ...payload, symptom_rules: rawRules };
}

export async function GET(request: NextRequest) {
  const auth = await requireCapability(request, "view_dashboard");
  if (!auth) return NextResponse.json({ error: "Dashboard access is required." }, { status: 403 });
  const dataClient = auth.admin;

  const [{ data: memberships, error: membershipError }, { data: assets, error: assetsError }] = await Promise.all([
    dataClient
      .from("hotel_members")
      .select("user_id")
      .eq("hotel_id", HOTEL_ID)
      .eq("active", true),
    dataClient
      .from("assets")
      .select("id, location_id, asset_type, name, asset_tag, active, status, manufacturer, model_number, serial_number, generation, install_year, documentation_key")
      .eq("hotel_id", HOTEL_ID)
      .order("name", { ascending: true }),
  ]);

  if (membershipError || assetsError) {
    return NextResponse.json({ error: "Maintenance reference data could not be loaded." }, { status: 503 });
  }

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
  const assetId = request.nextUrl.searchParams.get("assetId")?.trim() || "";
  const selectedAsset = assetId ? usableAssets.find((asset) => String(asset.id) === assetId) : undefined;

  if (assetId && !selectedAsset) {
    return NextResponse.json({ error: "Selected equipment is not available at CMPRI." }, { status: 404 });
  }

  if (selectedAsset) {
    async function readCache(cacheKey?: string | null) {
      const key = String(cacheKey || "").trim();
      if (!key) return null;
      const { data, error } = await dataClient
        .from("troubleshooting_cache")
        .select("payload")
        .eq("hotel_id", HOTEL_ID)
        .eq("cache_key", key)
        .maybeSingle();
      if (error) return null;
      return (data?.payload || null) as KnowledgePayload | null;
    }

    manualKnowledge = await readCache(selectedAsset.documentation_key);

    if (!manualKnowledge) {
      const { data: docs, error: docsError } = await dataClient
        .from("maintenance_documents")
        .select("document_key, title, document_type, manufacturer, equipment, model_pattern, troubleshooting_cache_key")
        .eq("hotel_id", HOTEL_ID)
        .eq("active", true);

      if (!docsError) {
        const manufacturer = String(selectedAsset.manufacturer || "").toLowerCase().trim();
        const model = String(selectedAsset.model_number || "").trim();
        const assetText = [
          selectedAsset.name,
          selectedAsset.asset_type,
          selectedAsset.manufacturer,
          selectedAsset.model_number,
          selectedAsset.asset_tag,
        ].filter(Boolean).join(" ").toLowerCase();

        const ranked = (docs ?? [])
          .map((doc) => {
            const docManufacturer = String(doc.manufacturer || "").toLowerCase().trim();
            const docEquipment = String(doc.equipment || "").toLowerCase();
            const docModelPattern = String(doc.model_pattern || "").trim();
            const modelSpecific = normalizedModelPattern(docModelPattern).length > 0;
            const confirmedModelMatch = modelMatchesPattern(model, docModelPattern);

            // Never let a manufacturer/equipment-name match activate a
            // model-specific manual when the asset model is unknown or does
            // not match. This prevents cross-model procedures/specifications
            // from leaking into otherwise similar equipment.
            if (modelSpecific && !confirmedModelMatch) {
              return { doc, score: -1 };
            }

            let score = 0;
            if (manufacturer && docManufacturer === manufacturer) score += 80;
            if (confirmedModelMatch) score += 140;
            if (docEquipment && assetText.includes(docEquipment)) score += 40;
            const words = docEquipment.split(/[^a-z0-9]+/).filter((word) => word.length >= 4);
            score += words.filter((word) => assetText.includes(word)).length * 5;
            return { doc, score };
          })
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score);

        const best = ranked[0]?.doc;
        if (best) {
          manualKnowledge =
            (await readCache(best.troubleshooting_cache_key)) ||
            (await readCache(best.document_key));
        }

        // Last-resort cache matching is deliberately strict. A bare
        // manufacturer match is not enough to activate structured technical
        // knowledge because many manufacturers have multiple unrelated model
        // families. Exact documentation_key remains authoritative; otherwise
        // a recorded asset model must appear in the cache identity text.
        if (!manualKnowledge && model) {
          const { data: cacheRows, error: cacheError } = await dataClient
            .from("troubleshooting_cache")
            .select("cache_key, payload")
            .eq("hotel_id", HOTEL_ID);

          if (!cacheError) {
            const normalizedAssetModel = normalizedModel(model);
            const fallback = (cacheRows ?? [])
              .map((row) => {
                const payload = (row.payload || {}) as KnowledgePayload;
                const source = payload.source && typeof payload.source === "object" ? payload.source : {};
                const cacheKey = String(row.cache_key || "").toLowerCase();
                const payloadText = [
                  payload.manufacturer,
                  payload.equipment,
                  source.title,
                  cacheKey,
                ].filter(Boolean).join(" ").toLowerCase();
                const normalizedPayloadText = payloadText.replace(/[^a-z0-9]+/g, "");
                let score = 0;
                const documentationKey = String(selectedAsset.documentation_key || "").toLowerCase();
                if (documentationKey && cacheKey === documentationKey) score += 200;
                if (normalizedAssetModel && normalizedPayloadText.includes(normalizedAssetModel)) score += 140;
                return { payload, score };
              })
              .filter((item) => item.score >= 140)
              .sort((a, b) => b.score - a.score)[0];
            manualKnowledge = fallback?.payload ?? null;
          }
        }
      }
    }

    // Uploaded PDFs are trusted as source material only after the explicit
    // equipment-verification marker exists. Merely uploading a PDF never turns
    // unreviewed content into "verified" manufacturer guidance.
    const prefix = `${HOTEL_ID}/${assetId}`;
    const { data: storedDocs, error: storageError } = await dataClient.storage
      .from(DOCUMENTATION_BUCKET)
      .list(prefix, { limit: 100, sortBy: { column: "created_at", order: "desc" } });

    if (!storageError) {
      const files = storedDocs || [];
      const verified = files.some((file) => String(file.name || "") === VERIFY_MARKER);
      const firstPdf = files.find((file) =>
        file.name &&
        !String(file.name).startsWith("_cmpri-") &&
        String(file.name).toLowerCase().endsWith(".pdf"),
      );
      if (firstPdf) {
        const storagePath = `${prefix}/${firstPdf.name}`;
        const { data: signed } = await dataClient.storage
          .from(DOCUMENTATION_BUCKET)
          .createSignedUrl(storagePath, 60 * 60);
        if (signed?.signedUrl) {
          const source = manualKnowledge?.source && typeof manualKnowledge.source === "object"
            ? manualKnowledge.source
            : {};
          manualKnowledge = {
            ...(manualKnowledge || { manufacturer: "", equipment: "", error_codes: [], symptom_rules: [] }),
            source: {
              ...source,
              type: source.type || "Equipment Documentation",
              title: source.title || firstPdf.name.replace(/^\d+-/, ""),
              source_file_name: source.source_file_name || firstPdf.name,
              file_url: signed.signedUrl,
              verified,
            },
          };
        }
      }
    }

    manualKnowledge = enrichManualKnowledge(manualKnowledge);
  }

  return NextResponse.json({
    technicians,
    assets: usableAssets,
    manualKnowledge,
    can_edit_equipment: allows(auth.principal, "manage_assets"),
  }, { headers: { "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization" } });
}
