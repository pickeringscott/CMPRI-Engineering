import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { requireUser } from '@/lib/server/auth';
import { allows } from '@/lib/server/access';
import { HOTEL_ID } from '@/lib/constants';
import { isUuid } from '@/lib/uuid';
import { canReadWorkOrder } from '@/lib/work-order-read-policy';
import { workOrderReader } from '@/lib/server/work-order-reader';
import { changeTroubleshootingTask, troubleshootingChecklistAccess } from '@/lib/server/work-order-troubleshooting';
import { normalizeManualKnowledge } from '@/lib/manual-knowledge';
import type { PmTaskState } from '@/lib/pm/task-review';
import { deriveTroubleshootingChecklistContext, type TroubleshootingChecklist, type TroubleshootingChecklistAsset } from '@/lib/work-orders/troubleshooting-checklist';
import { loadUploadedAssetGuide } from '@/lib/server/uploaded-asset-guide';
import {manualPreviewReadOnly} from '@/lib/server/manual-preview';

export const runtime = 'nodejs';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization' };
const table = 'cmpri_work_order_troubleshooting_checks';
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });
const conflict = (message: string, code = 'context_changed') => json({ error: message, conflict: true, code }, 409);
type Params = { params: Promise<{ id: string }> };
type Auth = NonNullable<Awaited<ReturnType<typeof requireUser>>>;
type WorkOrder = { id: string; hotel_id: string; troubleshooting_run_id?: string | null; issue: string; reporter_notes: string | null; notes?:string|null; action_root_cause?:string|null; asset_id: string | null; revision: number; status: string; created_by: string | null; technician_name: string | null };
type Asset = TroubleshootingChecklistAsset & { pdf_import_links: unknown; active: boolean | null };
type Authorized = { auth: Auth; order: WorkOrder };
type Loaded = Authorized & { assetContext: Record<string, unknown> | null; checklist: TroubleshootingChecklist; mayReadGuide: boolean };

async function authorize(request: NextRequest, params: Params): Promise<Authorized | Response> {
  const auth = await requireUser(request);
  if (!auth) return json({ error: 'Sign in is required.' }, 401);
  if (auth.principal.hotelId !== HOTEL_ID || !allows(auth.principal, 'view_work_orders')) return json({ error: 'Work-order access is required.' }, 403);
  const { id } = await params.params;
  if (!isUuid(id)) return json({ error: 'A valid work-order ID is required.' }, 400);
  const ticket = await auth.admin.from('work_orders').select('id,hotel_id,issue,reporter_notes,notes,action_root_cause,asset_id,revision,status,created_by,technician_name,troubleshooting_run_id')
    .eq('hotel_id', auth.principal.hotelId).eq('id', id).maybeSingle();
  if (ticket.error) return json({ error: 'The work order could not be read.' }, 503);
  if (!ticket.data) return json({ error: 'Work order not found.' }, 404);
  const order = ticket.data as WorkOrder;
  if (!canReadWorkOrder(workOrderReader(auth.principal), order)) return json({ error: 'This work order is not available to your account.' }, 403);
  return { auth, order };
}

async function pendingVisits(auth: Auth, workOrderId: string) {
  const pending = await auth.admin.from('cmpri_work_order_troubleshooting_visits').select('id,created_at,last_event_at,event_count')
    .eq('hotel_id', auth.principal.hotelId).eq('work_order_id', workOrderId).eq('actor_id', auth.principal.identity.id)
    .is('finalized_at', null).gt('event_count', 0).order('created_at', { ascending: true }).limit(100);
  if (pending.error) throw new Error('Pending troubleshooting notes could not be verified. Reload before making more changes.');
  return (pending.data || []).map(visit => ({ visitId: String(visit.id), startedAt: String(visit.created_at), lastEventAt: visit.last_event_at ? String(visit.last_event_at) : null, eventCount: Number(visit.event_count) }));
}

function visibleChecklist(loaded: Loaded) {
  const checklist=loaded.mayReadGuide ? loaded.checklist : { ...loaded.checklist, contextIdentity: null, steps: [] };
  return manualPreviewReadOnly()?{...checklist,previewReadOnly:true,previewAccess:{canEdit:checklist.canEdit,canClearAll:checklist.canClearAll,canClearOwn:checklist.canClearOwn},canEdit:false,canClearAll:false,canClearOwn:false}:checklist;
}

async function load(request: NextRequest, params: Params, base?: Authorized, allowOwnedClear = false): Promise<Loaded | Response> {
  const authorized = base || await authorize(request, params);
  if (authorized instanceof Response) return authorized;
  const { auth, order } = authorized;
  const id = order.id;
  const access = troubleshootingChecklistAccess(auth.principal, order);
  let pending: TroubleshootingChecklist['pendingVisits'];
  try { pending = await pendingVisits(auth, id); }
  catch (error) { return json({ error: error instanceof Error ? error.message : 'Pending troubleshooting notes are unavailable.' }, 503); }
  const mayReadGuide = ['view_work_orders', 'view_dashboard', 'view_pm'].every(capability => allows(auth.principal, capability as 'view_work_orders' | 'view_dashboard' | 'view_pm'));
  const empty: TroubleshootingChecklist = { contextKey: null, contextIdentity: null, revision: 0, ...access, steps: [], taskStates: {}, pendingVisits: pending };
  const finish = (checklist: TroubleshootingChecklist, assetContext: Record<string, unknown> | null = null): Loaded => ({ auth, order, assetContext, checklist, mayReadGuide });
  if (!mayReadGuide && !allowOwnedClear) return finish({ ...empty, reason: 'PM reference access is required to read this equipment guide. Previously recorded actions remain recoverable for your account.' });
  if (!order.asset_id) return finish({ ...empty, reason: 'Select and save equipment with verified issue-specific documentation before using a checklist.' });
  const assetResult = await auth.admin.from('assets').select('id,manufacturer,model_family,model_number,serial_number,documentation_key,documentation_revision_id,documentation_verified_at,pdf_import_links,active')
    .eq('hotel_id', auth.principal.hotelId).eq('id', order.asset_id).maybeSingle();
  if (assetResult.error) return json({ error: 'Equipment documentation could not be verified.' }, 503);
  const asset = assetResult.data as Asset | null;
  if (!asset || asset.active === false) return finish({ ...empty, reason: 'The saved equipment is unavailable.' });
  // Use the same source-only reader as the strict reference endpoint. For an
  // owner's clear, the server may verify that source without exposing its text
  // to an account whose reference-reading capability has since changed.
  let result: Awaited<ReturnType<typeof loadUploadedAssetGuide>>;
  try { result = await loadUploadedAssetGuide(auth.admin, {
    id: asset.id, hotel_id: auth.principal.hotelId, active: asset.active,
    manufacturer: asset.manufacturer || null, model_family: asset.model_family || null, model_number: asset.model_number || null, serial_number: asset.serial_number || null,
    documentation_key: asset.documentation_key || null, documentation_revision_id: asset.documentation_revision_id || null,
    documentation_verified_at: asset.documentation_verified_at || null, pdf_import_links: asset.pdf_import_links,
  }); }
  catch { return finish({ ...empty, reason: 'The attached source document could not be verified. Saved visit changes remain pending for a combined note.' }); }
  const knowledge = normalizeManualKnowledge(result.manualKnowledge);
  const derived = result.documentation_status === 'verified' ? deriveTroubleshootingChecklistContext({ issue: order.issue || '', reporter_notes: order.reporter_notes, notes:order.notes, action_root_cause:order.action_root_cause, asset }, knowledge) : { contextIdentity: null, steps: [] };
  const assetContext = Object.fromEntries(['id', 'manufacturer', 'model_family', 'model_number', 'serial_number', 'documentation_key', 'documentation_revision_id', 'documentation_verified_at', 'pdf_import_links'].map(key => [key, asset[key as keyof Asset] ?? null]));
  if (!derived.contextIdentity) return finish({ ...empty, reason: result.documentation_reason || 'No exact verified uploaded manual guidance is available for this saved equipment.' }, assetContext);
  const contextKey = createHash('sha256').update(order.troubleshooting_run_id ? JSON.stringify([derived.contextIdentity, order.troubleshooting_run_id]) : derived.contextIdentity).digest('hex');
  const current = await auth.admin.from(table).select('revision,task_states').eq('hotel_id', auth.principal.hotelId).eq('work_order_id', id).eq('context_key', contextKey).maybeSingle();
  if (current.error) return json({ error: 'The saved troubleshooting checklist is unavailable. Try again or contact Engineering.' }, 503);
  const states = current.data?.task_states ?? {};
  if (!states || typeof states !== 'object' || Array.isArray(states) || Object.keys(states).some(key => !derived.steps.some(step => step.id === key))) return json({ error: 'The saved troubleshooting checklist could not be verified.' }, 503);
  return finish({ ...empty, ...derived, contextKey, revision: Number(current.data?.revision || 0), taskStates: states as Record<string, PmTaskState>, ...(derived.steps.length ? {} : { reason: 'No matching instructions in the attached document.' }) }, assetContext);
}

export async function GET(request: NextRequest, params: Params) {
  const loaded = await load(request, params);
  return loaded instanceof Response ? loaded : json(visibleChecklist(loaded));
}

export async function POST(request: NextRequest, params: Params) {
  const body = await request.json().catch(() => null);
  if (!body || body.action !== 'start_new' || typeof body.contextKey !== 'string' || !Number.isSafeInteger(body.expectedRevision)) return json({ error: 'A current checklist is required.' }, 400);
  const loaded = await load(request, params);
  if (loaded instanceof Response) return loaded;
  const { auth, order, checklist } = loaded;
  if (!loaded.mayReadGuide || !checklist.canEdit || checklist.actor.role !== 'technician') return json({ error: 'Only an authorized technician can start a new checklist.' }, 403);
  if (checklist.contextKey !== body.contextKey || checklist.revision !== body.expectedRevision) return conflict('The checklist changed. Reload before starting a new one.');
  if (!Object.values(checklist.taskStates).some(state => state.workerChecked && state.workerId && state.workerId !== checklist.actor.id)) return json({ error: 'There is no other technician’s progress to restart.' }, 400);
  const result = await auth.admin.from('work_orders').update({ troubleshooting_run_id: crypto.randomUUID() }).eq('hotel_id', auth.principal.hotelId).eq('id', order.id).eq('revision', order.revision).select('revision').maybeSingle();
  if (result.error || !result.data) return conflict('The work order changed. Reload before starting a new checklist.');
  return json({ ok: true, workOrderRevision: result.data.revision });
}

export async function PATCH(request: NextRequest, params: Params) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['contextKey', 'expectedRevision', 'itemId', 'action', 'visitId', 'mutationId'].includes(key))
    || typeof body.contextKey !== 'string' || !/^[a-f0-9]{64}$/.test(body.contextKey) || typeof body.itemId !== 'string' || !/^step-[1-9]\d*$/.test(body.itemId)
    || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0
    || !isUuid(body.visitId) || !isUuid(body.mutationId)
    || (body.action !== undefined && body.action !== 'toggle' && body.action !== 'clear')) return json({ error: 'Choose a current checklist step, context, revision and editing visit.' }, 400);
  const base = await authorize(request, params);
  if (base instanceof Response) return base;
  const replay = await base.auth.admin.from('cmpri_work_order_troubleshooting_events').select('request')
    .eq('hotel_id', base.auth.principal.hotelId).eq('work_order_id', base.order.id).eq('actor_id', base.auth.principal.identity.id).eq('mutation_id', body.mutationId).maybeSingle();
  if (replay.error) return json({ error: 'The previous checklist change could not be verified. Retry this same change before leaving.' }, 503);
  if (replay.data) {
    const previous = replay.data.request as Record<string, unknown>;
    if (previous.context_key !== body.contextKey || Number(previous.expected_revision) !== body.expectedRevision || previous.item_id !== body.itemId || previous.action !== (body.action || 'toggle') || previous.visit_id !== body.visitId) return conflict('This change identifier was already used for a different checklist action.', 'mutation_changed');
    const repeated = await load(request, params, base);
    return repeated instanceof Response ? repeated : json({ ...visibleChecklist(repeated), replayed: true, mutationId: body.mutationId });
  }
  const loaded = await load(request, params, base, true);
  if (loaded instanceof Response) return loaded;
  const { auth, order, assetContext, checklist } = loaded;
  if (!checklist.contextKey || checklist.contextKey !== body.contextKey) return conflict('The reported issue, equipment or verified guide changed. Reload the checklist before trying again.');
  if (!checklist.steps.some(step => step.id === body.itemId)) return json({ error: 'This step is not part of the current verified issue-specific guide.' }, 400);
  if (checklist.revision !== body.expectedRevision) return conflict('Someone changed this checklist. Reload it before trying again.', 'revision_changed');
  let next: PmTaskState;
  try { next = changeTroubleshootingTask(checklist, checklist.taskStates[body.itemId], body.action); }
  catch (error) { return json({ error: error instanceof Error ? error.message : 'This completion cannot be changed by your account.' }, 403); }
  const step = checklist.steps.find(item => item.id === body.itemId)!;
  const sources = JSON.parse(checklist.contextIdentity!).sources as Record<string, unknown>[];
  const source = sources.find(source => source.registered_file_id === step.source_document_id && source.sha256 === step.source_sha256);
  if (!source) return conflict('The source for this instruction changed. Reload the checklist.');
  const saved = await auth.admin.rpc('cmpri_save_work_order_troubleshooting', {
    p_hotel: auth.principal.hotelId,
    p_work_order: order.id,
    p_context_key: checklist.contextKey,
    p_expected_revision: body.expectedRevision,
    p_work_order_revision: order.revision,
    p_asset_context: assetContext,
    p_task_states: { ...checklist.taskStates, [body.itemId]: next },
    p_actor: checklist.actor.id,
    p_visit_id: body.visitId,
    p_mutation_id: body.mutationId,
    p_item_id: body.itemId,
    p_action: body.action || 'toggle',
    p_step_label: step.label,
    p_source: { source_file_name: source.file, storage_path: source.storage_path, sha256: source.sha256, registered_file_id: source.registered_file_id, registered_updated_at: source.registered_updated_at, source_pages: step.sourcePages, issue: order.issue },
    p_before_state: checklist.taskStates[body.itemId] || null,
    p_after_state: next,
  }).maybeSingle();
  if (saved.error) {
    if (saved.error.code === '40001' || saved.error.code === '23505') return conflict('The work order, equipment or checklist changed while saving. Reload before trying again.', /equipment|work.order|context/i.test(saved.error.message) ? 'context_changed' : 'revision_changed');
    return json({ error: 'The troubleshooting check could not be saved. Reload the checklist before retrying.' }, 503);
  }
  if (!saved.data) return conflict('Someone changed this checklist. Reload before trying again.', 'revision_changed');
  const row = saved.data as { revision: number; task_states: Record<string, PmTaskState> };
  let pending: TroubleshootingChecklist['pendingVisits'];
  try { pending = await pendingVisits(auth, order.id); }
  catch { return json({ error: 'Your checklist change was recorded, but its pending note could not be read back. Retry this same change before leaving.', mutationSaved: true }, 503); }
  loaded.checklist = { ...checklist, revision: Number(row.revision), taskStates: row.task_states, pendingVisits: pending };
  return json(visibleChecklist(loaded));
}
