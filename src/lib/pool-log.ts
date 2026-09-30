export const CMPRI_POOL = {
  inspectionVolumeGallons: 17_909,
  dosingBasisGallons: 20_000,
  requiredFlowGpm: 48,
  observedFlowGpm20260623: 80,
  sanitizer: "Bromine",
  testKit: "Taylor K-2005 Complete DPD Pool Test Kit",
} as const;

export const poolReadings = [
  ["ph_am", "AM pH"],
  ["sanitizer_am", "AM bromine (ppm)"],
  ["ph_pm", "PM pH"],
  ["sanitizer_pm", "PM bromine (ppm)"],
  ["flow_rate_gpm", "Flow rate (gpm)"],
  ["temperature_f", "Water temperature (°F)"],
  ["combined_chlorine_ppm", "Combined chlorine (ppm), if recorded"],
  ["cyanuric_acid_ppm", "Cyanuric acid (ppm), if recorded"],
] as const;

export const bromineBands = [
  ["0", "0 ppm"],
  ["1-2", "1–2 ppm"],
  ["2-4", "2–4 ppm"],
  ["3-6", "3–6 ppm"],
  ["5-10", "5–10 ppm"],
  ["7.5-15", "7.5–15 ppm"],
  ["10-20", "10–20 ppm"],
] as const;

export const phReadings = ["7.0", "7.2", "7.4", "7.6", "7.8", "8.0"] as const;

const closingBromineBands = new Set(["0", "1-2", "7.5-15", "10-20"]);

export function poolClosureReasons(readings: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  for (const period of ["am", "pm"] as const) {
    const label = period.toUpperCase();
    const rawPh = readings[`ph_${period}`];
    const ph = typeof rawPh === "number" || (typeof rawPh === "string" && rawPh.trim() !== "")
      ? Number(rawPh)
      : NaN;
    if (Number.isFinite(ph) && (ph < 7.2 || ph > 7.8)) {
      reasons.push(`${label} pH ${ph.toFixed(1)} is outside 7.2–7.8`);
    }

    const band = readings[`sanitizer_band_${period}`];
    const legacy = readings[`sanitizer_${period}`];
    if (typeof band === "string" && closingBromineBands.has(band)) {
      const option = bromineBands.find(([value]) => value === band);
      reasons.push(`${label} bromine ${option?.[1] ?? band} requires closure`);
    } else {
      const legacyValue = typeof band === "string" && band.startsWith("legacy:")
        ? Number(band.slice("legacy:".length))
        : legacy;
      if (typeof legacyValue === "number" && Number.isFinite(legacyValue) && (legacyValue <= 2 || legacyValue >= 7.5)) {
        reasons.push(`${label} bromine ${legacyValue} ppm is outside 2–7.5 ppm`);
      }
    }
  }
  return reasons;
}

export const poolLocationReadings = [
  ["ph_shallow_am", "AM shallow pH"],
  ["sanitizer_shallow_am", "AM shallow bromine (ppm)"],
  ["ph_deep_am", "AM deep pH"],
  ["sanitizer_deep_am", "AM deep bromine (ppm)"],
  ["ph_shallow_pm", "PM shallow pH"],
  ["sanitizer_shallow_pm", "PM shallow bromine (ppm)"],
  ["ph_deep_pm", "PM deep pH"],
  ["sanitizer_deep_pm", "PM deep bromine (ppm)"],
] as const;

/**
 * CMPRI takes ONE physical sample per period at a chosen location (shallow or
 * deep). The single reading is reported at that location column, while the
 * other location column stays empty. Historical rows that pre-date this rule
 * remain readable from their stored location columns.
 */
export function poolLocationValue(log: Record<string, unknown>, key: string): unknown {
  const match = key.match(/^(ph|sanitizer)_(shallow|deep)_(am|pm)$/);
  if (!match) return log[key] ?? null;
  const [, reading, location, period] = match;
  const stored = log[key];
  if (stored != null && stored !== "") return stored;
  const sampleLocation = log[`sample_location_${period}`];
  if (sampleLocation === location) {
    const generic = reading === "sanitizer"
      ? log[`sanitizer_band_${period}`] ?? log[`sanitizer_${period}`]
      : log[`${reading}_${period}`];
    return generic ?? null;
  }
  return null;
}

export function validLogDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

type McpPoolFacility = {
  id: string;
  pool_name?: string | null;
  facility_name?: string | null;
};

function normalizedPoolName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function prepareMcpPoolLogInput(
  input: Record<string, unknown>,
  facilities: readonly McpPoolFacility[],
) {
  const logDate = input.log_date ?? input.date;
  if (!validLogDate(logDate)) {
    throw new Error("Pool-log date must use YYYY-MM-DD. Use the date returned by the pool-log read.");
  }

  const selected = typeof input.pool_facility_id === "string" && /^[a-f0-9-]{36}$/i.test(input.pool_facility_id)
    ? input.pool_facility_id
    : input.pool ?? input.pool_name ?? input.facility_name ?? input.facility ?? input.pool_facility_id;
  const selection = selected && typeof selected === "object" && !Array.isArray(selected)
    ? selected as Record<string, unknown>
    : null;
  const identifier = selection?.id ?? (typeof selected === "string" ? selected : null);
  const name = selection?.pool_name ?? selection?.facility_name
    ?? (typeof selected === "string" ? selected : null);

  let facility: McpPoolFacility | undefined;
  if (typeof identifier === "string" && /^[a-f0-9-]{36}$/i.test(identifier)) {
    facility = facilities.find((candidate) => candidate.id === identifier);
  } else if (typeof name === "string" && name.trim()) {
    const poolName = normalizedPoolName(name);
    const matches = facilities.filter((candidate) =>
      [candidate.pool_name, candidate.facility_name]
        .some((candidateName) => typeof candidateName === "string" && normalizedPoolName(candidateName) === poolName));
    if (matches.length > 1) throw new Error(`More than one active pool matches "${name}". Specify the exact pool.`);
    facility = matches[0];
  }

  if (!facility) {
    throw new Error("Select an active pool by its name or the pool id returned by the pool-log read.");
  }
  for (const field of ["requires_attention", "closure_condition"] as const) {
    if (typeof input[field] !== "boolean") {
      throw new Error(`Include an explicit true or false value for ${field}; false is valid.`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "test_entry") && typeof input.test_entry !== "boolean") {
    throw new Error("test_entry must be true or false.");
  }

  const readings = { ...input };
  delete readings.date;
  delete readings.pool;
  delete readings.pool_name;
  delete readings.facility_name;
  delete readings.facility;
  const testEntry = readings.test_entry === true;
  delete readings.test_entry;
  if (testEntry && readings.remarks === undefined) {
    readings.remarks = "Test entry";
  } else if (testEntry && typeof readings.remarks === "string") {
    const existingRemarks = readings.remarks.trim();
    readings.remarks = existingRemarks ? `${existingRemarks}\nTest entry` : "Test entry";
  } else if (readings.remarks === undefined) {
    readings.remarks = "";
  }
  return {
    ...readings,
    log_date: logDate,
    pool_facility_id: facility.id,
    requires_attention: input.requires_attention,
    closure_condition: input.closure_condition,
  };
}

function numericReading(value: unknown, key: string) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Enter a valid number for ${key.replaceAll("_", " ")}.`);
  if (key.startsWith("ph_") && value > 14) throw new Error("pH must be between 0 and 14.");
  if (!key.startsWith("ph_") && value > 1_000_000) throw new Error(`Enter a valid number for ${key.replaceAll("_", " ")}.`);
  return value;
}

function bromineBand(value: unknown, key: string) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !bromineBands.some(([option]) => option === value)) {
    throw new Error(`Select a valid bromine range for ${key.replaceAll("_", " ")}.`);
  }
  return value;
}

export function poolLogInput(body: Record<string, unknown>) {
  if (!validLogDate(body.log_date) || typeof body.pool_facility_id !== "string" || !/^[a-f0-9-]{36}$/i.test(body.pool_facility_id)) {
    throw new Error("Select a valid date and pool.");
  }
  const row: Record<string, unknown> = {
    log_date: body.log_date,
    pool_facility_id: body.pool_facility_id,
  };

  for (const [key] of poolReadings) {
    if (key === "sanitizer_am" || key === "sanitizer_pm") continue;
    row[key] = numericReading(body[key], key);
  }

  for (const period of ["am", "pm"] as const) {
    const ph = row[`ph_${period}`];
    const numericBromine = numericReading(body[`sanitizer_${period}`], `sanitizer_${period}`);
    const selectedBand = bromineBand(body[`sanitizer_band_${period}`], `sanitizer_band_${period}`);
    if (numericBromine != null && selectedBand != null) {
      throw new Error(`${period.toUpperCase()} sample cannot contain both a numeric bromine reading and a selected range.`);
    }
    const bromine = selectedBand ?? numericBromine;
    if ((ph == null) !== (bromine == null)) {
      throw new Error(`${period.toUpperCase()} completion requires both pH and bromine from the same physical sample.`);
    }
    row[`sanitizer_${period}`] = numericBromine;
    row[`sanitizer_band_${period}`] = selectedBand;
    const location = body[`sample_location_${period}`];
    if (ph == null) {
      row[`sample_location_${period}`] = null;
    } else {
      if (location !== "shallow" && location !== "deep") {
        throw new Error(`Select shallow or deep for the ${period.toUpperCase()} sample.`);
      }
      row[`sample_location_${period}`] = location;
    }
  }

  for (const key of ["main_drain_visible", "filter_backwashed"]) {
    if (body[key] !== true && body[key] !== false && body[key] != null) {
      throw new Error("Select Yes, No, or Not recorded for each check.");
    }
    row[key] = body[key] ?? null;
  }
  for (const key of ["requires_attention", "closure_condition"]) {
    if (typeof body[key] !== "boolean") throw new Error("Record attention and closure status.");
    row[key] = body[key];
  }
  if (poolClosureReasons(row).length) row.closure_condition = true;
  if (typeof body.remarks !== "string" || body.remarks.length > 20_000) throw new Error("Remarks must be text, up to 20,000 characters.");
  row.remarks = body.remarks.trim();

  const hasSample = row.ph_am != null || row.ph_pm != null;
  const hasOtherReading = ["flow_rate_gpm", "temperature_f", "combined_chlorine_ppm", "cyanuric_acid_ppm"].some((key) => row[key] != null);
  if (!hasSample && !hasOtherReading && !row.remarks && row.closure_condition !== true) {
    throw new Error("Enter an AM/PM sample, another reading, closure condition, or remarks before saving.");
  }
  return row;
}

export function sampleComplete(log: Record<string, unknown>, period: "am" | "pm") {
  return log[`ph_${period}`] != null
    && (log[`sanitizer_${period}`] != null || log[`sanitizer_band_${period}`] != null);
}
