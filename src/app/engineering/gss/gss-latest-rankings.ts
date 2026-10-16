// Manually transcribed and checked against both October 12, 2026 source PNGs.
// Colors and trend arrows reproduce the source, not a derived calculation.
export type RankingRow = {
  property: string;
  sampleSize: number;
  scores: readonly [number, number, number, number, number, number];
  color: "green" | "clear" | "yellow" | "red";
  trend: "up" | "down";
};
export type Ranking = { period: "MTD" | "Wave to Date"; rows: readonly RankingRow[] };
export const latestRankings: readonly Ranking[] = [
  { period: "MTD", rows: [
    { property: "Residence Inn by Marriott Coralville (CIDVL)", sampleSize: 4, scores: [100.0,100.0,75.0,75.0,66.7,50.0], color: "green", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites Cambridge (PKBCB)", sampleSize: 8, scores: [75.0,100.0,87.5,75.0,75.0,20.0], color: "clear", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites Alpharetta Avalon Area (ATLFH)", sampleSize: 11, scores: [72.7,25.0,81.8,63.6,54.5,37.5], color: "clear", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites Minneapolis Downtown (MSPFD)", sampleSize: 11, scores: [72.7,100.0,81.8,81.8,81.8,55.6], color: "clear", trend: "up" },
    { property: "Residence Inn by Marriott Des Moines Downtown (DSMRD)", sampleSize: 7, scores: [71.4,66.7,100.0,85.7,85.7,66.7], color: "clear", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites Minneapolis Shakopee (MSPFK)", sampleSize: 10, scores: [70.0,100.0,80.0,90.0,80.0,75.0], color: "clear", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites Milwaukee Brookfield (MKEFB)", sampleSize: 9, scores: [66.7,37.5,66.7,55.6,66.7,50.0], color: "clear", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites St. Paul Eagan (MSPFG)", sampleSize: 23, scores: [65.2,62.5,78.3,78.3,65.2,61.5], color: "clear", trend: "down" },
    { property: "Aloft by Marriott Oklahoma City Downtown - Bricktown (OKCAL)", sampleSize: 12, scores: [58.3,75.0,63.6,72.7,63.6,75.0], color: "yellow", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites Coralville (CIDCO)", sampleSize: 7, scores: [57.1,25.0,57.1,57.1,42.9,60.0], color: "yellow", trend: "down" },
    { property: "Residence Inn by Marriott Champaign (CMPRI)", sampleSize: 11, scores: [54.5,40.0,63.6,72.7,36.4,11.1], color: "yellow", trend: "down" },
    { property: "SpringHill Suites by Marriott St. Paul Arden Hills (MSPST)", sampleSize: 8, scores: [50.0,50.0,71.4,71.4,57.1,50.0], color: "red", trend: "down" },
    { property: "Fairfield by Marriott Inn & Suites Cedar Rapids (CIDCR)", sampleSize: 5, scores: [40.0,50.0,40.0,60.0,40.0,66.7], color: "red", trend: "down" },
    { property: "Le Méridien St. Louis Downtown (STLMO)", sampleSize: 6, scores: [16.7,0.0,0.0,16.7,0.0,0.0], color: "red", trend: "up" },
    { property: "Residence Inn by Marriott Cedar Rapids South (CIDCS)", sampleSize: 1, scores: [0.0,100.0,0.0,100.0,0.0,100.0], color: "red", trend: "down" },
  ] },
  { period: "Wave to Date", rows: [
    { property: "Fairfield by Marriott Inn & Suites Cambridge (PKBCB)", sampleSize: 142, scores: [72.5,86.7,82.1,84.1,75.0,50.0], color: "clear", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites St. Paul Eagan (MSPFG)", sampleSize: 226, scores: [66.8,43.2,80.7,75.8,73.9,40.0], color: "clear", trend: "down" },
    { property: "Fairfield by Marriott Inn & Suites Alpharetta Avalon Area (ATLFH)", sampleSize: 110, scores: [64.5,66.7,68.2,67.3,62.7,52.1], color: "clear", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites Minneapolis Downtown (MSPFD)", sampleSize: 129, scores: [64.3,73.5,73.0,74.6,70.4,44.6], color: "clear", trend: "up" },
    { property: "Residence Inn by Marriott Des Moines Downtown (DSMRD)", sampleSize: 141, scores: [61.7,64.3,70.1,75.4,64.0,55.4], color: "clear", trend: "up" },
    { property: "SpringHill Suites by Marriott St. Paul Arden Hills (MSPST)", sampleSize: 133, scores: [60.9,50.0,68.5,73.4,62.2,48.5], color: "yellow", trend: "down" },
    { property: "Fairfield by Marriott Inn & Suites Minneapolis Shakopee (MSPFK)", sampleSize: 138, scores: [58.0,67.4,65.7,72.3,62.0,33.3], color: "yellow", trend: "up" },
    { property: "Residence Inn by Marriott Cedar Rapids South (CIDCS)", sampleSize: 45, scores: [57.8,70.8,61.4,63.6,45.5,62.5], color: "yellow", trend: "down" },
    { property: "Fairfield by Marriott Inn & Suites Coralville (CIDCO)", sampleSize: 124, scores: [56.5,48.1,67.2,72.5,56.7,55.3], color: "yellow", trend: "up" },
    { property: "Residence Inn by Marriott Champaign (CMPRI)", sampleSize: 125, scores: [56.0,58.7,58.9,64.2,48.8,46.1], color: "yellow", trend: "down" },
    { property: "Residence Inn by Marriott Coralville (CIDVL)", sampleSize: 85, scores: [52.9,52.6,51.8,61.9,45.1,53.7], color: "red", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites Cedar Rapids (CIDCR)", sampleSize: 94, scores: [50.0,62.3,59.1,63.0,53.3,39.3], color: "red", trend: "down" },
    { property: "Aloft by Marriott Oklahoma City Downtown - Bricktown (OKCAL)", sampleSize: 120, scores: [46.7,53.1,63.2,60.7,55.6,55.2], color: "red", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites Milwaukee Brookfield (MKEFB)", sampleSize: 162, scores: [36.4,33.3,45.2,46.5,40.1,24.3], color: "red", trend: "up" },
    { property: "Le Méridien St. Louis Downtown (STLMO)", sampleSize: 45, scores: [8.9,30.3,20.5,29.5,6.8,8.7], color: "red", trend: "up" },
  ] },
];

