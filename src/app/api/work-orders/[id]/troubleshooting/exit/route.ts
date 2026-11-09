import { NextResponse, type NextRequest } from 'next/server';
import { requireUser } from '@/lib/server/auth';
import { allows } from '@/lib/server/access';
import { HOTEL_ID } from '@/lib/constants';
import { isUuid } from '@/lib/uuid';
import { workOrderReader } from '@/lib/server/work-order-reader';
import { canReadWorkOrder } from '@/lib/work-order-read-policy';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization' };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });

/** Append one trusted generated note for this account's durable editing visit. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (!auth || auth.principal.hotelId !== HOTEL_ID || !allows(auth.principal, 'view_work_orders')) return json({ error: 'An active property account with work-order access is required.' }, 403);
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!isUuid(id) || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'visitId') || !isUuid(body.visitId)) return json({ error: 'A valid work order and editing visit are required.' }, 400);
  const ticket = await auth.admin.from('work_orders').select('id,hotel_id').eq('hotel_id', auth.principal.hotelId).eq('id', id).maybeSingle();
  if (ticket.error) return json({ error: 'This work order could not be verified. Keep this visit open and retry.' }, 503);
  if (!ticket.data) return json({ error: 'Work order not found.' }, 404);
  if (!canReadWorkOrder(workOrderReader(auth.principal), ticket.data)) return json({ error: 'This work order is not available to your account.' }, 403);
  // This accepts no user note text. The RPC checks visit ownership and appends
  // only its previously authorized action journal, including after a role change.
  const saved = await auth.admin.rpc('cmpri_finalize_work_order_troubleshooting', { p_hotel: auth.principal.hotelId, p_work_order: id, p_visit_id: body.visitId, p_actor: auth.principal.identity.id });
  if (saved.error) return json({ error: 'The combined troubleshooting note could not be saved. Your recorded actions remain pending; keep this visit open and retry.', conflict: saved.error.code === '40001' }, saved.error.code === '42501' ? 403 : saved.error.code === '40001' ? 409 : 503);
  const result = saved.data as { finalized: boolean; already_finalized: boolean; event_count: number; work_order_revision: number | null; note: string | null } | null;
  if (!result?.finalized) return json({ error: 'The combined troubleshooting note was not confirmed. Retry before leaving this visit.' }, 503);
  return json({ ok: true, finalized: true, alreadyFinalized: result.already_finalized, eventCount: Number(result.event_count || 0), workOrderRevision: result.work_order_revision == null ? null : Number(result.work_order_revision), ...(result.note ? { notes: result.note } : {}) });
}
