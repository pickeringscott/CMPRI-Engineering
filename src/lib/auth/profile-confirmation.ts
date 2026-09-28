export type ProfileConfirmationSession = {
  landing: "/work-orders" | "/technician" | "/engineering";
  user: { role: string };
  profile_setup_complete?: boolean;
};

type SessionStoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function normalizedRole(role: string) {
  return role.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function isFrontDeskRole(role: string) {
  return ["frontdesk", "assistantgm", "assistantgeneralmanager", "assistantmanager", "salesmanager"].includes(normalizedRole(role));
}

export function authSessionId(accessToken: string) {
  try {
    const encoded = accessToken.split(".")[1];
    if (!encoded) return "";
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as { session_id?: unknown; sid?: unknown; sub?: unknown; iat?: unknown };
    if (typeof payload.session_id === "string" && payload.session_id) return payload.session_id;
    if (typeof payload.sid === "string" && payload.sid) return payload.sid;
    if (typeof payload.sub === "string" && typeof payload.iat === "number") return `${payload.sub}:${payload.iat}`;
  } catch {}
  return "";
}

function frontDeskSessionKey(kind: "name" | "confirmed", sessionId: string) {
  return `cmpri:front-desk-${kind}:${sessionId}`;
}

export function readFrontDeskSessionName(storage: SessionStoragePort, sessionId: string) {
  if (!sessionId) return "";
  try { return storage.getItem(frontDeskSessionKey("name", sessionId)) || ""; }
  catch { return ""; }
}

export function saveFrontDeskSessionName(storage: SessionStoragePort, sessionId: string, name: string) {
  if (!sessionId) return;
  try {
    if (name.trim()) storage.setItem(frontDeskSessionKey("name", sessionId), name.trim());
    else storage.removeItem(frontDeskSessionKey("name", sessionId));
  } catch {}
}

export function isFrontDeskSessionConfirmed(storage: SessionStoragePort, sessionId: string) {
  if (!sessionId) return false;
  try { return storage.getItem(frontDeskSessionKey("confirmed", sessionId)) === "true"; }
  catch { return false; }
}

export function confirmFrontDeskSession(storage: SessionStoragePort, sessionId: string, name: string) {
  if (!sessionId || !name.trim()) return;
  try {
    saveFrontDeskSessionName(storage, sessionId, name);
    storage.setItem(frontDeskSessionKey("confirmed", sessionId), "true");
  } catch {}
}

export function needsManageProfileConfirmation(
  session: ProfileConfirmationSession,
  accessToken: string,
  storage: SessionStoragePort,
) {
  if (isFrontDeskRole(session.user.role)) return !isFrontDeskSessionConfirmed(storage, authSessionId(accessToken));
  return session.profile_setup_complete === false;
}

export function manageProfileConfirmationUrl(landing: ProfileConfirmationSession["landing"], frontDesk: boolean) {
  const params = new URLSearchParams({ first_login: "1", next: landing });
  if (frontDesk) params.set("shared_front_desk", "1");
  return `/profile?${params.toString()}`;
}

export function validFrontDeskFullName(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return parts.length >= 2 && parts.every((part) => (part.match(/[\p{L}\p{M}]/gu) || []).length >= 2)
    && /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}'’.-]*)+$/u.test(value.trim());
}
