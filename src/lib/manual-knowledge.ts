export type ManualErrorCode = {
  code: string;
  problem: string;
  action: string;
  source_pages?: number[];
};

export type ManualSymptomRule = {
  match: string[];
  steps: string[];
  source_pages?: number[];
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
  manufacturer?: string;
  equipment?: string;
  model_family?: string;
  model_number?: string;
  source?: {
    type?: string;
    title?: string;
    verified?: boolean;
    manufacturer?: string;
    model_family?: string;
    source_file_name?: string;
    file_url?: string;
    pdf_url?: string;
  };
  error_codes?: ManualErrorCode[];
  symptom_rules?: ManualSymptomRule[];
  general_checks?: string[];
  manual_tests?: ManualTestEntry[];
};

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
            problem: String(item.problem ?? item.description ?? item.meaning ?? "").trim(),
            action: String(item.action ?? item.solution ?? item.corrective_action ?? "").trim(),
            source_pages: pageNumbers(item.source_pages ?? item.pages),
          };
        })
        .filter((item) => item.code && (item.problem || item.action))
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
    manufacturer: String(payload.manufacturer ?? ""),
    equipment: String(payload.equipment ?? payload.asset ?? ""),
    model_family: String(payload.model_family ?? source.model_family ?? ""),
    model_number: String(payload.model_number ?? source.model_number ?? ""),
    source: {
      type: String(source.type ?? payload.document_type ?? ""),
      title: String(source.title ?? payload.title ?? payload.document_title ?? ""),
      verified: (source.verified ?? payload.verified) === true,
      manufacturer: String(source.manufacturer ?? payload.manufacturer ?? ""),
      model_family: String(source.model_family ?? payload.model_family ?? ""),
      source_file_name: String(source.source_file_name ?? payload.source_file_name ?? ""),
      file_url: String(source.file_url ?? payload.file_url ?? ""),
      pdf_url: String(source.pdf_url ?? payload.pdf_url ?? ""),
    },
    error_codes,
    symptom_rules,
    general_checks,
    manual_tests,
  };
}
