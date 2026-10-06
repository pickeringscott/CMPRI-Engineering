type EnseoPagePayloadShape = {
  configured: boolean;
  can_manage?: boolean;
  assignments: unknown[];
  assets: unknown[];
  locations: unknown[];
  history: unknown[];
  error?: string;
};

export function resolveEnseoPageResponse<T extends EnseoPagePayloadShape>(
  responseOk: boolean,
  value: unknown,
): { data: T | null; message: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { data: null, message: "Enseo assignments returned an invalid response." };
  }

  const payload = value as Record<string, unknown>;
  if (!responseOk && payload.configured !== false) {
    return {
      data: null,
      message: typeof payload.error === "string" ? payload.error : "Enseo assignments could not be loaded.",
    };
  }

  if (
    typeof payload.configured !== "boolean"
    || !Array.isArray(payload.assignments)
    || !Array.isArray(payload.assets)
    || !Array.isArray(payload.locations)
    || !Array.isArray(payload.history)
    || (payload.configured && typeof payload.can_manage !== "boolean")
  ) {
    return { data: null, message: "Enseo assignments returned an invalid response." };
  }

  return { data: value as T, message: null };
}

export function enseoSaveSuccessMessage(assignmentCount: number): string {
  return `Saved ${assignmentCount} device assignment${assignmentCount === 1 ? "" : "s"} as one atomic move batch.`;
}
