import {validNoteStyles,type NoteTextStyle} from './general-note-formatting';
import {selectedStaffMentions,type StaffMentionRange} from './staff-note-targets';
/** First integration stage: personal, device-local notes; never work-order history. */
export type InkPoint = { x: number; y: number; p: number };
export type InkStroke = { id: string; color: string; size: number; points: InkPoint[] };
export type GeneralNote = { id: string; title: string; text: string; fontSize: number; strokes: InkStroke[]; revision: number; updated: number; titleAutomatic?: boolean; mentions?:StaffMentionRange[];textStyles?:NoteTextStyle[] };
export type NoteScope = { hotelId: string; userId: string };
export type TextEdit = { start: number; end: number; insert: string; caret?: number };
export const NOTE_FONT_SIZES = [8,10,12,14,16,18,20,22,24] as const;
export const NOTE_INDENT = '    ';
const prefix = /^([ \t]*)([☐☑•]) /;
export function noteStorageKey(scope: NoteScope) {
  if (!scope.hotelId || !scope.userId) throw Error('An authorized account and property are required.');
  return `cmpri:general-notes:v1:${encodeURIComponent(scope.hotelId)}:${encodeURIComponent(scope.userId)}`;
}
export function noteListInfo(text: string) {
  const match = prefix.exec(text);
  return match ? { indent: match[1], marker: match[2], length: match[0].length } : null;
}
export function noteLine(value: string, caret: number) {
  const start = value.slice(0,caret).lastIndexOf('\n')+1;
  const next = value.indexOf('\n',caret);
  return { start, end: next < 0 ? value.length : next, text: value.slice(start,next < 0 ? value.length : next) };
}
export function noteInputEdit(value: string, start: number, end: number, kind: 'return'|'backspace'): TextEdit | null {
  const line = noteLine(value,start), info = noteListInfo(line.text);
  if (!info) return null;
  if (kind === 'return') return { start,end,insert:'\n'+info.indent+(info.marker==='•'?'• ':'☐ ') };
  if (start!==end || start<=line.start || start>line.start+info.length) return null;
  return { start:line.start,end:line.start+info.length,insert:'' };
}
export function noteToggleList(value: string, a: number, b: number, kind: 'check'|'bullet'): TextEdit {
  const line = noteLine(value,a), marker = kind==='check'?'☐ ':'• ';
  if(a===b && a===line.end && line.text.trim() && !noteListInfo(line.text)) return { start:a,end:b,insert:'\n'+NOTE_INDENT+marker };
  const last = b>a && value[b-1]==='\n' ? b-1:b;
  const end = noteLine(value,last).end, old = value.slice(line.start,end), lines = old.split('\n');
  const remove = lines.every(text=>{const info=noteListInfo(text);return info && (kind==='bullet'?info.marker==='•':info.marker!=='•')});
  // Only a preceding plain-text line supplies a list header. Preserve an existing
  // list's indentation, including an intentionally unindented list.
  const preceding=value.slice(0,line.start).split('\n').reverse().find(text=>text.trim());
  const indent=preceding && !noteListInfo(preceding) ? NOTE_INDENT : '';
  const insert = lines.map(text=>{
    const info=noteListInfo(text);
    if(remove) return text.replace(prefix,'');
    return (info ? info.indent : indent)+marker+text.replace(prefix,'').replace(/^[ \t]+/,'');
  }).join('\n');
  const caret = a===b ? Math.max(line.start+(noteListInfo(insert)?.length||0),a-(noteListInfo(old)?.length||0)+(noteListInfo(insert)?.length||0)):undefined;
  return { start:line.start,end,insert,caret };
}
export function applyNoteTextEdit(value: string, edit: TextEdit) {
  return { value:value.slice(0,edit.start)+edit.insert+value.slice(edit.end),caret:edit.caret??edit.start+edit.insert.length };
}
function finite(value: unknown,min: number,max: number): value is number { return typeof value==='number' && Number.isFinite(value) && value>=min && value<=max; }
function validStroke(value: unknown): value is InkStroke {
  if(!value || typeof value!=='object')return false;
  const s=value as InkStroke;
  return typeof s.id==='string' && s.id.length>0 && typeof s.color==='string' && s.color.length<100 && finite(s.size,1,12)
    && Array.isArray(s.points) && s.points.length<=100000 && s.points.every(p=>p&&finite(p.x,0,800)&&finite(p.y,0,1100)&&finite(p.p,0,1));
}
export function parseGeneralNotes(raw: string | null): GeneralNote[] {
  if(raw===null)return [];
  const data: unknown=JSON.parse(raw);
  if(!Array.isArray(data) || data.length>500)throw Error('Saved notebook could not be read. Existing data has not been changed.');
  const ids=new Set<string>();
  for(const n of data){
    if(!n || typeof n.id!=='string' || !n.id || ids.has(n.id) || typeof n.title!=='string' || !n.title.trim() || n.title.length>120
      || (n.titleAutomatic!==undefined&&typeof n.titleAutomatic!=='boolean') || typeof n.text!=='string' || n.text.length>100000 || selectedStaffMentions(n.text,n.mentions)===null || !validNoteStyles(n.text,n.textStyles) || !NOTE_FONT_SIZES.includes(n.fontSize) || !Number.isInteger(n.revision) || n.revision<1
      || !finite(n.updated,0,Number.MAX_SAFE_INTEGER) || !Array.isArray(n.strokes) || n.strokes.length>5000 || !n.strokes.every(validStroke)) {
      throw Error('Saved notebook could not be read. Existing data has not been changed.');
    }
    ids.add(n.id);
  }
  return data;
}
export function saveGeneralNote(storage: Pick<Storage,'getItem'|'setItem'>, scope: NoteScope, note: GeneralNote, expectedRevision: number | null) {
  const key=noteStorageKey(scope),notes=parseGeneralNotes(storage.getItem(key)),prior=notes.find(n=>n.id===note.id);
  if((prior?.revision??null)!==expectedRevision)throw Error('This note changed in another window. Download your draft before reopening the saved note.');
  const next=[...notes.filter(n=>n.id!==note.id),{...note,revision:(prior?.revision||0)+1}];
  parseGeneralNotes(JSON.stringify(next)); // Validate before replacing any saved data.
  storage.setItem(key,JSON.stringify(next));
  return next;
}

export type NoteDocument = Pick<GeneralNote,'title'|'text'|'fontSize'|'strokes'|'titleAutomatic'|'mentions'|'textStyles'>;
export type NoteSummary = Pick<GeneralNote,'id'|'title'|'revision'|'updated'> & {text?:string};
/** Canonicalize nested JSON too: PostgreSQL JSONB can reorder object keys.
 * Equality must not turn an unchanged page into a new pending mutation. */
export function noteDocument(note:NoteDocument):NoteDocument {return {title:note.title,text:note.text,fontSize:note.fontSize,strokes:note.strokes.map(stroke=>({id:stroke.id,color:stroke.color,size:stroke.size,points:stroke.points.map(point=>({x:point.x,y:point.y,p:point.p}))})),titleAutomatic:note.titleAutomatic??false,...(note.mentions?.length?{mentions:note.mentions.map(mention=>({id:mention.id,kind:mention.kind,label:mention.label,start:mention.start,end:mention.end}))}:{}),...(note.textStyles?.length?{textStyles:note.textStyles.map(style=>({start:style.start,end:style.end,...(style.fontSize!==undefined?{fontSize:style.fontSize}:{}),...(style.color!==undefined?{color:style.color}:{})}))}:{})}}

export function automaticNoteTitle(note:Pick<GeneralNote,'title'|'text'|'strokes'|'titleAutomatic'|'mentions'|'textStyles'>,finalize=false){
 if(!note.titleAutomatic&&note.title.trim())return note.title.trim().slice(0,120);
 if(!finalize||note.strokes.length)return 'Untitled';
 return note.text.split('\n').map(line=>line.replace(/^[ \t]*(?:[☐☑•] )?/,'').trim()).find(Boolean)?.slice(0,120)||'Untitled';
}
export function validNoteDocument(value:unknown):value is NoteDocument {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['title','text','fontSize','strokes','titleAutomatic','mentions','textStyles'].includes(key)))return false;
 try{parseGeneralNotes(JSON.stringify([{...value,id:'validation',revision:1,updated:0}]));return true}catch{return false}
}
