import type { InkStroke } from './general-notes';
import type { TimeFormat } from './profile-preferences';

export const NOTEPAD_ROLES = [
  { id: 'engineer', label: 'Chief Engineer' },
  { id: 'technician', label: 'Maintenance Technician' },
  { id: 'manager', label: 'General Manager' },
  { id: 'assistant_manager', label: 'Assistant GM' },
  { id: 'front_desk_manager', label: 'Front Desk Manager' },
  { id: 'front_desk', label: 'Front Desk' },
  { id: 'housekeeping', label: 'Housekeeping' },
  { id: 'senior_management', label: 'Senior Management' },
  { id: 'system_admin', label: 'System Administrator' },
] as const;
export type NotepadRole = typeof NOTEPAD_ROLES[number]['id'];
export type NotepadAudience = { all: boolean; roles: string[]; people: string[] };
export type NotepadPerson = { id: string; name: string; short: string; initials: string; role: string; displayRole?: string; roles: string[]; active: boolean; taggable: boolean; recipientSelectable: boolean };
export type NotepadAttachment = { id: string; kind: 'file' | 'gif'; name: string; type?: string; size?: number; gifId?: string; url?: string };
export type NotepadReply = { id: string; authorId: string; authorName?: string; at: string; text: string; replies: NotepadReply[] };
export type NotepadDocument = {
  title: string; audience: NotepadAudience; content: string; priority: 'Low' | 'Normal' | 'High' | 'Urgent';
  fontSize: number; fontFamily: string; titleFontFamily: string; ink: InkStroke[];
  itemThreads: Record<string, NotepadReply[]>; attachments: NotepadAttachment[];
  /** New drafts remain reusable until the first edit, even after being cleared. */
  untouchedDraft?: boolean;
};
export type NotepadNote = NotepadDocument & {
  id: string; authorId: string; authorName?: string; createdAt: string; updatedAt: string; revision: number;
  legacySource?: 'general' | 'staff'; legacyRevision?: number; legacyVersion?: string;
};
export type NotepadBootstrap = {
  hotelId: string; userId: string; people: NotepadPerson[]; roles: Array<{ id: string; label: string }>;
  notes: NotepadNote[]; order: string[]; legacyAliases: Record<string, string>;
  timeFormat?: TimeFormat;
};
export const NOTEPAD_TEST_EMAILS = new Set(['assmgr@test.com', 'chief@test.com', 'frontmgr@test.com', 'gm@test.com', 'gpt@test.com', 'frontdesk@test.com']);
export const NOTEPAD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function notepadCanRead(note: Pick<NotepadNote, 'authorId' | 'audience'>, person: Pick<NotepadPerson, 'id' | 'roles' | 'active'>) {
  return person.active && (note.authorId === person.id || note.audience.all || note.audience.people.includes(person.id) || person.roles.some(role => note.audience.roles.includes(role)));
}
/** Drop server metadata and signed URLs before saving. */
export function notepadDocument(note: NotepadDocument): NotepadDocument {
  return { title: note.title, audience: note.audience, content: note.content, priority: note.priority,
    fontSize: note.fontSize, fontFamily: note.fontFamily, titleFontFamily: note.titleFontFamily,
    ink: note.ink, itemThreads: note.itemThreads,
    ...(typeof note.untouchedDraft === 'boolean' ? { untouchedDraft: note.untouchedDraft } : {}),
    attachments: note.attachments.map(attachment => { const copy = { ...attachment }; delete copy.url; return copy; }) };
}
