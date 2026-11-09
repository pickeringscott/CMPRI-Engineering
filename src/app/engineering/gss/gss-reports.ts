export type GssSnapshot = {
  period: string;
  sampleSize: number;
  scores: readonly [number, number, number, number, number, number];
  trend: "up" | "down" | "flat";
};

// Transcribed from the CMPRI row in Taylor Johnson's dated email reports.
// These are source snapshots, not weekly-only scores. Do not aggregate them
// or infer comparisons across reporting-period resets.
export const verifiedGssReports: readonly { date: string; snapshots: readonly GssSnapshot[] }[] = [
  { date: "2026-11-09", snapshots: [
    { period: "MTD", sampleSize: 6, scores: [83.3, 75.0, 83.3, 100.0, 66.7, 66.7], trend: "up" },
    { period: "Wave to Date", sampleSize: 151, scores: [55.6, 59.5, 59.3, 66.4, 47.7, 47.7], trend: "up" },
  ] },
  { date: "2026-11-02", snapshots: [
    { period: "October", sampleSize: 31, scores: [48.4, 50.0, 58.1, 71.0, 35.5, 38.5], trend: "down" },
    { period: "Wave to Date", sampleSize: 145, scores: [54.5, 58.6, 58.3, 65.0, 46.9, 47.2], trend: "down" },
  ] },
  { date: "2026-10-26", snapshots: [
    { period: "MTD", sampleSize: 24, scores: [50.0, 50.0, 58.3, 66.7, 33.3, 40.0], trend: "flat" },
    { period: "Wave to Date", sampleSize: 138, scores: [55.1, 58.8, 58.4, 64.0, 47.1, 48.0], trend: "down" },
  ] },
  { date: "2026-10-19", snapshots: [
    { period: "MTD", sampleSize: 16, scores: [50.0, 42.9, 62.5, 68.8, 37.5, 35.7], trend: "down" },
    { period: "Wave to Date", sampleSize: 130, scores: [55.4, 58.5, 58.9, 64.1, 48.4, 47.9], trend: "down" },
  ] },
];
