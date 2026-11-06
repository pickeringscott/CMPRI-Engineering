export type TicketEditState = { dirty: boolean; fingerprint: string; saving: boolean };
/** Recheck after the read: typing or saving may have started while it was in flight. */
export function canApplyTicketRefresh(startedFingerprint: string, current: TicketEditState) {
  return !current.dirty && !current.saving && startedFingerprint === current.fingerprint;
}
