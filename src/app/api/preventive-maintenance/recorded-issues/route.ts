import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth';
import { allows } from '@/lib/server/access';
import { loadRecordedIssues } from '@/lib/server/pm-recorded-issues';
import { fetchAllPages } from '@/lib/server/paginated-query';
import { workOrderReadFilter } from '@/lib/work-order-read-policy';
import { workOrderReader } from '@/lib/server/work-order-reader';
import { manualPreviewReadOnly } from '@/lib/server/manual-preview';
import { HOTEL_ID } from '@/lib/constants';

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth || !allows(auth.principal, 'view_pm')) return NextResponse.json({error:'PM access required.'}, {status:403});
  try {
    const filter = workOrderReadFilter(workOrderReader(auth.principal));
    const [records, links] = await Promise.all([
      loadRecordedIssues(auth.admin, auth.principal.identity.id),
      fetchAllPages<{ id: string; display_id: string; status: string; import_external_id: string }>((from, to) => {
        let query = auth.admin.from('work_orders').select('id,display_id,status,import_external_id')
          .eq('hotel_id', HOTEL_ID).eq('import_source', 'PM Log').order('id').range(from, to);
        if (filter) query = query.or(filter);
        return query;
      }),
    ]);
    if (links.error) throw new Error('Existing PM work-order links could not be loaded. Retry before confirming any issues.');
    return NextResponse.json({ records, links: links.data || [], canConfirm: allows(auth.principal, 'edit_tickets'), preview_read_only: manualPreviewReadOnly() }, {headers:{'Cache-Control':'private, no-store',Vary:'Authorization'}});
  } catch (cause) {
    return NextResponse.json({error: cause instanceof Error ? cause.message : 'Recorded issues unavailable.'}, {status:503});
  }
}
