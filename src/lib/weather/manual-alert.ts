const SEVERITIES = ["notice", "advisory", "watch", "warning"] as const;
const HEX = /^#[0-9a-f]{6}$/i;

export type WeatherManualAlert = {
  severity: typeof SEVERITIES[number];
  custom: boolean;
  text: string;
  override: boolean;
  attention: boolean;
  color: string;
  textColor: string;
  expires: number;
};

export function parseWeatherManualAlert(input: unknown, now = Date.now()): WeatherManualAlert | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const severity = SEVERITIES.find(entry => entry === value.severity);
  if (!severity || typeof value.text !== "string" || value.text.length > 2000
    || typeof value.color !== "string" || !HEX.test(value.color)
    || typeof value.textColor !== "string" || !HEX.test(value.textColor)
    || typeof value.expires !== "number" || !Number.isFinite(new Date(value.expires).getTime())
    || value.expires <= now) return null;
  const text = value.text.trim();
  const custom = value.custom === true;
  if (custom && !text) return null;
  return {
    severity, custom, text,
    override: value.override === true && severity !== "notice",
    attention: value.attention === true && (severity === "warning" || severity === "watch"),
    color: value.color, textColor: value.textColor, expires: value.expires,
  };
}
