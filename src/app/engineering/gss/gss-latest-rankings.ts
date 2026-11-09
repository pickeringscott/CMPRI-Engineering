// Manually transcribed and checked against both November 9, 2026 source PNGs.
// Colors and trend arrows reproduce the source, not a derived calculation.
export type RankingRow = {
  property: string;
  sampleSize: number;
  scores: readonly [number, number, number, number, number, number];
  color: "green" | "clear" | "yellow" | "red";
  trend: "up" | "down" | "flat";
};
export type Ranking = { period: "MTD" | "Wave to Date"; rows: readonly RankingRow[] };
export const latestRankings: readonly Ranking[] = [
  { period: "MTD", rows: [
    { property: "Residence Inn by Marriott Cedar Rapids South (CIDCS)", sampleSize: 3, scores: [100.0,100.0,100.0,100.0,100.0,100.0], color: "green", trend: "up" },
    { property: "Residence Inn by Marriott Des Moines Downtown (DSMRD)", sampleSize: 8, scores: [100.0,50.0,87.5,100.0,87.5,83.3], color: "green", trend: "up" },
    { property: "Residence Inn by Marriott Champaign (CMPRI)", sampleSize: 6, scores: [83.3,75.0,83.3,100.0,66.7,66.7], color: "green", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites St. Paul Eagan (MSPFG)", sampleSize: 15, scores: [80.0,100.0,93.3,86.7,93.3,25.0], color: "green", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites Minneapolis Shakopee (MSPFK)", sampleSize: 4, scores: [75.0,100.0,75.0,100.0,75.0,50.0], color: "clear", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites Coralville (CIDCO)", sampleSize: 11, scores: [72.7,66.7,60.0,72.7,60.0,62.5], color: "clear", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites Milwaukee Brookfield (MKEFB)", sampleSize: 9, scores: [66.7,50.0,62.5,62.5,62.5,25.0], color: "clear", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites Alpharetta Avalon Area (ATLFH)", sampleSize: 5, scores: [60.0,66.7,100.0,100.0,100.0,75.0], color: "yellow", trend: "down" },
    { property: "Fairfield by Marriott Inn & Suites Cambridge (PKBCB)", sampleSize: 7, scores: [57.1,100.0,71.4,85.7,57.1,50.0], color: "yellow", trend: "down" },
    { property: "Aloft by Marriott Oklahoma City Downtown - Bricktown (OKCAL)", sampleSize: 10, scores: [50.0,40.0,60.0,60.0,60.0,80.0], color: "red", trend: "down" },
    { property: "Fairfield by Marriott Inn & Suites Cedar Rapids (CIDCR)", sampleSize: 4, scores: [50.0,100.0,75.0,100.0,75.0,33.3], color: "red", trend: "up" },
    { property: "SpringHill Suites by Marriott St. Paul Arden Hills (MSPST)", sampleSize: 12, scores: [41.7,25.0,50.0,25.0,41.7,0.0], color: "red", trend: "down" },
    { property: "Residence Inn by Marriott Coralville (CIDVL)", sampleSize: 6, scores: [33.3,33.3,33.3,33.3,40.0,50.0], color: "red", trend: "down" },
    { property: "Le Méridien St. Louis Downtown (STLMO)", sampleSize: 5, scores: [20.0,50.0,40.0,40.0,20.0,33.3], color: "red", trend: "flat" },
    { property: "Fairfield by Marriott Inn & Suites Minneapolis Downtown (MSPFD)", sampleSize: 3, scores: [0.0,0.0,33.3,33.3,33.3,0.0], color: "red", trend: "down" },
  ] },
  { period: "Wave to Date", rows: [
    { property: "Fairfield by Marriott Inn & Suites Cambridge (PKBCB)", sampleSize: 172, scores: [72.1,85.1,81.7,84.4,74.6,49.6], color: "clear", trend: "down" },
    { property: "Fairfield by Marriott Inn & Suites St. Paul Eagan (MSPFG)", sampleSize: 286, scores: [67.5,47.5,82.2,77.0,75.4,36.1], color: "clear", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites Alpharetta Avalon Area (ATLFH)", sampleSize: 140, scores: [65.0,64.5,72.1,67.9,64.3,52.7], color: "clear", trend: "down" },
    { property: "Residence Inn by Marriott Des Moines Downtown (DSMRD)", sampleSize: 175, scores: [64.0,60.0,71.9,75.6,65.9,60.0], color: "clear", trend: "up" },
    { property: "Residence Inn by Marriott Cedar Rapids South (CIDCS)", sampleSize: 54, scores: [63.0,72.4,64.2,66.0,50.9,61.5], color: "clear", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites Minneapolis Downtown (MSPFD)", sampleSize: 151, scores: [60.9,73.0,70.1,73.5,67.1,42.7], color: "yellow", trend: "down" },
    { property: "SpringHill Suites by Marriott St. Paul Arden Hills (MSPST)", sampleSize: 168, scores: [60.1,42.6,68.1,67.7,61.9,43.8], color: "yellow", trend: "down" },
    { property: "Fairfield by Marriott Inn & Suites Minneapolis Shakopee (MSPFK)", sampleSize: 160, scores: [58.1,68.6,65.4,73.0,61.6,33.6], color: "yellow", trend: "down" },
    { property: "Fairfield by Marriott Inn & Suites Coralville (CIDCO)", sampleSize: 168, scores: [57.7,54.3,67.3,74.4,57.1,56.8], color: "yellow", trend: "up" },
    { property: "Residence Inn by Marriott Champaign (CMPRI)", sampleSize: 151, scores: [55.6,59.5,59.3,66.4,47.7,47.7], color: "yellow", trend: "up" },
    { property: "Residence Inn by Marriott Coralville (CIDVL)", sampleSize: 109, scores: [52.3,52.9,52.3,62.0,46.7,54.9], color: "red", trend: "down" },
    { property: "Fairfield by Marriott Inn & Suites Cedar Rapids (CIDCR)", sampleSize: 117, scores: [50.4,61.9,59.5,64.3,55.7,39.5], color: "red", trend: "up" },
    { property: "Aloft by Marriott Oklahoma City Downtown - Bricktown (OKCAL)", sampleSize: 163, scores: [47.2,53.2,61.4,60.1,55.7,53.8], color: "red", trend: "up" },
    { property: "Fairfield by Marriott Inn & Suites Milwaukee Brookfield (MKEFB)", sampleSize: 206, scores: [39.8,35.9,48.2,47.2,42.2,25.2], color: "red", trend: "up" },
    { property: "Le Méridien St. Louis Downtown (STLMO)", sampleSize: 59, scores: [11.9,28.9,22.8,31.0,10.3,13.3], color: "red", trend: "up" },
  ] },
];

