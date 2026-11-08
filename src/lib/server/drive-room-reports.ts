import { DRIVE_PO_ACCOUNT, DRIVE_PO_FOLDER, DriveAccessError, driveRequest, existingDriveToken } from './drive-po-api';
import { DriveRoomReportError, newerDriveRoomReports, driveRoomReportName, type DriveRoomReportFile } from '../room-report-drive';
import { type GuestReport, type GuestReportKind } from '../room-guest-reports';

const limit = 3_000_000;
const metadataFields = 'id,name,mimeType,parents,trashed,size,version,md5Checksum';
function verified(file: DriveRoomReportFile) {
  return /^[A-Za-z0-9_-]+$/.test(file.id) && !!file.version && !file.trashed && file.parents?.includes(DRIVE_PO_FOLDER);
}
async function listReports(token: string) {
  const files: DriveRoomReportFile[] = [], pages = new Set<string>();
  let pageToken = '';
  do {
    const query = new URLSearchParams({
      q: `'${DRIVE_PO_FOLDER}' in parents and trashed = false and (name contains 'In House Guest List Details' or name contains 'Housekeeping Departures' or name contains 'Housekeeping Arrivals')`,
      fields: `nextPageToken,incompleteSearch,files(${metadataFields})`, pageSize: '100', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    });
    if (pageToken) query.set('pageToken', pageToken);
    const page = await driveRequest<{ files: DriveRoomReportFile[]; nextPageToken?: string; incompleteSearch?: boolean }>(token, 'files?' + query, {}, 'room report inventory');
    if (page.incompleteSearch || !Array.isArray(page.files)) throw new DriveRoomReportError('Drive returned an incomplete room report inventory. Try again.');
    for (const file of page.files) {
      if (!verified(file)) throw new DriveRoomReportError('A room report could not be verified in the approved attachment folder.');
      files.push(file);
    }
    if (files.length > 2000) throw new DriveRoomReportError('Too many room reports in the attachment folder.');
    pageToken = page.nextPageToken || '';
    if (pageToken && pages.has(pageToken)) throw new DriveRoomReportError('Drive repeated a room report inventory page.');
    pages.add(pageToken);
  } while (pageToken);
  return files;
}
async function readReport(token: string, file: DriveRoomReportFile) {
  if (!verified(file) || !driveRoomReportName(file)) throw new DriveRoomReportError('Verified room report CSV required.');
  const size = Number(file.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > limit) throw new DriveRoomReportError(`${file.name}: use a CSV no larger than 3 MB.`);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new DriveAccessError('room report read', response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new DriveRoomReportError('The room report CSV has no content.');
  const parts: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw new DriveRoomReportError('The room report CSV exceeds 3 MB.');
      parts.push(value);
    }
  } finally { await reader.cancel(); }
  if (bytes !== size) throw new DriveRoomReportError('The room report changed while downloading. Fetch it again.');
  const current = await driveRequest<DriveRoomReportFile>(token, `files/${file.id}?fields=${metadataFields}&supportsAllDrives=true`, {}, 'room report verification');
  if (!verified(current) || current.id !== file.id || current.version !== file.version || current.name !== file.name || current.mimeType !== file.mimeType || current.size !== file.size) throw new DriveRoomReportError('The room report changed or left the attachment folder. Fetch it again.');
  return { name: file.name, text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)) };
}

/** Read-only acquisition. Accepted timestamps advance only through the existing confirmed import. */
export async function fetchNewerDriveRoomReports(previous: Partial<Record<GuestReportKind, GuestReport>>, today: string) {
  const token = await existingDriveToken();
  const about = await driveRequest<{ user: { emailAddress: string } }>(token, 'about?fields=user(emailAddress)', {}, 'account lookup');
  if (about.user?.emailAddress?.toLowerCase() !== DRIVE_PO_ACCOUNT) throw new DriveAccessError('account identity mismatch', 403);
  const folder = await driveRequest<DriveRoomReportFile>(token, `files/${DRIVE_PO_FOLDER}?fields=id,mimeType,trashed&supportsAllDrives=true`, {}, 'folder lookup');
  if (folder.id !== DRIVE_PO_FOLDER || folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder') throw new DriveRoomReportError('The approved attachment folder is unavailable.');
  const selected = newerDriveRoomReports(await listReports(token), previous, today);
  return Promise.all(selected.map(file => readReport(token, file)));
}
