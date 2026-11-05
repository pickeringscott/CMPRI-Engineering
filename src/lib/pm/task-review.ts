/** Completion ownership is independent of the Chief Engineer's review mark. */
export type PmTaskActor = { id: string; name: string; role: 'chief' | 'technician' | 'manager' };
export type PmTaskState = {
  status: 'empty' | 'needs' | 'approved';
  workerId?: string;
  workerName?: string;
  workerChecked?: boolean;
  reviewedBy?: string;
  poolSubmitted?: boolean;
  attachedFormStatus?: 'draft' | 'final';
};
export function taskComplete(state?: PmTaskState) {
  return state?.workerChecked === true || state?.status === 'approved';
}
export function taskVisual(state: PmTaskState | undefined, actor: PmTaskActor) {
  return actor.role === 'technician' ? (taskComplete(state) ? 'approved' : 'empty') : state?.status || 'empty';
}
export function taskEditable(state: PmTaskState | undefined, actor: PmTaskActor) {
  if (actor.role === 'manager') return false;
  if (state?.poolSubmitted) return actor.role === 'chief' && state.status === 'needs';
  return actor.role === 'chief' || !state?.workerChecked || state.workerId === actor.id;
}
export function tapTask(state: PmTaskState | undefined, actor: PmTaskActor, options: { pool?: boolean; poolLogFilled?: boolean; attachedForm?: boolean } = {}): PmTaskState {
  if (!taskEditable(state, actor)) throw new Error('This completion cannot be changed by this user.');
  const next: PmTaskState = { status: 'empty', ...state };
  if (options.pool && !next.poolSubmitted) {
    if (!options.poolLogFilled) throw new Error('Complete the matching daily Pool Log first.');
    return { ...next, status: actor.role === 'chief' ? 'approved' : 'needs', poolSubmitted: true, workerId: actor.id, workerName: actor.name, workerChecked: true };
  }
  if (next.poolSubmitted) {
    return { ...next, status: 'approved', reviewedBy: actor.name };
  }
  if (actor.role === 'chief') {
    next.status = next.workerChecked ? ({ empty: 'needs', needs: 'approved', approved: 'empty' } as const)[next.status] : next.status === 'approved' ? 'empty' : 'approved';
    next.reviewedBy = actor.name;
  } else {
    next.workerChecked = !next.workerChecked;
    next.workerId = actor.id;
    next.workerName = actor.name;
    next.status = next.workerChecked ? 'needs' : 'empty';
  }
  if (options.attachedForm) next.attachedFormStatus = next.status === 'approved' ? 'final' : 'draft';
  return next;
}
