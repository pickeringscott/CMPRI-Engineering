import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth';
import { profileHasRole } from '@/lib/server/roles';
import { allows } from '@/lib/server/access';
import { HOTEL_ID } from '@/lib/constants';
import { findPmTemplate, validPmPeriod } from '@/lib/pm/catalog';
import { tapTask, taskComplete, type PmTaskState, type PmTaskActor } from '@/lib/pm/task-review';

export async function PATCH(request: NextRequest) {
  const auth = await requireUser(request);
  if (!auth) return NextResponse.json({ error: 'Sign in is required.' }, { status: 401 });
  const chief = profileHasRole(auth.principal.profile, 'system_admin') || profileHasRole(auth.principal.profile, 'engineer');
  const technician = profileHasRole(auth.principal.profile, 'technician');
  if (!allows(auth.principal, 'view_pm') || (!chief && !technician) || (!profileHasRole(auth.principal.profile, 'system_admin') && !allows(auth.principal, 'edit_tickets'))) return NextResponse.json({ error: 'PM editing is restricted to engineering and technicians.' }, { status: 403 });
  const actor: PmTaskActor = { id: auth.principal.identity.id, name: auth.principal.profile.full_name || 'CMPRI User', role: chief ? 'chief' : 'technician' };
  const body = await request.json().catch(() => null);
  const template = typeof body?.templateId === 'string' ? findPmTemplate(body.templateId) : null;
  const item = template?.checklist.find(item => item.id === body?.itemId);
  if (!template || template.kind !== 'routine' || !item || typeof body.periodStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.periodStart) || !validPmPeriod(template, body.periodStart) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) return NextResponse.json({ error: 'Choose a valid task, period and revision.' }, { status: 400 });
  const key = { hotel_id: HOTEL_ID, template_id: template.id, period_start: body.periodStart, scope_key: 'property' };
  // One pending proposal per scope is enforced by the existing unique index.
  // Keep the shared task ledger pending; individual task review is in its payload.
  const result = await auth.admin.from('cmpri_pm_proposals').select('*').match(key).in('status', ['pending', 'processing', 'approved']).order('updated_at', { ascending: false }).limit(100);
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 503 });
  const rows = result.data || [];
  const current = rows.find(row => row.status === 'pending' || row.status === 'processing') || rows[0];
  if (current?.status === 'processing' || (current?.status === 'pending' ? current.revision : 0) !== body.expectedRevision) return NextResponse.json({ error: 'This PM period changed. Reload it before retrying.', conflict: true }, { status: 409 });
  const payload = { ...(current?.payload || {}) };
  const states: Record<string, PmTaskState> = { ...(payload.task_states || {}) };
  // Preserve legacy checkmarks and their recorded submitter when first adopting the ledger.
  for (const task of template.checklist) {
    if (!states[task.id] && payload.responses?.[task.id] === true) states[task.id] = {
      status: current?.status === 'approved' ? 'approved' : 'needs', workerChecked: true,
      workerId: current?.submitted_by, workerName: current?.submitted_by_name,
      poolSubmitted: /log pool readings/i.test(task.label),
    };
  }
  const pool = /log pool readings/i.test(item.label);
  let poolLogFilled = false;
  if (pool && !states[item.id]?.poolSubmitted) {
    const logs = await auth.admin.from('pool_daily_logs').select('id, ph_am, ph_pm, sanitizer_am, sanitizer_pm, sanitizer_band_am, sanitizer_band_pm, main_drain_visible, filter_backwashed').eq('hotel_id', HOTEL_ID).eq('log_date', body.periodStart);
    if (logs.error) return NextResponse.json({ error: 'The matching Pool Log could not be verified.' }, { status: 503 });
    poolLogFilled = (logs.data || []).some(log => (log.ph_am != null && (log.sanitizer_am != null || log.sanitizer_band_am != null) || log.ph_pm != null && (log.sanitizer_pm != null || log.sanitizer_band_pm != null)) && log.main_drain_visible != null && log.filter_backwashed != null);
    if (!poolLogFilled) return NextResponse.json({ error: 'Complete the matching daily Pool Log first.', poolRequired: true, date: body.periodStart }, { status: 409 });
  }
  try {
    states[item.id] = tapTask(states[item.id], actor, { pool, poolLogFilled, attachedForm: template.cadence === 'weekly' && Boolean(item.source?.endsWith('.pdf')) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'This task cannot be changed.' }, { status: 403 });
  }
  const responses = Object.fromEntries(template.checklist.map(task => [task.id, taskComplete(states[task.id])]));
  const nextPayload = { ...payload, task_states: states, responses, is_complete: template.checklist.every(task => responses[task.id]) };
  const mutation = current?.status === 'pending'
    ? auth.admin.from('cmpri_pm_proposals').update({ payload: nextPayload }).match(key).eq('id', current.id).eq('status', 'pending').eq('revision', body.expectedRevision)
    : auth.admin.from('cmpri_pm_proposals').insert({ ...key, payload: nextPayload, proposed_cells: [], status: 'pending', submitted_by: actor.id, submitted_by_name: actor.name });
  const saved = await mutation.select('id, template_id, period_start, scope_key, payload, status, submitted_by_name, revision, updated_at').maybeSingle();
  if (saved.error) return NextResponse.json({ error: saved.error.message, conflict: saved.error.code === '23505' }, { status: saved.error.code === '23505' ? 409 : 503 });
  if (!saved.data) return NextResponse.json({ error: 'This PM period changed. Reload before retrying.', conflict: true }, { status: 409 });
  return NextResponse.json({ entry: { ...saved.data.payload, ...saved.data, payload: undefined, can_edit_entry: true } });
}
