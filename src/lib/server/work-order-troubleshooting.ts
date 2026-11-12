import { allows, type Principal } from './access';
import { profileHasRole, profileIsChiefEngineer, profileIsChiefEngineerOrSystemAdmin, profileIsEstablishedHoursChief } from './roles';
import { workOrderReader } from './work-order-reader';
import { canReadWorkOrder, canReadWorkOrderForMutation } from '../work-order-read-policy';
import type {PmTaskActor} from '../pm/task-review';

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

export {changeTroubleshootingTask} from '../work-orders/troubleshooting-checklist';
