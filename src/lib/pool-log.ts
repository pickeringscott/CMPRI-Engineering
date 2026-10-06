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
  ["flow_rate_gpm", "Flow rate (GPM)"],
  ["temperature_f", "Water temperature (°F)"],
] as const;

/** Checks recorded once per day on the daily log (not with every AM/PM sample). */
export const dailyPoolChecks = [
  ["temperature_f", "Water temperature"],
  ["flow_rate_gpm", "Flow rate"],
  ["main_drain_visible", "Main drain visible"],
  ["filter_backwashed", "Filter backwashed"],
] as const;

/** One physical sample per test; its reading is recorded for both shallow and deep. */
export const sampleLocations = [
  ["shallow", "Shallow"],
  ["deep", "Deep"],
] as const;

export const MAX_POOL_TEMPERATURE_F = 104;

export function sampleLocationLabel(value: unknown) {
  if (value === "middle") return "Middle of pool (historical)";
  return sampleLocations.find(([option]) => option === value)?.[1] ?? (value == null || value === "" ? "—" : String(value));
}

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

function readingNumber(value: unknown) {
  return typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : NaN;
}

function readingFlag(value: unknown) {
  return value === true || value === "true" ? true : value === false || value === "false" ? false : null;
}

/** Readings that require the pool to be closed. */
export function poolClosureReasons(readings: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  for (const period of ["am", "pm"] as const) {
    const label = period.toUpperCase();
    const ph = readingNumber(readings[`ph_${period}`]);
    if (Number.isFinite(ph) && (ph < 7.2 || ph > 7.8)) {
      reasons.push(`${label} pH ${ph.toFixed(1)} is outside 7.2–7.8`);
    }

    const band = readings[`sanitizer_band_${period}`];
    const legacy = readings[`sanitizer_${period}`];
    if (typeof band === "string" && closingBromineBands.has(band)) {
      const option = bromineBands.find(([value]) => value === band);
      reasons.push(`${label} bromine ${option?.[1] ?? band} is outside the safe range (above 2 and below 7.5 ppm)`);
    } else {
      const legacyValue = typeof band === "string" && band.startsWith("legacy:")
        ? Number(band.slice("legacy:".length))
        : readingNumber(legacy);
      if (Number.isFinite(legacyValue) && (legacyValue <= 2 || legacyValue >= 7.5)) {
        reasons.push(`${label} bromine ${legacyValue} ppm is outside 2–7.5 ppm`);
      }
    }
  }
  if (readingFlag(readings.main_drain_visible) === false) {
    reasons.push("Main drain is not visible");
  }
  const temperature = readingNumber(readings.temperature_f);
  if (Number.isFinite(temperature) && temperature > MAX_POOL_TEMPERATURE_F) {
    reasons.push(`Water temperature ${temperature}°F is above ${MAX_POOL_TEMPERATURE_F}°F`);
  }
  return reasons;
}

/** Out-of-range readings that must be flagged but do not by themselves close the pool. */
export function poolReadingWarnings(readings: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const flow = readingNumber(readings.flow_rate_gpm);
  if (Number.isFinite(flow) && flow < CMPRI_POOL.requiredFlowGpm) {
    warnings.push(`Flow rate ${flow} GPM is below the required ${CMPRI_POOL.requiredFlowGpm} GPM`);
  }
  return warnings;
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
 * CMPRI takes one physical water sample per AM/PM test. The same reading is
 * recorded for both the shallow and deep fields. Historical rows remain
 * readable from their stored columns.
 */
export function poolLocationValue(log: Record<string, unknown>, key: string): unknown {
  const match = key.match(/^(ph|sanitizer)_(shallow|middle|deep)_(am|pm)$/);
  if (!match) return log[key] ?? null;
  const [, reading, location, period] = match;
  const stored = log[key];
  if (stored != null && stored !== "") return stored;
  const sampleLocation = log[`sample_location_${period}`];
  if (location === "middle" ? sampleLocation === "middle" : sampleLocation != null && sampleLocation !== "") {
    const generic = reading === "sanitizer"
      ? log[`sanitizer_band_${period}`] ?? log[`sanitizer_${period}`]
      : log[`${reading}_${period}`];
    return generic ?? null;
  }
  return null;
}

export function poolLogTodayDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
}

export function validLogDate(value: unknown, today = poolLogTodayDate()): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value <= today;
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
    throw new Error("Pool-log date must use an allowed YYYY-MM-DD date that is not in the future.");
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
  for (const field of ["requires_attention", "closure_condition", "main_drain_visible", "filter_backwashed"] as const) {
    if (input[field] !== undefined && input[field] !== null && typeof input[field] !== "boolean") {
      throw new Error(`Use true or false for ${field.replaceAll("_", " ")}; false is valid.`);
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
  if (readings.closure_reason === undefined) readings.closure_reason = "";
  return {
    ...readings,
    log_date: logDate,
    pool_facility_id: facility.id,
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

export class PoolLogConflictError extends Error {}

function providedValue(value: unknown) {
  return value !== undefined && value !== null && value !== "";
}

function sameReading(a: unknown, b: unknown) {
  if (a == null || a === "") return b == null || b === "";
  if (b == null || b === "") return false;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return a === b;
}

function displayReading(value: unknown) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return bromineBands.find(([band]) => band === value)?.[1] ?? sampleLocationLabel(value);
}

const mergeLabels: Record<string, string> = {
  flow_rate_gpm: "Flow rate",
  temperature_f: "Water temperature",
  main_drain_visible: "Main drain visible",
  filter_backwashed: "Filter backwashed",
};

/**
 * Combines a new save with the day's saved log so a later sample (for example
 * PM, including by voice) never erases readings that were already saved.
 * Omitted or blank values keep the saved value. Only System Administrators may
 * change a saved value; for everyone else a different value is a conflict.
 * Remarks and closure reasons are appended instead of replaced.
 */
export function mergePoolLogBody(
  existing: Record<string, unknown>,
  body: Record<string, unknown>,
  isSystemAdmin: boolean,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...body };
  const blocked: string[] = [];
  const take = (key: string, label: string, next: unknown) => {
    const saved = existing[key];
    if (saved == null || saved === "") { merged[key] = providedValue(next) ? next : null; return; }
    if (!providedValue(next) || sameReading(saved, next)) { merged[key] = saved; return; }
    if (!isSystemAdmin) {
      blocked.push(`${label} (saved as ${displayReading(saved)})`);
      merged[key] = saved;
      return;
    }
    merged[key] = next;
  };

  for (const period of ["am", "pm"] as const) {
    const label = period.toUpperCase();
    const bandKey = `sanitizer_band_${period}`;
    const numericKey = `sanitizer_${period}`;
    const bodyHasSample = [`ph_${period}`, bandKey, numericKey].some((key) => providedValue(body[key]));
    take(`ph_${period}`, `${label} pH`, body[`ph_${period}`]);

    const savedBand = existing[bandKey];
    const savedNumeric = existing[numericKey];
    const nextBand = providedValue(body[bandKey]) ? body[bandKey] : null;
    const nextNumeric = nextBand == null && providedValue(body[numericKey]) ? body[numericKey] : null;
    const savedBromine = providedValue(savedBand) ? savedBand : savedNumeric;
    const nextBromine = nextBand ?? nextNumeric;
    if (!providedValue(savedBromine) || !providedValue(nextBromine) || sameReading(savedBromine, nextBromine)) {
      merged[bandKey] = providedValue(savedBromine) ? savedBand ?? null : nextBand;
      merged[numericKey] = providedValue(savedBromine) ? savedNumeric ?? null : nextNumeric;
    } else if (!isSystemAdmin) {
      blocked.push(`${label} bromine (saved as ${displayReading(savedBromine)})`);
      merged[bandKey] = savedBand ?? null;
      merged[numericKey] = savedNumeric ?? null;
    } else {
      merged[bandKey] = nextBand;
      merged[numericKey] = nextNumeric;
    }

    const periodLocation = body[`sample_location_${period}`];
    const nextLocation = providedValue(periodLocation) ? periodLocation : bodyHasSample ? body.sample_location : null;
    take(`sample_location_${period}`, `${label} sample location`, nextLocation);
  }

  for (const [key, label] of Object.entries(mergeLabels)) take(key, label, body[key]);

  for (const key of ["requires_attention", "closure_condition"] as const) {
    const saved = existing[key] === true;
    merged[key] = isSystemAdmin && typeof body[key] === "boolean" ? body[key] : saved || body[key] === true;
  }

  for (const key of ["remarks", "closure_reason"] as const) {
    const saved = typeof existing[key] === "string" ? existing[key].trim() : "";
    const next = typeof body[key] === "string" ? body[key].trim() : "";
    merged[key] = !next ? saved : !saved || next.startsWith(saved) ? next : `${saved}\n${next}`;
  }

  if (blocked.length) {
    throw new PoolLogConflictError(
      `Already saved for this date, and only a System Administrator can change it: ${blocked.join("; ")}. Nothing was saved.`,
    );
  }
  delete merged.sample_location;
  return merged;
}

export function poolLogInput(body: Record<string, unknown>, existing: Record<string, unknown> | null = null) {
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
    const label = period.toUpperCase();
    const ph = row[`ph_${period}`];
    const numericBromine = numericReading(body[`sanitizer_${period}`], `sanitizer_${period}`);
    const selectedBand = bromineBand(body[`sanitizer_band_${period}`], `sanitizer_band_${period}`);
    if (numericBromine != null && selectedBand != null) {
      throw new Error(`${label} sample cannot contain both a numeric bromine reading and a selected range.`);
    }
    const bromine = selectedBand ?? numericBromine;
    row[`sanitizer_${period}`] = numericBromine;
    row[`sanitizer_band_${period}`] = selectedBand;
    if (ph == null && bromine == null) {
      row[`sample_location_${period}`] = null;
      continue;
    }
    if (ph == null) throw new Error(`${label} sample needs its pH reading. pH and bromine come from the same water sample.`);
    if (bromine == null) throw new Error(`${label} sample needs its bromine reading. pH and bromine come from the same water sample.`);
    const periodLocation = body[`sample_location_${period}`];
    const location = providedValue(periodLocation) ? periodLocation : body.sample_location;
    const historicalMiddle = location === "middle" && existing?.[`sample_location_${period}`] === "middle";
    if (!historicalMiddle && !sampleLocations.some(([option]) => option === location)) {
      throw new Error(`Select where the ${label} sample was taken: shallow or deep.`);
    }
    row[`sample_location_${period}`] = location;
  }
  if (row.ph_am == null && row.ph_pm == null) {
    throw new Error("Record the AM or PM water sample (pH, bromine, and sample location) before saving.");
  }

  for (const key of ["main_drain_visible", "filter_backwashed"]) {
    const value = body[key];
    if (value !== true && value !== false && providedValue(value)) {
      throw new Error(`Select Yes or No for ${key.replaceAll("_", " ")}.`);
    }
    row[key] = value === true || value === false ? value : null;
  }
  const missingDailyChecks = dailyPoolChecks.filter(([key]) => row[key] == null).map(([, label]) => label.toLowerCase());
  if (missingDailyChecks.length) {
    throw new Error(`Record today's daily checks before saving: ${missingDailyChecks.join(", ")}.`);
  }

  for (const key of ["requires_attention", "closure_condition"]) {
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "boolean") {
      throw new Error("Record attention and closure status as Yes or No.");
    }
    row[key] = body[key] === true;
  }
  const closureReasons = poolClosureReasons(row);
  if (closureReasons.length) row.closure_condition = true;
  const remarks = body.remarks ?? "";
  if (typeof remarks !== "string" || remarks.length > 20_000) throw new Error("Remarks must be text, up to 20,000 characters.");
  row.remarks = remarks.trim();
  const closureReason = body.closure_reason ?? "";
  if (typeof closureReason !== "string" || closureReason.length > 2_000) {
    throw new Error("Enter a pool-closure reason, up to 2,000 characters.");
  }
  row.closure_reason = closureReason.trim() || null;
  if (row.closure_condition === true && !row.closure_reason) {
    throw new Error(closureReasons.length
      ? `The pool must be closed: ${closureReasons.join("; ")}. Enter the reason the pool is closed and the actions taken before saving.`
      : "Enter a reason whenever the pool is closed.");
  }
  return row;
}

/** True when a validated row would change the saved log. */
export function poolLogChanged(existing: Record<string, unknown>, row: Record<string, unknown>) {
  return Object.entries(row).some(([key, value]) => {
    const saved = existing[key];
    if (typeof value === "boolean" || typeof saved === "boolean") return saved !== value && !(saved == null && value == null);
    return !sameReading(saved, value);
  });
}

/** Summary for the web page and voice assistant of what the daily log still needs. */
export function poolLogStatus(log: Record<string, unknown> | null) {
  const values = log ?? {};
  const closureReasons = poolClosureReasons(values);
  return {
    am_sample_recorded: sampleComplete(values, "am"),
    pm_sample_recorded: sampleComplete(values, "pm"),
    daily_checks_missing: dailyPoolChecks.filter(([key]) => values[key] == null).map(([, label]) => label),
    closure_required: closureReasons.length > 0 || values.closure_condition === true,
    closure_reasons: closureReasons,
    warnings: poolReadingWarnings(values),
  };
}

export function sampleComplete(log: Record<string, unknown>, period: "am" | "pm") {
  return log[`ph_${period}`] != null
    && (log[`sanitizer_${period}`] != null || log[`sanitizer_band_${period}`] != null);
}
