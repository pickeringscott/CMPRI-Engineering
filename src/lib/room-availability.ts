export type RoomStatusBadge = {
  label: string;
  className: string;
  available: boolean;
};

export function roomKey(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const match = String(value).match(/\b(?:\d{2,4}|MGR)\b/i)?.[0] || "";
  return match.toUpperCase() === "MGR" ? "MGR" : match;
}

export function roomStatusBadge(status: string | null | undefined): RoomStatusBadge | null {
  const value = String(status || "").trim();
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (normalized.includes("vacant ready") || normalized === "vr") {
    return {
      label: "Available",
      className: "border-green-400/45 bg-green-950/35 text-green-200",
      available: true,
    };
  }
  if (normalized.includes("vacant dirty") || normalized === "vd") {
    return {
      label: value,
      className: "border-amber-400/45 bg-amber-950/35 text-amber-200",
      available: false,
    };
  }
  if (normalized === "ooo" || normalized.includes("out of order") || normalized.includes("out-of-order")) {
    return {
      label: value,
      className: "border-red-400/45 bg-red-950/35 text-red-200",
      available: false,
    };
  }
  return {
    label: value,
    className: "border-slate-600 bg-slate-900 text-slate-300",
    available: false,
  };
}
