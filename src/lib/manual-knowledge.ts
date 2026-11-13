import { sourcePageHtml } from './manual-document-html';
import type { SourcePassage } from "./manual-source";
export type ManualProvenance = { source_document_id?: string; source_sha256?: string };
export type TroubleshootingStepMedia = ManualProvenance & {
  id: string;
  stepLabel: string;
  sourcePage: number;
  caption: string;
  width: number;
  height: number;
};
export type ManualErrorCode = ManualProvenance & {
  code: string;
  subcode?: string;
  problem: string;
  action: string;
  unit_response?: string;
  source_pages?: number[];
  source_url?: string;
};

export type ManualSymptomRule = ManualProvenance & {
  match: string[];
  steps: string[];
  source_pages?: number[];
  source_url?: string;
  prerequisites?: string[];
  reference_only?: boolean;
};

export type ManualTestEntry = {
  title?: string;
  test?: string;
  action?: string;
  steps?: string[];
  match?: string[];
  source_pages?: number[];
};

export type ManualKnowledge = {
  sources?: NonNullable<ManualKnowledge["source"]>[];
  step_media?: TroubleshootingStepMedia[];
  source_passages?: SourcePassage[];
  manufacturer?: string;
  equipment?: string;
  model_family?: string;
  model_number?: string;
  source?: {
    sha256?: string;
    search_incomplete?: boolean;
    type?: string;
    title?: string;
    verified?: boolean;
    manufacturer?: string;
    model_family?: string;
    source_file_name?: string;
    file_url?: string;
    pdf_url?: string;
    source_kind?: string;
    storage_path?: string;
    registered_file_id?: string;
    registered_updated_at?: string | null;
    coverage?: { total_pages: number; indexed_pages: number; needs_ocr: number[]; warnings: string[] };
    page_labels?: Record<string, string>;
  };
  error_codes?: ManualErrorCode[];
  symptom_rules?: ManualSymptomRule[];
  general_checks?: string[];
  manual_tests?: ManualTestEntry[];
};

function provenance(item: Record<string, unknown>): ManualProvenance {
  return {
    ...(typeof item.source_document_id === 'string' ? { source_document_id: item.source_document_id } : {}),
    ...(typeof item.source_sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.source_sha256) ? { source_sha256: item.source_sha256 } : {}),
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pageNumbers(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter((page) => Number.isInteger(page) && page > 0) : [];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeManualTestEntry(entry: unknown): ManualTestEntry | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const item = objectRecord(entry);
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
    source_pages: pageNumbers(item.source_pages ?? item.pages),
  };
}

export function normalizeManualKnowledge(input: unknown): ManualKnowledge | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const payload = objectRecord(input);
  const source = objectRecord(payload.source ?? payload.document);
  const rawCodes = payload.error_codes ?? payload.errorCodes ?? payload.diagnostic_codes ?? [];
  const rawRules = payload.symptom_rules ?? payload.symptomRules ?? payload.troubleshooting ?? payload.guidance ?? [];
  const error_codes = Array.isArray(rawCodes)
    ? rawCodes
        .map((entry: unknown) => {
          const item = objectRecord(entry);
          return {
            code: String(item.code ?? item.id ?? "").trim(),
            ...(item.subcode ? { subcode: String(item.subcode) } : {}),
            problem: String(item.problem ?? item.description ?? item.meaning ?? "").trim(),
            action: String(item.action ?? item.solution ?? item.corrective_action ?? "").trim(),
            ...(item.unit_response ? { unit_response: String(item.unit_response) } : {}),
            source_pages: pageNumbers(item.source_pages ?? item.pages),
            ...provenance(item),
            ...(item.source_url ? { source_url: String(item.source_url) } : {}),
          };
        })
        .filter((item) => item.code && (item.problem || item.action || item.unit_response))
    : [];
  const symptom_rules = Array.isArray(rawRules)
    ? rawRules
        .map((entry: unknown) => {
          if (typeof entry === "string") return { match: [], steps: [entry] };
          const item = objectRecord(entry);
          const matchRaw = item.match ?? item.matches ?? item.symptoms ?? item.keywords ?? [];
          const stepsRaw = item.steps ?? item.actions ?? item.suggestions ?? item.troubleshooting ?? [];
          return {
            match: Array.isArray(matchRaw) ? matchRaw.map(String) : [String(matchRaw || "")].filter(Boolean),
            steps: Array.isArray(stepsRaw) ? stepsRaw.map(String) : [String(stepsRaw || "")].filter(Boolean),
            source_pages: pageNumbers(item.source_pages ?? item.pages),
            ...(Array.isArray(item.prerequisites) ? { prerequisites: stringList(item.prerequisites) } : {}),
            ...(item.reference_only === true ? { reference_only: true } : {}),
            ...provenance(item),
            ...(item.source_url ? { source_url: String(item.source_url) } : {}),
          };
        })
        .filter((item) => item.steps.length > 0)
    : [];

  const general_checks = stringList(payload.general_checks ?? payload.generalChecks ?? payload.general_checks_list ?? []);
  const rawManualTests: unknown[] = Array.isArray(payload.manual_tests)
    ? payload.manual_tests as unknown[]
    : Array.isArray(payload.manualTests)
      ? payload.manualTests as unknown[]
      : [];
  const manual_tests = rawManualTests
    .map((entry: unknown) => normalizeManualTestEntry(entry))
    .filter((entry): entry is ManualTestEntry => !!entry);

  return {
    sources: Array.isArray(payload.sources) ? payload.sources.flatMap(source => {
      const normalized = normalizeManualKnowledge({ source });
      return normalized?.source ? [normalized.source] : [];
    }) : undefined,
    step_media: Array.isArray(payload.step_media) ? payload.step_media.flatMap((entry) => {
      const item = objectRecord(entry);
      const sourcePage = Number(item.sourcePage), width = Number(item.width), height = Number(item.height);
      if (typeof item.id !== 'string' || !/^media-[a-f0-9]{64}$/.test(item.id) || typeof item.stepLabel !== 'string' || !item.stepLabel.trim()
        || typeof item.caption !== 'string' || !Number.isSafeInteger(sourcePage) || sourcePage < 1
        || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 || width * height > 4_000_000) return [];
      return [{ ...provenance(item), id: item.id, stepLabel: item.stepLabel, sourcePage, caption: item.caption, width, height }];
    }) : [],
    manufacturer: String(payload.manufacturer ?? ""),
    equipment: String(payload.equipment ?? payload.asset ?? ""),
    model_family: String(payload.model_family ?? source.model_family ?? ""),
    model_number: String(payload.model_number ?? source.model_number ?? ""),
    source: {
      ...(source.search_incomplete !== undefined ? { search_incomplete: source.search_incomplete === true } : {}),
      type: String(source.type ?? payload.document_type ?? ""),
      title: String(source.title ?? payload.title ?? payload.document_title ?? ""),
      verified: (source.verified ?? payload.verified) === true,
      manufacturer: String(source.manufacturer ?? payload.manufacturer ?? ""),
      model_family: String(source.model_family ?? payload.model_family ?? ""),
      source_file_name: String(source.source_file_name ?? payload.source_file_name ?? ""),
      file_url: String(source.file_url ?? payload.file_url ?? ""),
      pdf_url: String(source.pdf_url ?? payload.pdf_url ?? ""),
      ...(source.source_kind ? { source_kind: String(source.source_kind) } : {}),
      ...(source.storage_path ? { storage_path: String(source.storage_path) } : {}),
      ...(source.sha256 ? { sha256: String(source.sha256) } : {}),
      ...(source.registered_file_id ? { registered_file_id: String(source.registered_file_id) } : {}),
      ...(source.registered_updated_at !== undefined ? { registered_updated_at: source.registered_updated_at === null ? null : String(source.registered_updated_at) } : {}),
      ...(source.coverage && typeof source.coverage === 'object' && Number.isSafeInteger(objectRecord(source.coverage).total_pages) && Number.isSafeInteger(objectRecord(source.coverage).indexed_pages)
        ? { coverage:{total_pages:Number(objectRecord(source.coverage).total_pages),indexed_pages:Number(objectRecord(source.coverage).indexed_pages),needs_ocr:pageNumbers(objectRecord(source.coverage).needs_ocr).filter(p=>p<=10000),warnings:stringList(objectRecord(source.coverage).warnings)} } : {}),
      ...(source.page_labels && typeof source.page_labels === 'object' ? { page_labels:Object.fromEntries(Object.entries(source.page_labels).filter(([page,label])=>/^\d{1,5}$/.test(page)&&Number(page)<=10000&&typeof label==='string'&&label.length<=40)) as Record<string,string> } : {}),
    },
    source_passages: Array.isArray(payload.source_passages) ? payload.source_passages.filter((entry): entry is SourcePassage => {
      if (!entry || typeof entry !== "object") return false;
      const item = entry as SourcePassage;
      return Number.isInteger(item.page) && item.page > 0 && item.page <= 10000 && typeof item.text === "string" &&
        (item.kind === "diagnostic" || item.kind === "troubleshooting" || item.kind === "reference");
    }).map(item => typeof item.html === 'string' ? { ...item, html: sourcePageHtml(item.text, item.page, item.origin === 'reviewed' ? 'reviewed' : item.origin === 'ocr' ? 'ocr' : 'pdf') } : item) : [],
    error_codes,
    symptom_rules,
    general_checks,
    manual_tests,
  };
}
