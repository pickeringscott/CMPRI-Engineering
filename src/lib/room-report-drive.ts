import { guestReportName, type GuestReport, type GuestReportKind } from './room-guest-reports';

export type DriveRoomReportFile = {
  id: string; name: string; mimeType: string; parents?: string[]; trashed?: boolean;
  size?: string; version?: string; md5Checksum?: string;
};
export class DriveRoomReportError extends Error {}

const csvTypes = new Set(['text/csv', 'application/csv', 'text/plain', 'application/octet-stream', 'application/vnd.ms-excel']);
export function driveRoomReportName(file: DriveRoomReportFile) {
  if (!/\.csv$/i.test(file.name) || !csvTypes.has(file.mimeType)) return null;
  try { return guestReportName(file.name); } catch { return null; }
}

/** Compare filename wall-clock timestamps within each report type, never Drive upload time. */
export function newerDriveRoomReports(
  files: DriveRoomReportFile[], previous: Partial<Record<GuestReportKind, GuestReport>>, today: string,
) {
  const newest = new Map<GuestReportKind, { stamp: string; files: DriveRoomReportFile[] }>();
  for (const file of files) {
    const report = driveRoomReportName(file);
    if (!report || report.date !== today) continue;
    const stamp = `${report.date}T${report.time}`;
    const accepted = previous[report.kind];
    if (accepted) {
      const prior = guestReportName(accepted.name);
      if (stamp <= `${prior.date}T${prior.time}`) continue;
    }
    const candidate = newest.get(report.kind);
    if (!candidate || stamp > candidate.stamp) newest.set(report.kind, { stamp, files: [file] });
    else if (stamp === candidate.stamp) candidate.files.push(file);
  }
  return (['guests', 'departures', 'arrivals'] as const).flatMap((kind) => {
    const candidate = newest.get(kind);
    if (!candidate) return [];
    if (candidate.files.length > 1 && (!candidate.files[0].md5Checksum || new Set(candidate.files.map(f => f.md5Checksum)).size !== 1)) {
      throw new DriveRoomReportError(`Multiple ${kind} reports have the same newest filename timestamp. Resolve the conflicting copies in Drive.`);
    }
    return [candidate.files.slice().sort((a, b) => a.id.localeCompare(b.id))[0]];
  });
}
