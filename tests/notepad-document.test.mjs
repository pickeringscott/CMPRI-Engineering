import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNotepadDocument,sanitizeNotepadHTML } from '../src/lib/server/notepad-document.ts';
import { legacyGeneralNote } from '../src/lib/notepad-legacy.ts';
import { legacyStaffNotes } from '../src/lib/server/notepad-store.ts';
import { notepadCanRead,notepadDocument } from '../src/lib/notepad.ts';
const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
const now='2026-11-23T14:00:00.000Z';
const base=()=>({title:'Project',audience:{all:false,roles:['engineer','technician'],people:[]},content:'<p data-item-id="intro">Intro</p><div class="note-check" contenteditable="false" data-item-id="task"><input type="checkbox"><span class="task-label" contenteditable="true">Work</span></div>',priority:'Normal',fontSize:16,fontFamily:'Comic Sans MS',titleFontFamily:'Georgia',ink:[],itemThreads:{},attachments:[]});
test('allowlisted rich HTML preserves toolbar/list/ink semantics and eliminates executable content',()=>{
 const value='<svg><script>alert(1)</script></svg><p onclick="x()" data-item-id="p" style="font-family:Georgia; background-image:url(https://bad.invalid);color:#ff0000;text-align:center"><b>Hello</b><img src=x onerror=x()><a href="javascript:x()">world</a></p><ol class="np-format-list evil" type="a" style="list-style-type:lower-alpha"><li data-item-id="li">item</li></ol>';
 const safe=sanitizeNotepadHTML(value);assert.doesNotMatch(safe,/script|svg|onclick|onerror|javascript|https:|<img|href|evil/);assert.match(safe,/font-family:Georgia;color:#ff0000;text-align:center/);assert.match(safe,/<ol class="np-format-list" type="a" style="list-style-type:lower-alpha">/);
 const doc=validateNotepadDocument({...base(),content:value},null,a,now);assert.equal(doc.titleFontFamily,'Georgia');assert.match(doc.content,/<b>Hello<\/b>world/);
 const nested='<ol class="np-format-list" data-format-list="letter" data-base-level="3" style="list-style-type:decimal;margin-inline-start:48px"><li data-item-id="nested" data-list-level="3" data-depth="2">Third level</li></ol>';
 assert.equal(sanitizeNotepadHTML(nested),nested);
 const localFont='<span style="font-family:&quot;M+ (Book)&quot;, &quot;Comic Sans MS&quot;, cursive">Installed font</span>';
 assert.equal(sanitizeNotepadHTML(localFont),localFont);assert.equal(validateNotepadDocument({...base(),titleFontFamily:'M+ (Book)'},null,a,now).titleFontFamily,'M+ (Book)');
});
test('new completions and replies use authenticated author/time, and old attribution survives other edits',()=>{
 const d=base();d.content=d.content.replace('type="checkbox"','type="checkbox" checked');d.itemThreads.task=[{id:'reply',authorId:'forged',at:'1900-01-01',text:'Done',replies:[]}];
 const saved=validateNotepadDocument(d,null,b,now);assert.match(saved.content,new RegExp('data-completed-by="'+b+'"'));assert.match(saved.content,/data-completed-at="2026-11-23T14:00:00.000Z"/);assert.equal(saved.itemThreads.task[0].authorId,b);assert.equal(saved.itemThreads.task[0].at,now);
 const next=validateNotepadDocument({...saved,title:'Renamed'},saved,a,'2026-11-24T00:00:00Z');assert.equal(next.content,saved.content);assert.deepEqual(next.itemThreads,saved.itemThreads);
 assert.throws(()=>validateNotepadDocument({...saved,itemThreads:{task:[{...saved.itemThreads.task[0],text:'Changed by someone else'}]}},saved,a,now),/reply author/);
 const unchecked=validateNotepadDocument({...saved,content:saved.content.replace(' checked="checked"','')},saved,a,now);assert.doesNotMatch(unchecked.content,/data-completed-/);
 const removed=validateNotepadDocument({...saved,content:'<p data-item-id="intro">Intro</p>'},saved,a,now);assert.equal(Object.keys(removed.itemThreads).length,0);
});
test('malformed note IDs, oversized coordinates and arbitrary attachment URLs are not persisted',()=>{
 assert.throws(()=>validateNotepadDocument({...base(),audience:{all:false,roles:['evil'],people:[]}},null,a,now));
 assert.throws(()=>validateNotepadDocument({...base(),ink:[{id:'ink',color:'red',size:2,points:[{x:801,y:4,p:.5}]}]},null,a,now));
 const file={id:a,kind:'file',name:'photo.jpg',type:'image/jpeg',size:10,url:'https://untrusted.invalid/'};
 const doc=validateNotepadDocument({...base(),attachments:[file]},null,a,now);assert.equal(doc.attachments[0].url,undefined);assert.equal(notepadDocument({...base(),attachments:[file]}).attachments[0].url,undefined);
});
test('legacy personal Notes retain text formatting, selected mentions, checkboxes, fonts and vector ink privately',()=>{
 const text='☐ Review @Isaiah\n☑ Done';
 const strokes=[{id:'stroke',color:'rgb(1,2,3)',size:4,points:[{x:20,y:40,p:.5}]}];
 const note=legacyGeneralNote(a,b,{title:'Original',text,fontSize:18,strokes,mentions:[{id:b,kind:'person',label:'Isaiah',start:9,end:16}],textStyles:[{start:2,end:8,fontSize:22,color:'rgb(1,2,3)'}]},now);
 assert.deepEqual(note.ink,strokes);assert.equal(note.revision,0);assert.equal(note.fontSize,18);assert.deepEqual(note.audience,{all:false,roles:[],people:[]});assert.match(note.content,/font-size:22px/);assert.match(note.content,/data-mention-id/);assert.match(note.content,/checked="checked"/);
});
test('legacy Staff Notes preserve entered author names, nested threads, files and all-property visibility',()=>{
 const file={id:a,name:'image.jpg',type:'image/jpeg',size:100};
 const {notes,aliases}=legacyStaffNotes([{id:a,author_user_id:a,author_name:'FD Name',body:'Shift handoff',parent_id:null,created_at:now,attachments:[],gif_ids:[]},{id:b,author_user_id:b,author_name:'Isaiah',body:'Reply',parent_id:a,created_at:now,attachments:[file],gif_ids:['GIFid']}]);
 assert.equal(notes.length,1);assert.equal(notes[0].authorName,'FD Name');assert.equal(notes[0].audience.all,true);assert.equal(notes[0].attachments.length,2);assert.equal(notes[0].itemThreads['legacy-staff-'+a][0].authorName,'Isaiah');assert.equal(aliases[b],a);
 const onlyAttachment=legacyStaffNotes([{id:a,author_user_id:a,author_name:'FD Name',body:'',parent_id:null,created_at:now,attachments:[file],gif_ids:[]},{id:b,author_user_id:b,author_name:'Isaiah',body:'Reply to photo',parent_id:a,created_at:now,attachments:[],gif_ids:[]}]).notes[0];
 assert.match(onlyAttachment.content,/>\(Attachment\)<\/p>/);const saved=validateNotepadDocument(notepadDocument(onlyAttachment),notepadDocument(onlyAttachment),b,now);assert.equal(saved.itemThreads['legacy-staff-'+a][0].text,'Reply to photo');
});
test('audience access never grants private notes by manager status or inactive membership',()=>{
 const note={authorId:a,audience:{all:false,roles:[],people:[]}};
 assert.equal(notepadCanRead(note,{id:b,roles:['system_admin'],active:true}),false);
 assert.equal(notepadCanRead({...note,audience:{all:false,roles:['technician'],people:[]}},{id:b,roles:['technician'],active:true}),true);
 assert.equal(notepadCanRead({...note,audience:{all:true,roles:[],people:[]}},{id:b,roles:['technician'],active:false}),false);
});
test('untouched drafts persist through document projection and older callers without relying on their title or age',()=>{
 const draft=validateNotepadDocument({...base(),title:'Future project',content:'',untouchedDraft:true},null,a,now);
 assert.equal(draft.untouchedDraft,true);
 assert.equal(notepadDocument(draft).untouchedDraft,true);
 const older=notepadDocument(draft);delete older.untouchedDraft;
 const reread=validateNotepadDocument(older,draft,a,'2027-12-31T01:00:00.000Z');
 assert.equal(reread.untouchedDraft,true);
 const reordered={...older,audience:{...older.audience,roles:[...older.audience.roles].reverse()}};
 assert.equal(validateNotepadDocument(reordered,draft,a,now).untouchedDraft,true);
 const unflagged={...base(),content:''};
 assert.equal(validateNotepadDocument(unflagged,unflagged,a,now).untouchedDraft,undefined,'Existing untracked notes are not silently classified as drafts');
 assert.equal(notepadDocument(unflagged).untouchedDraft,undefined);
 assert.equal(validateNotepadDocument({...unflagged,untouchedDraft:true},unflagged,a,now).untouchedDraft,true,'A known untouched pre-update draft may be marked without altering its content');
 for(const content of ['<p><br></p>','<p>\u00a0\u200b </p>']) {
  const blank={...unflagged,content};
  const inferred=validateNotepadDocument({...blank,untouchedDraft:true},blank,a,now);
  assert.equal(inferred.untouchedDraft,true,'Browser empty paragraphs stay reusable');
  assert.equal(inferred.content,sanitizeNotepadHTML(content),'Draft tracking does not rewrite the sanitized body');
 }
});
test('the first change retires an untouched draft even for omitted flags, and clearing edits cannot resurrect it',()=>{
 const draft=validateNotepadDocument({...base(),content:'',untouchedDraft:true},null,a,now);
 const older=notepadDocument(draft);delete older.untouchedDraft;
 for(const patch of [
  {title:'Renamed'}, {content:'<p>Started work</p>'}, {priority:'High'}, {fontSize:18}, {fontFamily:'Arial'}, {titleFontFamily:'Arial'},
  {audience:{all:true,roles:[],people:[]}}, {ink:[{id:'stroke',color:'#ff0000',size:3,points:[{x:3,y:4,p:.5}]}]},
  {attachments:[{id:'gif:sample',kind:'gif',gifId:'sample',name:'GIPHY GIF'}]},
 ])assert.equal(validateNotepadDocument({...older,...patch},draft,a,now).untouchedDraft,false,JSON.stringify(patch));
 const edited=validateNotepadDocument({...draft,content:'<p>Started work</p>'},draft,a,now);
 assert.equal(edited.untouchedDraft,false);
 const cleared=validateNotepadDocument({...draft,untouchedDraft:true},edited,a,now);
 assert.equal(cleared.content,'');assert.equal(cleared.untouchedDraft,false);
 assert.equal(notepadDocument(cleared).untouchedDraft,false);
 const oldClear={...cleared};delete oldClear.untouchedDraft;
 assert.equal(validateNotepadDocument(oldClear,cleared,a,now).untouchedDraft,false);
 assert.equal(validateNotepadDocument({...draft,untouchedDraft:false},null,a,now).untouchedDraft,false,'An edit reverted before the first server save remains edited');
});
test('draft state rejects malformed values and never treats a populated new note as untouched',()=>{
 for(const value of ['true',1,null,{}])assert.throws(()=>validateNotepadDocument({...base(),untouchedDraft:value},null,a,now),/draft state/);
 assert.equal(validateNotepadDocument({...base(),untouchedDraft:true},null,a,now).untouchedDraft,false);
 assert.equal(validateNotepadDocument({...base(),content:'',attachments:[{id:'gif:sample',kind:'gif',gifId:'sample',name:'GIPHY GIF'}],untouchedDraft:true},null,a,now).untouchedDraft,false);
 for(const content of ['<ul><li></li></ul>','<input type="checkbox">','<span class="mention"></span>'])assert.equal(validateNotepadDocument({...base(),content,untouchedDraft:true},null,a,now).untouchedDraft,false,'Empty structural items still count as edited');
});
