import { ASSIGNABLE_ROLE_LABELS, profileHasRole, roleKey } from "./server/roles";
import { plainTextParts } from "./plain-text-links";

export type WorkOrderMention = { label: string; kind: "staff" | "role" };
export type MentionProfile = { id: string; full_name?: string | null; role: unknown; secondary_roles?: readonly unknown[]; preferences?: { notifications?: { mentions?: boolean } } | null };
export type RecipientMention = WorkOrderMention & { userIds: string[] };

/** People use first names; role labels always retain their entire position title. */
export function workOrderMentionDirectory(profiles: readonly MentionProfile[]): RecipientMention[] {
  const entries = new Map<string, RecipientMention>();
  function add(label: string, kind: WorkOrderMention["kind"], userIds: string[]) {
    const key = `${kind}:${label.toLocaleLowerCase()}`;
    const prior = entries.get(key);
    entries.set(key, { label: prior?.label || label, kind, userIds: [...new Set([...(prior?.userIds || []), ...userIds])] });
  }
  for (const label of [...ASSIGNABLE_ROLE_LABELS, "Senior Management", "System Administrator"]) {
    add(label, "role", profiles.filter(profile => profileHasRole(profile, roleKey(label))).map(profile => profile.id));
  }
  for (const profile of profiles) {
    const firstName = profile.full_name?.trim().split(/\s+/u)[0];
    if (firstName) add(firstName, "staff", [profile.id]);
  }
  return [...entries.values()].sort((a, b) => a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind));
}

export function workOrderStaffMentions(text: string, directory: readonly WorkOrderMention[]) {
  const urls = plainTextParts(text).filter(part => part.href);
  const longestFirst = [...directory].sort((a, b) => b.label.length - a.label.length);
  const matches: Array<{ start: number; end: number; mention: WorkOrderMention }> = [];
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    if (at > 0 && /[\p{L}\p{N}_]/u.test(text[at - 1])) continue;
    const mention = longestFirst.find(item => text.slice(at + 1, at + 1 + item.label.length).toLocaleLowerCase() === item.label.toLocaleLowerCase()
      && !/[\p{L}\p{N}_]/u.test(text[at + 1 + item.label.length] || ""));
    if (!mention) continue;
    const end = at + 1 + mention.label.length;
    if (urls.some(url => at < url.end && end > url.start)) continue;
    matches.push({ start: at, end, mention });
    at = end - 1;
  }
  return matches;
}

export function workOrderMentionRecipients(text: string, profiles: readonly MentionProfile[], actorId: string) {
  const directory = workOrderMentionDirectory(profiles);
  const ids = new Set(workOrderStaffMentions(text, directory).flatMap(match =>
    directory.filter(item => item.label.toLocaleLowerCase() === match.mention.label.toLocaleLowerCase()).flatMap(item => item.userIds)));
  return profiles.filter(profile => profile.id !== actorId && ids.has(profile.id) && profile.preferences?.notifications?.mentions !== false).map(profile => profile.id);
}

/** Resolve only new note lines. Retained history and change/system entries never alert again. */
export function addedWorkOrderNoteText(before: string, after: string) {
  const retained = new Map<string, number>();
  for (const line of before.split("\n")) retained.set(line, (retained.get(line) || 0) + 1);
  const added: string[] = [];
  for (const line of after.split("\n")) {
    const count = retained.get(line) || 0;
    if (count) { retained.set(line, count - 1); continue; }
    const attributed = line.match(/^CMPRI2\|[^|]+\|[^|]*\|[^|]*\|(note|change|system)\|(.*)$/)
      || line.match(/^CMPRI\|[^|]+\|[^|]*\|(note|change|system)\|(.*)$/);
    if (attributed?.[1] === "note") added.push(attributed[2]);
  }
  return added.join("\n");
}

export function workOrderMentionQuery(text: string, caret: number) {
  const prefix = text.slice(0, caret).match(/(?:^|[^\p{L}\p{N}_])@([^@\n]*)$/u);
  if (!prefix) return null;
  const start = caret - prefix[1].length - 1;
  if (plainTextParts(text).some(part => part.href && start >= part.start && start < part.end)) return null;
  return { start, end: caret, query: prefix[1].toLocaleLowerCase() };
}

export function insertWorkOrderMention(text: string, range: { start: number; end: number }, label: string) {
  const value = text.slice(0, range.start) + `@${label} ` + text.slice(range.end);
  return { value, caret: range.start + label.length + 2 };
}
