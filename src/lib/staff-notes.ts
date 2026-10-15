import { profileHasRole, roleKey } from "./server/roles";

export type StaffProfile = { id: string; full_name?: string | null; role: unknown; secondary_roles?: readonly unknown[] };
export const STAFF_ROLE_MENTIONS = [
  ["Chief Engineer", "engineer"], ["Maintenance Technician", "technician"],
  ["General Manager", "manager"], ["Assistant General Manager", "assistant_manager"],
  ["Front Desk Manager", "front_desk_manager"], ["Front Desk", "front_desk"],
  ["Lead Housekeeper", "housekeeping"], ["Housekeeping", "housekeeping"],
] as const;
export function staffManagement(profile: Pick<StaffProfile, "role" | "secondary_roles">) {
  return ["engineer", "technician", "manager", "assistant_manager", "front_desk_manager", "system_admin"]
    .some(role => profileHasRole(profile, role as ReturnType<typeof roleKey>));
}
export function staffPhoneEligible(profile: Pick<StaffProfile, "role" | "secondary_roles">) {
  // A Front Desk account never receives Staff Notes phone alerts, including mixed assignments.
  return !profileHasRole(profile, "front_desk") && (staffManagement(profile) || profileHasRole(profile, "housekeeping"));
}
export type StaffMention = { label: string; userIds: string[] };
export function staffMentionDirectory(profiles: StaffProfile[]): StaffMention[] {
  const entries = new Map<string, StaffMention>();
  const add = (label: string, userIds: string[]) => {
    if (!label) return;
    const key = label.toLocaleLowerCase();
    const prior = entries.get(key);
    entries.set(key, { label: prior?.label || label, userIds: [...new Set([...(prior?.userIds || []), ...userIds])] });
  };
  for (const [label, role] of STAFF_ROLE_MENTIONS) add(label, profiles.filter(p => profileHasRole(p, role)).map(p => p.id));
  for (const profile of profiles) {
    const full = profile.full_name?.trim().replace(/\s+/g, " ");
    if (!full) continue;
    add(full, [profile.id]);
    const first = full.split(" ")[0];
    // Ambiguous first names require the full name.
    if (profiles.filter(p => p.full_name?.trim().split(/\s+/)[0].toLowerCase() === first.toLowerCase()).length === 1) add(first, [profile.id]);
  }
  return [...entries.values()].sort((a, b) => b.label.length - a.label.length || a.label.localeCompare(b.label));
}
export function staffMentionMatches(body: string, directory: StaffMention[]) {
  const matches: Array<{ start: number; end: number; mention: StaffMention }> = [];
  for (let at = body.indexOf("@"); at >= 0; at = body.indexOf("@", at + 1)) {
    if (at > 0 && /[\p{L}\p{N}_]/u.test(body[at - 1])) continue;
    const mention = directory.find(item => body.slice(at + 1, at + 1 + item.label.length).toLowerCase() === item.label.toLowerCase()
      && !/[\p{L}\p{N}_]/u.test(body[at + 1 + item.label.length] || ""));
    if (mention) matches.push({ start: at, end: at + 1 + mention.label.length, mention });
  }
  return matches;
}
export function staffRecipients(body: string, profiles: StaffProfile[]) {
  const mentioned = new Set(staffMentionMatches(body, staffMentionDirectory(profiles)).flatMap(m => m.mention.userIds));
  return profiles.filter(p => staffManagement(p) || mentioned.has(p.id))
    .map(p => ({ user_id: p.id, push: staffPhoneEligible(p) }));
}
export function staffTicketNumbers(body: string) {
  return [...new Set([...body.matchAll(/(?:@work\s+order\s+|#)(\d{1,12})\b/gi)].map(m => m[1]))];
}

/** Completion uses the same canonical directory as recipient resolution. */
export function staffMentionCompletion(body: string, caret: number, directory: StaffMention[]) {
  const prefix = body.slice(0, caret).match(/(?:^|[^\p{L}\p{N}_])@([^@\n]*)$/u);
  if (!prefix?.[1]) return null;
  const typed = prefix[1];
  if (directory.some(item => item.label.toLowerCase() === typed.toLowerCase())) return null;
  const mention = directory.find(item => item.label.toLowerCase().startsWith(typed.toLowerCase()));
  return mention ? { mention, start: caret - typed.length, typed, suffix: mention.label.slice(typed.length) } : null;
}
