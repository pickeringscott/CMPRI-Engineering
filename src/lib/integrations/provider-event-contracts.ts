/** Drive version and GSS publication contracts. */
export function verifyDriveSheetVersion(expectedId: string, file: {id?:string;version?:string;mimeType?:string;trashed?:boolean}) {
 if (!/^[a-zA-Z0-9_-]+$/.test(expectedId) || file.id !== expectedId || file.trashed || file.mimeType !== "application/vnd.google-apps.spreadsheet" || !file.version || !/^\d+$/.test(file.version)) throw new Error("Configured spreadsheet identity/version not verified.");
 return file.version;
}

/** Civil-time gate; a scheduler can wake at both candidate UTC hours without duplicate publication. */
export function gssMondayNoonSlot(now: Date): string | null {
 if (!Number.isFinite(now.getTime())) throw new Error("Valid publication time required.");
 const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {timeZone:"America/Chicago",weekday:"short",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"}).formatToParts(now).map(p=>[p.type,p.value]));
 return parts.weekday === "Mon" && parts.hour === "12" ? `${parts.year}-${parts.month}-${parts.day}` : null;
}

export type GssSourceRow = {property:string;sampleSize:number;scores:readonly number[];color:"green"|"clear"|"yellow"|"red";trend:"up"|"down"};
/** Do not invent arrows, colors, reporting periods or missing image-table values. */
export function validateGssSourceRows(rows: readonly GssSourceRow[]) {
 const names = new Set<string>();
 if (!rows.length || rows.length > 1000) throw new Error("Complete source table required.");
 for (const row of rows) {
  if (!row.property?.trim() || names.has(row.property) || !Number.isSafeInteger(row.sampleSize) || row.sampleSize < 0 || row.scores.length !== 6 || row.scores.some(v=>!Number.isFinite(v)||v<0||v>100) || !["green","clear","yellow","red"].includes(row.color) || !["up","down"].includes(row.trend)) throw new Error("Unverified GSS source row.");
  names.add(row.property);
 }
 if (![...names].some(name=>/\(CMPRI\)$/.test(name))) throw new Error("CMPRI source row required.");
 return rows;
}
