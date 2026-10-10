export const ROOM_OPERATIONS_RECOVERY_RETRY_LIMIT = 2;

export class RoomOperationsRecoveryIssue extends Error {
  readonly recoverable: boolean;

  constructor(message: string, recoverable: boolean) {
    super(message);
    this.name = "RoomOperationsRecoveryIssue";
    this.recoverable = recoverable;
  }
}

export function isRecoverableRoomOperationsValidationError(status: number, message: string) {
  if (status >= 500) return false;
  const normalized = message.toLocaleLowerCase("en-US");
  if (
    normalized.includes("older than the latest")
    || normalized.includes("not newer than the latest")
    || normalized.includes("cannot be compared with the latest")
    || normalized.includes("requires the current hotel date")
    || normalized.includes("report is printed for")
  ) return false;
  return /missing|unreadable|could not be read|could not be verified|not recognized|not mapped|not an active CMPRI room|more than once|invalid|incomplete|no verified room rows|reservation|must be a whole number|must contain a room number|identifier could not be mapped/i.test(message);
}

type RecoveryInput<TReport> = {
  recoveryAttempt: number;
  unresolved: string;
  previousReport: TReport | null;
};

type ValidationResult<TValidation> =
  | { ok: true; value: TValidation }
  | { ok: false; error: string; recoverable: boolean };

export async function extractAndValidateRoomOperations<TReport, TValidation>({
  extract,
  validate,
  onProgress,
}: {
  extract: (input: RecoveryInput<TReport>) => Promise<TReport>;
  validate: (report: TReport) => Promise<ValidationResult<TValidation>>;
  onProgress?: (phase: "extract" | "validate", recoveryAttempt: number, unresolved: string) => void;
}): Promise<{ report: TReport; validation: TValidation }> {
  let previousReport: TReport | null = null;
  let unresolved = "";

  for (let recoveryAttempt = 0; recoveryAttempt <= ROOM_OPERATIONS_RECOVERY_RETRY_LIMIT; recoveryAttempt += 1) {
    onProgress?.("extract", recoveryAttempt, unresolved);
    let report: TReport;
    try {
      report = await extract({ recoveryAttempt, unresolved, previousReport });
      previousReport = report;
    } catch (error) {
      if (!(error instanceof RoomOperationsRecoveryIssue) || !error.recoverable) throw error;
      unresolved = error.message;
      if (recoveryAttempt < ROOM_OPERATIONS_RECOVERY_RETRY_LIMIT) continue;
      break;
    }

    onProgress?.("validate", recoveryAttempt, unresolved);
    const result = await validate(report);
    if (result.ok) return { report, validation: result.value };
    if (!result.recoverable) throw new Error(result.error);
    unresolved = result.error;
    if (recoveryAttempt >= ROOM_OPERATIONS_RECOVERY_RETRY_LIMIT) break;
  }

  throw new Error(
    `Automatic image recovery exhausted ${ROOM_OPERATIONS_RECOVERY_RETRY_LIMIT} additional passes. `
    + `No room data was changed. Unresolved source detail: ${unresolved} `
    + "Please provide a clearer source image or correct only the listed room and field.",
  );
}
