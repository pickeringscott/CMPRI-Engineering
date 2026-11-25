import { DOMParser } from '@xmldom/xmldom';
import type { NotepadDocument, NotepadPerson, NotepadReply, NotepadReplyMention, NotepadAttachment } from '../notepad';
import { NOTEPAD_ROLES, NOTEPAD_UUID } from '../notepad';
import type { InkStroke } from '../general-notes';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const safeId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(v);
const escape = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const finite = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
const color = (v: string) => /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]{1,24})$/i.test(v);
const allowedTags = new Set(['p','div','span','br','strong','b','em','i','u','s','strike','ul','ol','li','blockquote','h1','h2','h3','h4','h5','h6','input']);
const discardTags = new Set(['script','style','iframe','object','embed','svg','math','template','noscript','textarea','select','button','link','meta','base','form']);
const allowedClasses = new Set(['note-check','task-label','mention','np-format-list']);
const dataAttributes = new Set(['data-item-id','data-task-id','data-mention-id','data-mention-kind','data-list-level','data-depth','data-base-level','data-format-list','data-format-style','data-format-caret','data-completed-by','data-completed-at']);
function styles(raw: string) {
  return raw.split(';').map(part => {
    const at = part.indexOf(':'); if (at < 0) return '';
    const key = part.slice(0, at).trim().toLowerCase(), value = part.slice(at + 1).trim();
    if (/url\s*\(|expression\s*\(|[<>\\{}]/i.test(value)) return '';
    const valid = (key === 'font-family' && /^[\p{L}\p{N}\s,"'._()+&/\-]{1,300}$/u.test(value))
      || ((key === 'font-size' || key === '--np-marker-size') && /^(?:[6-9]|[1-8]\d|9[0-6])(?:\.\d+)?px$/.test(value))
      || ((key === 'color' || key === 'background-color') && color(value))
      || (key === 'font-weight' && /^(normal|bold|[1-9]00)$/.test(value))
      || (key === 'font-style' && /^(normal|italic|oblique)$/.test(value))
      || (key === 'text-decoration' && /^(none|underline|line-through)( (underline|line-through))?$/.test(value))
      || (key === 'text-align' && /^(left|center|right|justify|start|end)$/.test(value))
      || (key === 'list-style-type' && /^(disc|circle|square|decimal|lower-alpha|upper-alpha|lower-roman|upper-roman|none)$/.test(value))
      || ((key === 'margin-left' || key === 'margin-inline-start') && /^(0|20px|40px|\d{1,7}px)$/.test(value) && (['0','20px','40px'].includes(value) || parseInt(value,10)%24===0));
    return valid ? key + ':' + value : '';
  }).filter(Boolean).join(';');
}
function parse(content: string) {
  // The serializer below reconstructs only allowlisted HTML, never returning parser HTML.
  return new DOMParser({ errorHandler: { warning() {}, error() {}, fatalError() {} } }).parseFromString('<div>' + content + '</div>', 'text/html').documentElement;
}
function elements(node: Node): Element[] {
  const result: Element[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) if (child.nodeType === 1) { result.push(child as Element); result.push(...elements(child)); }
  return result;
}
function firstText(node: Node): Node | null {
  if (node.nodeType === 3 && node.nodeValue) return node;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    const text = firstText(child);
    if (text) return text;
  }
  return null;
}
function serialize(node: Node): string {
  if (node.nodeType === 3) return escape(node.nodeValue || '');
  if (node.nodeType !== 1) return '';
  const el = node as Element, tag = el.tagName.toLowerCase();
  if (discardTags.has(tag)) return '';
  const children = () => Array.from(el.childNodes).map(serialize).join('');
  if (!allowedTags.has(tag)) return children();
  if (tag === 'span' && el.hasAttribute('data-notepad-attachment-id')) {
    const id = el.getAttribute('data-notepad-attachment-id') || '';
    // Store just the reference. The editor supplies the thumbnail separately.
    return NOTEPAD_UUID.test(id) ? '<span data-notepad-attachment-id="' + id + '" contenteditable="false"></span>' : children();
  }
  if (tag === 'input' && el.getAttribute('type') !== 'checkbox') return '';
  const attrs: string[] = [];
  for (const attr of Array.from(el.attributes)) {
    const key = attr.name.toLowerCase(), value = attr.value;
    if (key === 'class') { const names = value.split(/\s+/).filter(n => allowedClasses.has(n)); if (names.length) attrs.push('class="' + names.join(' ') + '"'); }
    else if (key === 'style') { const css = styles(value); if (css) attrs.push('style="' + escape(css) + '"'); }
    else if (dataAttributes.has(key) && value.length <= 160 && /^[a-zA-Z0-9_.:\-+TZ ]*$/.test(value)) attrs.push(key + '="' + escape(value) + '"');
    else if (['contenteditable','spellcheck'].includes(key) && /^(true|false)$/.test(value)) attrs.push(key + '="' + value + '"');
    else if (key === 'role' && value === 'textbox') attrs.push('role="textbox"');
    else if (key === 'aria-label') attrs.push('aria-label="' + escape(value.slice(0,200)) + '"');
    else if (tag === 'input' && key === 'type') attrs.push('type="checkbox"');
    else if (tag === 'input' && key === 'checked') attrs.push('checked="checked"');
    else if (tag === 'ol' && key === 'type' && /^[aA1iI]$/.test(value)) attrs.push('type="' + value + '"');
    else if (['ol','li'].includes(tag) && ['start','value'].includes(key) && /^\d{1,6}$/.test(value)) attrs.push(key + '="' + value + '"');
  }
  return '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + (['input','br'].includes(tag) ? '' : children() + '</' + tag + '>');
}
export function sanitizeNotepadHTML(content: string): string {
  const root = parse(content);
  for (const el of elements(root)) {
    if (el.getAttribute('data-mention-kind') !== 'location' || !el.getAttribute('class')?.split(/\s+/).includes('mention')) continue;
    const text = firstText(el);
    if (text?.nodeValue?.startsWith('@')) text.nodeValue = text.nodeValue.slice(1);
  }
  return Array.from(root.childNodes).map(serialize).join('');
}
function checkedItems(content: string) {
  return new Map(elements(parse(content)).filter(el => el.getAttribute('class')?.split(/\s+/).includes('note-check')).map(el => {
    const checked = elements(el).some(child => child.tagName.toLowerCase() === 'input' && child.hasAttribute('checked'));
    return [el.getAttribute('data-item-id') || el.getAttribute('data-task-id') || '', { checked, by: el.getAttribute('data-completed-by') || '', at: el.getAttribute('data-completed-at') || '' }];
  }));
}
function attributedContent(content: string, previous: string, actor: string, now: string, files: NotepadAttachment[]) {
  const root = parse(sanitizeNotepadHTML(content)), old = checkedItems(previous), itemIds = new Set<string>();
  const unplacedAttachments = new Set(files.map(file => file.id));
  for (const el of elements(root)) {
    const attachmentId = el.getAttribute('data-notepad-attachment-id');
    if (attachmentId && !unplacedAttachments.delete(attachmentId)) {
      el.parentNode?.removeChild(el);
      continue;
    }
    const id = el.getAttribute('data-item-id'); if (id) { if (itemIds.has(id)) throw Error('Every note item needs a unique identity.'); itemIds.add(id); }
    if (!el.getAttribute('class')?.split(/\s+/).includes('note-check')) continue;
    const isChecked = elements(el).some(child => child.tagName.toLowerCase() === 'input' && child.hasAttribute('checked'));
    const before = old.get(id || el.getAttribute('data-task-id') || '');
    el.removeAttribute('data-completed-by'); el.removeAttribute('data-completed-at');
    if (isChecked) {
      if (before?.checked) { if (before.by && before.at) { el.setAttribute('data-completed-by',before.by); el.setAttribute('data-completed-at',before.at); } }
      else { el.setAttribute('data-completed-by',actor); el.setAttribute('data-completed-at',now); }
    }
  }
  return { content: Array.from(root.childNodes).map(serialize).join(''), itemIds };
}
function font(value: unknown, fallback: string) { if (value === undefined || value === '') return fallback; if (typeof value !== 'string' || !/^[\p{L}\p{N} ._,'()+&/\-]{1,120}$/u.test(value)) throw Error('Choose a valid font.'); return value; }
function ink(value: unknown): InkStroke[] {
  if (!Array.isArray(value) || value.length > 5000) throw Error('Invalid handwriting.');
  return value.map(s => {
    if (!record(s) || !safeId(s.id) || typeof s.color !== 'string' || !color(s.color) || !finite(s.size,1,24) || !Array.isArray(s.points) || s.points.length > 100000) throw Error('Invalid handwriting.');
    const points = s.points.map(p => { if (!record(p) || !finite(p.x,0,800) || !finite(p.y,0,1100) || !finite(p.p,0,1)) throw Error('Invalid handwriting point.'); return { x:p.x, y:p.y, p:p.p }; });
    return { id:s.id, color:s.color, size:s.size, points };
  });
}
function attachments(value: unknown): NotepadAttachment[] {
  if (!Array.isArray(value) || value.length > 1000) throw Error('Invalid attachments.');
  const ids = new Set<string>();
  return value.map(item => {
    if (!record(item) || !safeId(item.id) || ids.has(item.id) || typeof item.name !== 'string' || item.name.length > 255) throw Error('Invalid attachment.'); ids.add(item.id);
    if (item.kind === 'gif') { const gifId = item.gifId || item.id; if (typeof gifId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(gifId)) throw Error('Invalid GIF.'); return { id:item.id, kind:'gif', name:item.name, gifId }; }
    if (item.kind !== 'file' || !NOTEPAD_UUID.test(item.id) || typeof item.type !== 'string' || !/^[-\w.+]+\/[-\w.+]+$/.test(item.type) || !finite(item.size,1,104857600)) throw Error('Invalid file.');
    return { id:item.id, kind:'file', name:item.name, type:item.type, size:item.size };
  });
}
function replyMentions(value: unknown, text: string): NotepadReplyMention[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 500) throw Error('Invalid reply tags.');
  let previousEnd = 0;
  return value.map(mark => {
    if (!record(mark) || !safeId(mark.id)
      || (mark.kind !== 'person' && mark.kind !== 'role' && mark.kind !== 'department')
      || (mark.kind === 'person' && !NOTEPAD_UUID.test(mark.id))
      || typeof mark.start !== 'number' || !Number.isSafeInteger(mark.start) || mark.start < previousEnd
      || typeof mark.end !== 'number' || !Number.isSafeInteger(mark.end) || mark.end <= mark.start + 1 || mark.end > text.length
      || !/^@[^\r\n]+$/.test(text.slice(mark.start,mark.end))) throw Error('Invalid reply tags.');
    previousEnd = mark.end;
    return { id:mark.id, kind:mark.kind, start:mark.start, end:mark.end };
  });
}

/** Count actual selectable person tags, independently of text that just looks like a tag. */
export function notepadPersonTagCounts(document: NotepadDocument, directory?: readonly NotepadPerson[]) {
  const names = directory && new Map(directory.filter(person => person.active && person.taggable && person.recipientSelectable !== false)
    .map(person => [person.id, '@' + person.name]));
  const counts = new Map<string,number>();
  const count = (id: string, label: string) => {
    if (names ? names.get(id) === label : NOTEPAD_UUID.test(id) && /^@[^\r\n]+$/.test(label)) {
      counts.set(id,(counts.get(id) || 0) + 1);
    }
  };
  const body = document.content.includes('data-mention-kind') ? elements(parse(document.content)) : [];
  for (const el of body) {
    if (el.tagName.toLowerCase() !== 'span' || el.getAttribute('contenteditable') !== 'false'
      || el.getAttribute('data-mention-kind') !== 'person' || !el.getAttribute('class')?.split(/\s+/).includes('mention')) continue;
    count(el.getAttribute('data-mention-id') || '',el.textContent || '');
  }
  function visit(replies: NotepadReply[]) {
    for (const reply of replies) {
      for (const mark of reply.mentions || []) {
        if (mark.kind === 'person') count(mark.id,reply.text.slice(mark.start,mark.end));
      }
      visit(reply.replies || []);
    }
  }
  Object.values(document.itemThreads || {}).forEach(visit);
  return counts;
}
function sameReplyMentions(a: NotepadReplyMention[] = [], b: NotepadReplyMention[] = []) {
  return a.length === b.length && a.every(({id,kind,start,end},index) => {
    const next = b[index];
    return id === next.id && kind === next.kind && start === next.start && end === next.end;
  });
}
function draftSnapshot(document: NotepadDocument) {
  return JSON.stringify([
    document.title, {all:document.audience.all,roles:[...document.audience.roles].sort(),people:[...document.audience.people].sort()},
    sanitizeNotepadHTML(document.content), document.priority, document.fontSize, document.fontFamily, document.titleFontFamily,
    document.ink, document.itemThreads, document.attachments.map(attachment => { const file = {...attachment}; delete file.url; return file; }),
  ]);
}
export function validateNotepadDocument(value: unknown, previous: NotepadDocument | null, actor: string, now: string): NotepadDocument {
  if (!record(value) || Object.keys(value).some(k => !['title','audience','content','priority','fontSize','fontFamily','titleFontFamily','ink','itemThreads','attachments','untouchedDraft'].includes(k))) throw Error('Supply a valid Notepad document.');
  if (value.untouchedDraft !== undefined && typeof value.untouchedDraft !== 'boolean') throw Error('Supply a valid draft state.');
  if (typeof value.title !== 'string' || value.title.length > 120 || typeof value.content !== 'string' || value.content.length > 1000000) throw Error('The note title or content is too long.');
  const a = value.audience;
  if (!record(a) || typeof a.all !== 'boolean' || !Array.isArray(a.roles) || !Array.isArray(a.people) || a.roles.length > 20 || a.people.length > 500 || a.roles.some(r => !NOTEPAD_ROLES.some(role => role.id === r)) || a.people.some(id => typeof id !== 'string' || !NOTEPAD_UUID.test(id))) throw Error('Choose valid recipients.');
  if (!['Low','Normal','High','Urgent'].includes(String(value.priority)) || !finite(value.fontSize,6,96)) throw Error('Invalid priority or text size.');
  const files = attachments(value.attachments);
  const { content,itemIds } = attributedContent(value.content,previous?.content || '',actor,now,files);
  if (!record(value.itemThreads)) throw Error('Invalid replies.');
  const oldReplies = new Map<string, NotepadReply>();
  const remember = (replies: NotepadReply[]) => { for (const reply of replies) { oldReplies.set(reply.id,reply); remember(reply.replies); } };
  Object.values(previous?.itemThreads || {}).forEach(remember);
  const seen = new Set<string>(); let count = 0;
  const replies = (input: unknown, depth: number): NotepadReply[] => {
    if (!Array.isArray(input) || depth > 20) throw Error('Invalid reply thread.');
    return input.map(r => {
      if (!record(r) || !safeId(r.id) || seen.has(r.id) || ++count > 5000 || typeof r.text !== 'string' || r.text.length > 4000 || !r.text.trim()) throw Error('Invalid reply.');
      seen.add(r.id); const old = oldReplies.get(r.id);
      const mentions = replyMentions(r.mentions,r.text);
      if (old && old.authorId !== actor && (old.text !== r.text || !sameReplyMentions(old.mentions,mentions))) {
        throw Error('Only the reply author may edit its text or tags.');
      }
      return { id:r.id, authorId:old?.authorId || actor, ...(old?.authorName ? {authorName:old.authorName} : {}),
        at:old?.at || now, text:r.text, ...(mentions ? {mentions} : {}), replies:replies(r.replies || [],depth+1) };
    });
  };
  const itemThreads: Record<string, NotepadReply[]> = Object.create(null);
  for (const [id,thread] of Object.entries(value.itemThreads)) if (itemIds.has(id)) itemThreads[id] = replies(thread,0);
  // Deleting a checklist/list item deliberately drops its whole linked thread.
  const document: NotepadDocument = { title:value.title, audience:{all:a.all,roles:[...new Set(a.roles as string[])].sort(),people:[...new Set(a.people as string[])].sort()}, content,
    priority:value.priority as NotepadDocument['priority'], fontSize:value.fontSize, fontFamily:font(value.fontFamily,'Comic Sans MS'),titleFontFamily:font(value.titleFontFamily,'Comic Sans MS'), ink:ink(value.ink), itemThreads,attachments:files };
  if (value.untouchedDraft !== undefined || previous?.untouchedDraft !== undefined) {
    // Once edited, an empty note never becomes an untouched draft again. Older
    // clients may omit the flag; preserve it only while the document is unchanged.
    const body = parse(document.content);
    const empty = !(body.textContent || '').replace(/[\s\u200b\u00a0]/g,'')
      && !elements(body).some(el => ['input','ul','ol','li','table','hr'].includes(el.tagName.toLowerCase()) || el.getAttribute('class')?.split(/\s+/).includes('mention'))
      && !document.ink.length && !document.attachments.length && !Object.keys(document.itemThreads).length;
    document.untouchedDraft = previous?.untouchedDraft !== false && value.untouchedDraft !== false
      && (value.untouchedDraft === true || previous?.untouchedDraft === true) && empty
      && (!previous || draftSnapshot(previous) === draftSnapshot(document));
  }
  return document;
}
