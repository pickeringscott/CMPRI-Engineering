const FRONT_DESK_SESSION_NAME_PREFIX = "cmpri:front-desk-employee-name:v1:";

export type SessionNameStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function frontDeskSessionId(accessToken: string | null | undefined) {
  if (!accessToken) return "";
  try {
    const encodedClaims = accessToken.split(".")[1];
    if (!encodedClaims) return "";
    const claims = JSON.parse(atob(encodedClaims.replace(/-/g, "+").replace(/_/g, "/"))) as { session_id?: unknown };
    return typeof claims.session_id === "string" ? claims.session_id : "";
  } catch {
    return "";
  }
}

function key(userId: string, sessionId: string) {
  return `${FRONT_DESK_SESSION_NAME_PREFIX}${userId}:${sessionId}`;
}

export function validEmployeeFullName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80 || !/^[\p{L}\p{M}][\p{L}\p{M}'’ -]*$/u.test(name)) return false;
  const parts = name.split(" ").filter(Boolean);
  if (parts.length === 1) {
    const letters = Array.from(name).filter((character) => /[\p{L}\p{M}]/u.test(character));
    return letters.length >= 2 && letters.every((character) => !/\p{Script=Latin}/u.test(character));
  }
  return parts.length >= 2 && parts.every((part) => {
    const letters = Array.from(part).filter((character) => /[\p{L}\p{M}]/u.test(character));
    return letters.length > 0 && !(letters.length === 1 && /\p{Script=Latin}/u.test(letters[0]));
  });
}

export function readFrontDeskEmployeeName(storage: SessionNameStorage, userId: string, sessionId: string) {
  if (!userId || !sessionId) return "";
  try {
    const value = storage.getItem(key(userId, sessionId)) || "";
    return validEmployeeFullName(value) ? value.trim().replace(/\s+/g, " ") : "";
  } catch {
    return "";
  }
}

export function saveFrontDeskEmployeeName(storage: SessionNameStorage, userId: string, sessionId: string, name: string) {
  if (!userId || !sessionId) return false;
  try {
    if (!validEmployeeFullName(name)) {
      storage.removeItem(key(userId, sessionId));
      return false;
    }
    storage.setItem(key(userId, sessionId), name.trim().replace(/\s+/g, " "));
    return true;
  } catch {
    return false;
  }
}

export function clearFrontDeskEmployeeName(storage: SessionNameStorage, userId: string, sessionId: string) {
  if (!userId || !sessionId) return;
  try { storage.removeItem(key(userId, sessionId)); } catch {}
}
