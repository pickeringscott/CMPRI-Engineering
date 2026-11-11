import { allows, type Principal } from './access';
import { profileHasRole, profileIsChiefEngineer, profileIsChiefEngineerOrSystemAdmin, profileIsEstablishedHoursChief } from './roles';
import { workOrderReader } from './work-order-reader';
import { canReadWorkOrder, canReadWorkOrderForMutation } from '../work-order-read-policy';
import { tapTask, type PmTaskActor, type PmTaskState } from '../pm/task-review';

/** Reuse PM task semantics, with explicit Chief Engineer identity for review. */
export function troubleshootingChecklistAccess(principal: Principal, workOrder: {
  hotel_id: string;
  status?: unknown;
  created_by?: unknown;
  technician_name?: unknown;
}) {
  const chief = profileIsChiefEngineerOrSystemAdmin(principal.profile);
  const canSeePendingReview = profileIsChiefEngineer(principal.profile) || profileIsEstablishedHoursChief(principal.profile);
  const technician = profileHasRole(principal.profile, 'technician');
  const actor: PmTaskActor = {
    id: principal.identity.id,
    name: principal.profile.full_name || 'CMPRI User',
    role: chief ? 'chief' : technician ? 'technician' : 'manager',
  };
  const canEdit = (chief || technician) && allows(principal, 'view_pm')
    && (profileHasRole(principal.profile, 'system_admin') || allows(principal, 'edit_tickets'))
    && canReadWorkOrderForMutation(workOrderReader(principal), workOrder);
  const canClearOwn = canReadWorkOrder(workOrderReader(principal), workOrder);
  return { actor, canEdit, canClearOwn, canClearAll: canClearOwn && (chief || (technician && canEdit)), canSeePendingReview };
}

/** Clearing a check removes its completion and review, without changing PM rules. */
export function changeTroubleshootingTask(
  access: { actor: PmTaskActor; canEdit: boolean; canClearOwn: boolean; canClearAll: boolean; canSeePendingReview: boolean },
  state: PmTaskState | undefined,
  action: 'toggle' | 'clear' = 'toggle',
): PmTaskState {
  const owner = Boolean(access.canClearOwn && state?.workerId === access.actor.id);
  const clear = action === 'clear'
    || (access.canClearAll && state?.status === 'approved')
    || (owner && access.actor.role !== 'chief' && (state?.workerChecked === true || state?.status === 'approved'));
  if (clear) {
    if (!access.canClearAll && !owner) throw new Error('Only the person who checked this step or a Chief Engineer can clear it.');
    return { status: 'empty' };
  }
  if (!access.canEdit) throw new Error('Troubleshooting checks are restricted to authorized Chief Engineers and technicians with access to this work order.');
  if (access.canSeePendingReview && !state?.workerChecked) return { status: 'needs', workerId: access.actor.id, workerName: access.actor.name, workerChecked: true };
  const next = tapTask(state, access.actor);
  // A Chief's direct completion still has a stable worker owner. Reviewing a
  // technician's existing completion retains that technician's ownership.
  return access.actor.role === 'chief' && !state?.workerChecked && next.status === 'approved'
    ? { ...next, workerId: access.actor.id, workerName: access.actor.name, workerChecked: true }
    : next;
}
