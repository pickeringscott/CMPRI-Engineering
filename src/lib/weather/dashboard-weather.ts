type Json = Record<string, unknown>;
type Product = {
  status: "live" | "stale" | "unavailable";
  sourceTimestamp: string | null;
  data: Json | null;
};

export type DashboardWeather = {
  current: number | null;
  high: number | null;
  low: number | null;
  precipitation: number | null;
  wind: number | null;
  bearing: number | null;
  condition: string | null;
  icon: string | null;
  isDaytime: boolean | null;
  observationTime: string | null;
  forecastTime: string | null;
  moonAngle: number | null;
};

function object(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function time(value: unknown) {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function unit(quantity: Json | null) {
  return String(quantity?.unitCode || quantity?.unit || "").split(":").at(-1);
}

function fahrenheit(value: unknown, code: unknown) {
  const temperature = number(value);
  if (temperature === null) return null;
  if (code === "degF" || code === "F") return temperature;
  if (code === "degC" || code === "C") return temperature * 9 / 5 + 32;
  return code === "K" ? (temperature - 273.15) * 9 / 5 + 32 : null;
}

function milesPerHour(value: unknown) {
  const quantity = object(value);
  const speed = number(quantity?.value);
  if (speed === null || speed < 0) return null;
  switch (unit(quantity)) {
    case "mi_h-1": case "mph": return speed;
    case "km_h-1": case "km/h": return speed / 1.609344;
    case "m_s-1": case "m/s": return speed * 2.2369362921;
    case "kn": case "kt": return speed * 1.150779448;
    default: return null;
  }
}

function gridIntervals(value: unknown) {
  const series = object(value);
  if (!Array.isArray(series?.values)) return [];
  const code = String(series.uom || "").split(":").at(-1);
  return series.values.slice(0, 2000).flatMap(raw => {
    const row = object(raw);
    if (typeof row?.validTime !== "string") return [];
    const [from, duration] = row.validTime.split("/");
    const start = time(from);
    const units = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration || "");
    const end = units ? start + (Number(units[1] || 0) * 86400 + Number(units[2] || 0) * 3600
      + Number(units[3] || 0) * 60 + Number(units[4] || 0)) * 1000 : time(duration);
    return start < end ? [{ start, end, value: row.value, code }] : [];
  });
}

export function dashboardWeather(observation: Product, hourly: Product, grid: Product, now: Date,
  dayStart: number, dayEnd: number, moonAngle: number | null): DashboardWeather {
  const observed = observation.status === "live" ? object(observation.data?.properties) : null;
  const forecast = hourly.status === "live" ? object(hourly.data?.properties) : null;
  const forecastGrid = grid.status === "live" ? object(grid.data?.properties) : null;
  const at = now.getTime();
  const temperature = object(observed?.temperature);
  const hours = Array.isArray(forecast?.periods) ? forecast.periods.slice(0, 2000).flatMap(raw => {
    const period = object(raw);
    const start = time(period?.startTime), end = time(period?.endTime);
    if (!period || !(start < end)) return [];
    const quantity = object(period.temperature);
    return [{ period, start, end, value: quantity
      ? fahrenheit(quantity.value, unit(quantity)) : fahrenheit(period.temperature, period.temperatureUnit) }];
  }) : [];
  const currentForecast = hours.find(hour => hour.start <= at && at < hour.end)?.period;
  const hourlyPrecipitation = number(object(currentForecast?.probabilityOfPrecipitation)?.value);
  const gridPrecipitation = gridIntervals(forecastGrid?.probabilityOfPrecipitation).find(item =>
    item.start <= at && at < item.end && ["percent", "%"].includes(item.code || ""));
  const gridChance = number(gridPrecipitation?.value);
  const precipitation = [hourlyPrecipitation, gridChance].find(value => value !== null && value >= 0 && value <= 100) ?? null;
  const temperatures = hours.filter(hour => hour.end > dayStart && hour.start < dayEnd).map(hour => hour.value);
  // The native dial uses grid data for unpublished hours; a covered hourly
  // period takes precedence over any overlapping grid temperature.
  const gridTemperatures = gridIntervals(forecastGrid?.temperature);
  for (let hour = dayStart; hour < dayEnd; hour += 3600000) {
    if (hours.some(period => period.value !== null && period.start <= hour && hour < period.end)) continue;
    const item = gridTemperatures.find(period => period.start <= hour && hour < period.end);
    if (item) temperatures.push(fahrenheit(item.value, item.code));
  }
  const values = temperatures.filter((value): value is number => value !== null);
  const bearing = number(object(observed?.windDirection)?.value);
  return {
    current: fahrenheit(temperature?.value, unit(temperature)),
    high: values.length ? Math.max(...values) : null,
    low: values.length ? Math.min(...values) : null,
    precipitation,
    wind: milesPerHour(observed?.windSpeed),
    bearing: bearing !== null && bearing >= 0 && bearing <= 360 ? bearing : null,
    condition: typeof observed?.textDescription === "string" ? observed.textDescription : null,
    icon: typeof observed?.icon === "string" ? observed.icon : null,
    isDaytime: typeof currentForecast?.isDaytime === "boolean" ? currentForecast.isDaytime : null,
    observationTime: observed ? observation.sourceTimestamp : null,
    forecastTime: forecast ? hourly.sourceTimestamp : forecastGrid ? grid.sourceTimestamp : null,
    moonAngle,
  };
}
