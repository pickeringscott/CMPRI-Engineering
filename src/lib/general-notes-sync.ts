import {automaticNoteTitle,noteDocument,noteStorageKey,parseGeneralNotes,type GeneralNote,type NoteSummary,type NoteScope,type NoteDocument} from './general-notes';
export type PendingNote={note:GeneralNote;expectedRevision:number|null;changeId:string;sequence:number;since:number};
export class NoteSyncError extends Error{status:number;constructor(message:string,status:number){super(message);this.status=status}}
export type NotesTransport={list:()=>Promise<NoteSummary[]>;read:(id:string)=>Promise<GeneralNote|null>;write:(pending:PendingNote,keepalive?:boolean,deleted?:boolean)=>Promise<GeneralNote|null>};
type Port=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export class GeneralNotesSync{
 readonly pending=new Map<string,PendingNote>();readonly cache=new Map<string,GeneralNote>();readonly summaries=new Map<string,NoteSummary>();readonly conflicts=new Set<string>();readonly ownChanges=new Set<string>();
 message='Loading notes…';ready=false;durable=true;composing=false;activeId:string|null=null;
 onState:()=>void=()=>{};onRemote:(note:GeneralNote|null,id:string)=>void=()=>{};
 private timers=new Map<string,ReturnType<typeof setTimeout>>();private flights=new Map<string,Promise<boolean>>();private failures=new Map<string,number>();private stopped=false;private refreshFlight:Promise<void>|null=null;private lastRefresh=0;
 private key:string;private outbox:string;
 private scope:NoteScope;private storage:Port;private transport:NotesTransport;private options:{idleMs:number;maxWaitMs:number};
 constructor(scope:NoteScope,storage:Port,transport:NotesTransport,options={idleMs:1000,maxWaitMs:5000}){this.scope=scope;this.storage=storage;this.transport=transport;this.options=options;this.key=noteStorageKey(scope)+':shared-cache';this.outbox=noteStorageKey(scope)+':outbox';}
 private emit(){if(!this.stopped)this.onState()}
 private protect(){try{this.storage.setItem(this.outbox,JSON.stringify([...this.pending.values()]));this.durable=true}catch{this.durable=false;this.message='Could not protect this draft locally. Keep Notes open until it syncs.'}this.emit()}
 private persistCache(){try{this.storage.setItem(this.key,JSON.stringify([...this.cache.values()]))}catch{/* The outbox, not this optional read cache, protects unsynced edits. */}}
 private cancelTimer(id:string){clearTimeout(this.timers.get(id));this.timers.delete(id)}
 private schedule(id:string,delay?:number){this.cancelTimer(id);const pending=this.pending.get(id);if(!pending||this.conflicts.has(id)||this.stopped||this.composing)return;const wait=delay??Math.max(0,Math.min(this.options.idleMs,this.options.maxWaitMs-(Date.now()-pending.since)));this.timers.set(id,setTimeout(()=>{this.timers.delete(id);void this.flush(id)},wait))}
 async start(){
  try{const raw=this.storage.getItem(this.key);for(const note of parseGeneralNotes(raw)){this.cache.set(note.id,note);this.summaries.set(note.id,note)}
   const data=JSON.parse(this.storage.getItem(this.outbox)||'[]');if(!Array.isArray(data))throw Error('Invalid outbox');
   for(const pending of data){parseGeneralNotes(JSON.stringify([pending.note]));if(!(pending.expectedRevision===null||Number.isSafeInteger(pending.expectedRevision))||typeof pending.changeId!=='string'||!Number.isSafeInteger(pending.sequence))throw Error('Invalid draft');this.pending.set(pending.note.id,pending);this.summaries.set(pending.note.id,pending.note)}
   this.ready=true;this.emit();await this.refresh(true);
   if(raw===null){for(const note of parseGeneralNotes(this.storage.getItem(noteStorageKey(this.scope))))if(!this.summaries.has(note.id))this.queue({...note,revision:0});this.persistCache()}
   for(const id of this.pending.keys())this.schedule(id,0);
  }catch{this.message='Saved drafts could not be loaded safely. Existing browser data has not been replaced.';this.emit()}
 }
 notes(){return [...this.summaries.values()].sort((a,b)=>b.updated-a.updated)}
 draft(id:string){return this.pending.get(id)?.note||this.cache.get(id)||null}
 queue(input:GeneralNote,finalize=true){
  if(!this.ready||this.stopped)return;
  const previous=this.pending.get(input.id),cached=this.cache.get(input.id),automatic=input.titleAutomatic||!input.title.trim();
  const title=automatic?automaticNoteTitle({...input,titleAutomatic:true},finalize):input.title.trim();
  const note={...input,title,titleAutomatic:automatic,revision:input.revision||1,updated:Date.now()};
  if(!cached&&!this.flights.has(note.id)&&!note.text.trim()&&!note.strokes.length&&automatic){this.pending.delete(note.id);this.summaries.delete(note.id);this.cancelTimer(note.id);this.message='No changes to save';this.protect();return}
  if(!this.conflicts.has(note.id)&&!this.flights.has(note.id)&&cached&&JSON.stringify(noteDocument(cached))===JSON.stringify(noteDocument(note))){this.pending.delete(note.id);this.cancelTimer(note.id);this.protect();return}
  if(previous&&JSON.stringify(noteDocument(previous.note))===JSON.stringify(noteDocument(note)))return;
  this.pending.set(note.id,{note,expectedRevision:previous?previous.expectedRevision:cached?.revision??(input.revision||null),changeId:crypto.randomUUID(),sequence:(previous?.sequence||0)+1,since:previous?.since||Date.now()});
  this.summaries.set(note.id,note);this.message=this.conflicts.has(note.id)?'Changed on another device. Your local draft is safe.':'Saved locally · Waiting to sync';this.protect();this.schedule(note.id);
 }
 setComposing(value:boolean){this.composing=value;if(value){for(const id of this.timers.keys())this.cancelTimer(id)}else for(const id of this.pending.keys())this.schedule(id)}
 finalize(id:string){const note=this.draft(id);if(note)this.queue(note,true)}
 async open(id:string){this.activeId=id;const pending=this.pending.get(id);if(pending)return pending.note;const cached=this.cache.get(id),summary=this.summaries.get(id);if(cached&&cached.revision===summary?.revision)return cached;const note=await this.transport.read(id);if(note){this.cache.set(id,note);this.summaries.set(id,note);this.persistCache()}else{this.cache.delete(id);this.summaries.delete(id)}this.emit();return note}
 async refresh(force=false){
  if(this.stopped)return;if(this.refreshFlight)return this.refreshFlight;if(!force&&Date.now()-this.lastRefresh<500)return;this.lastRefresh=Date.now();
  this.refreshFlight=(async()=>{try{const remote=await this.transport.list();if(this.stopped)return;this.summaries.clear();for(const summary of remote)this.summaries.set(summary.id,summary);for(const draft of this.pending.values())this.summaries.set(draft.note.id,draft.note);for(const id of this.cache.keys())if(!this.summaries.has(id)&&!this.pending.has(id))this.cache.delete(id);
   if(this.activeId&&!this.composing&&!this.pending.has(this.activeId)){const id=this.activeId,summary=this.summaries.get(id),cached=this.cache.get(id);if(!summary){this.cache.delete(id);this.onRemote(null,id)}else if(cached?.revision!==summary.revision){const note=await this.open(id);if(!this.pending.has(id))this.onRemote(note,id)}}
   this.message=this.conflicts.size?'Changed on another device. Your local draft is safe.':this.pending.size?'Saved locally · Waiting to sync':'Synced';this.emit();
  }catch(error){this.message=error instanceof Error?error.message:'Offline · Changes are protected on this device';this.emit()}finally{this.refreshFlight=null}})();return this.refreshFlight;
 }
 async flush(id:string,keepalive=false,drain=false):Promise<boolean>{
  this.cancelTimer(id);if(this.stopped||this.composing||this.conflicts.has(id))return false;
  const existing=this.flights.get(id);if(existing){const success=await existing;return drain&&this.pending.has(id)&&!this.conflicts.has(id)?this.flush(id,keepalive,true):success}
  const pending=this.pending.get(id);if(!pending)return true;
  const flight=(async()=>{try{this.message='Syncing…';this.emit();this.ownChanges.add(pending.changeId);if(this.ownChanges.size>200)this.ownChanges.delete(this.ownChanges.values().next().value!);const saved=await this.transport.write(pending,keepalive);if(this.stopped)return false;
    const latest=this.pending.get(id);if(saved){this.cache.set(id,saved);this.summaries.set(id,saved)}else{this.cache.delete(id);this.summaries.delete(id)}
    if(latest?.sequence===pending.sequence&&latest.changeId===pending.changeId)this.pending.delete(id);
    else if(latest&&saved){latest.expectedRevision=saved.revision;latest.note.revision=saved.revision;latest.since=Date.now();this.summaries.set(id,latest.note)}
    this.failures.delete(id);this.persistCache();this.message=this.pending.size?'Saved locally · Waiting to sync':'Synced';this.protect();return true;
   }catch(error){if(this.stopped)return false;if(error instanceof NoteSyncError&&error.status===409){this.conflicts.add(id);this.message='Changed on another device. Your local draft is safe.'}
    else{this.message=error instanceof Error?error.message:'Offline · Changes are protected on this device';if(!(error instanceof NoteSyncError&&[400,401,403,413,422].includes(error.status))){const failures=(this.failures.get(id)||0)+1;this.failures.set(id,failures);this.schedule(id,Math.min(60_000,5000*2**Math.min(failures-1,4)))}}
    this.emit();return false;
   }finally{this.flights.delete(id)}})();this.flights.set(id,flight);const success=await flight;if(success&&this.pending.has(id)){if(drain)return this.flush(id,keepalive,true);this.schedule(id)}return success;
 }
 async flushAll(keepalive=false){await Promise.all([...this.pending.keys()].map(id=>this.flush(id,keepalive,true)))}
 private removed(id:string){this.cancelTimer(id);this.cache.delete(id);this.summaries.delete(id);this.pending.delete(id);this.conflicts.delete(id);this.persistCache();this.message='Deleted';this.protect()}
 async remove(id:string){
  if(this.pending.has(id)&&!await this.flush(id,false,true)){
   // Explicit deletion may also discard an old local conflict when the server
   // confirms the note was already deleted; never erase a competing live edit.
   if(this.conflicts.has(id)&&await this.transport.read(id)===null){this.removed(id);return}
   throw Error('This note was not deleted. '+this.message);
  }
  const note=this.cache.get(id);if(!note)throw Error('Load a synced note before deleting it.');const pending:PendingNote={note,expectedRevision:note.revision,changeId:crypto.randomUUID(),sequence:0,since:Date.now()};this.ownChanges.add(pending.changeId);await this.transport.write(pending,false,true);this.removed(id);
 }

 // Explicit conflict recovery preserves both versions, rather than last-writer-wins.
 keepBoth(id:string){const pending=this.pending.get(id);if(!pending)return null;const copy={...pending.note,id:crypto.randomUUID(),revision:0,title:pending.note.title+' (copy)',titleAutomatic:false};this.pending.delete(id);this.conflicts.delete(id);this.cache.delete(id);this.summaries.delete(id);this.queue(copy);this.protect();void this.refresh(true);return copy}
 stop(){this.stopped=true;for(const id of this.timers.keys())this.cancelTimer(id)}
}
export function noteWriteDocument(pending:PendingNote):NoteDocument{return noteDocument(pending.note)}
