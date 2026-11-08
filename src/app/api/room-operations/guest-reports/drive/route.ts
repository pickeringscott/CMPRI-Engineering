import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@/lib/server/auth';
import { HOTEL_ID, HOTEL_TIME_ZONE } from '@/lib/constants';
import { hotelDateAt } from '@/lib/room-operations-reports';
import { DriveRoomReportError } from '@/lib/room-report-drive';
import type { GuestReport, GuestReportKind } from '@/lib/room-guest-reports';
import { fetchNewerDriveRoomReports } from '@/lib/server/drive-room-reports';
import { DriveAccessError } from '@/lib/server/drive-po-api';
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
