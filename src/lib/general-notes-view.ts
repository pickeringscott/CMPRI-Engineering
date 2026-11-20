import {noteStorageKey,type NoteScope} from './general-notes';

type NoteViewStorage=Pick<Storage,'getItem'|'setItem'>;
const noteViewKey=(scope:NoteScope)=>noteStorageKey(scope)+':active-note';

/** Navigation only. The existing scoped outbox remains the source of unsaved
 * text, check states, formatting and ink; this record stores no note contents. */
export function readActiveNote(storage:NoteViewStorage,scope:NoteScope):string|null{
 try{
  const value=storage.getItem(noteViewKey(scope));
  return value&&value.length<=200&&!/[\u0000-\u001f\u007f]/.test(value)?value:null;
 }catch{return null}
}
export function rememberActiveNote(storage:NoteViewStorage,scope:NoteScope,id:string){
 if(!id||id.length>200||/[\u0000-\u001f\u007f]/.test(id))return;
 try{storage.setItem(noteViewKey(scope),id)}catch{/* Selection is optional; durable editor recovery has its own explicit status. */}
}
