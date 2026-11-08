import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@/lib/server/auth';
import { HOTEL_ID, HOTEL_TIME_ZONE } from '@/lib/constants';
import { hotelDateAt } from '@/lib/room-operations-reports';
import { DriveRoomReportError } from '@/lib/room-report-drive';
import type { GuestReport, GuestReportKind } from '@/lib/room-guest-reports';
import { fetchNewerDriveRoomReports } from '@/lib/server/drive-room-reports';
import { DriveAccessError } from '@/lib/server/drive-po-api';
import { POST as importGuestReports } from '../route';
import { isIntegrationsSafeMode } from '@/lib/server/integrations-safe-mode';

export const runtime = 'nodejs';
export const maxDuration = 120;
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: NextRequest) {
  const auth = await requireCapability(request, 'edit_tickets');
  if (!auth || auth.principal.hotelId !== HOTEL_ID) return NextResponse.json({ error: 'Engineering ticket-edit permission is required.' }, { status: 403, headers });
  if (isIntegrationsSafeMode()) return NextResponse.json({ error: 'Drive fetching is unavailable while integrations are in safe mode. You can still upload the reports.' }, { status: 503, headers });
  try {
    const history = await auth.admin.from('cmpri_room_operation_imports')
      .select('source_rows').eq('hotel_id', auth.principal.hotelId)
      .order('report_date', { ascending: false }).order('status_printed_time', { ascending: false, nullsFirst: false }).order('uploaded_at', { ascending: false }).limit(1);
    if (history.error) throw new DriveRoomReportError('The previously accepted reports could not be verified.');
    const rows = history.data?.[0]?.source_rows;
    const previous = (Array.isArray(rows) ? rows.find(row => row?.guest_report_bundle)?.guest_report_bundle : null) || {};
    const files = await fetchNewerDriveRoomReports(previous as Partial<Record<GuestReportKind, GuestReport>>, hotelDateAt(new Date(), HOTEL_TIME_ZONE));
    return NextResponse.json({ files }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof DriveAccessError || error instanceof DriveRoomReportError ? error.message : 'Drive reports could not be fetched. Check the attachment folder and try again.' }, { status: 502, headers });
  }
}

/** A Drive click validates and commits once; the manual upload preview remains separate. */
export async function POST(request: NextRequest) {
  const started = Date.now();
  const timings: Record<string, number> = {};
  let stageStarted = started;
  const mark = (stage: string) => { timings[stage] = Date.now() - stageStarted; stageStarted = Date.now(); };
  const finish = (response: Response) => {
    const duration = Date.now() - started;
    response.headers.set('Server-Timing', Object.entries(timings).map(([stage, ms]) => `${stage};dur=${ms}`).join(', '));
    response.headers.set('X-CMPRI-Import-Duration-Ms', String(duration));
    console.info(JSON.stringify({ event: 'drive_room_reports_import', status: response.status, duration_ms: duration, ...timings }));
    return response;
  };
  const acquired = await GET(request);
  mark("drive_fetch");
  if (!acquired.ok) return finish(acquired);
  const { files } = await acquired.json();
  if (!files.length) return finish(NextResponse.json({ ok: true, imported: false, message: 'No newer reports for today were found in the attachment folder.' }, { headers }));
  const makeRequest = (validateOnly: boolean, previousId?: string | null) => new NextRequest(new URL('/api/room-operations/guest-reports', request.url), {
    method: 'POST', headers: { Authorization: request.headers.get('authorization') || '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, validateOnly, ...(validateOnly ? {} : { previousId }) }),
  });
  const validated = await importGuestReports(makeRequest(true));
  mark("validation");
  if (!validated.ok) return finish(validated);
  const preview = await validated.json();
  const committed = await importGuestReports(makeRequest(false, preview.previousId));
  mark("save");
  return finish(committed);
}
