export type GssSnapshot = {
  period: "MTD" | "September" | "Wave to Date";
  sampleSize: number;
  scores: readonly [number, number, number, number, number, number];
  trend: "up" | "down";
};

// Transcribed from the CMPRI row in Taylor Johnson's four dated email reports.
// These are dated source snapshots, not weekly-only scores. Never aggregate them
// or infer comparisons across the September/October reporting-period reset.
export const verifiedGssReports: readonly { date: string; snapshots: readonly GssSnapshot[] }[] = [
  { date: "2026-10-12", snapshots: [
    { period: "MTD", sampleSize: 11, scores: [54.5, 40.0, 63.6, 72.7, 36.4, 11.1], trend: "down" },
    { period: "Wave to Date", sampleSize: 125, scores: [56.0, 58.7, 58.9, 64.2, 48.8, 46.1], trend: "down" },
  ] },
  { date: "2026-10-05", snapshots: [
    { period: "September", sampleSize: 32, scores: [59.4, 61.1, 59.4, 65.6, 46.9, 45.5], trend: "down" },
    { period: "Wave to Date", sampleSize: 115, scores: [56.5, 60.3, 58.8, 63.7, 50.4, 49.4], trend: "up" },
  ] },
  { date: "2026-09-28", snapshots: [
    { period: "MTD", sampleSize: 30, scores: [60.0, 64.7, 60.0, 66.7, 50.0, 45.0], trend: "up" },
    { period: "Wave to Date", sampleSize: 111, scores: [55.9, 60.7, 58.2, 63.3, 50.5, 49.4], trend: "up" },
  ] },
  { date: "2026-09-21", snapshots: [
    { period: "MTD", sampleSize: 20, scores: [55.0, 61.5, 60.0, 70.0, 50.0, 40.0], trend: "up" },
    { period: "Wave to Date", sampleSize: 101, scores: [54.5, 59.6, 58.0, 63.6, 50.5, 48.6], trend: "up" },
  ] },
];
