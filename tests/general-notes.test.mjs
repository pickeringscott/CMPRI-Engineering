import test from 'node:test';
import assert from 'node:assert/strict';
import {noteInputEdit,noteToggleList,applyNoteTextEdit,parseGeneralNotes,noteStorageKey,saveGeneralNote} from '../src/lib/general-notes.ts';
const scope={hotelId:'hotel-a',userId:'user-a'};
const note={id:'note-a',title:'Pump inspection',text:'Heading\n    ☐ Check seals',fontSize:18,strokes:[{id:'ink',color:'rgb(117,223,180)',size:4,points:[{x:20,y:60,p:.5},{x:80,y:90,p:.8}]}],revision:1,updated:100};
test('notes retain original ink and stay scoped to account and property',()=>{
 assert.deepEqual(parseGeneralNotes(JSON.stringify([note])),[note]);
 assert.notEqual(noteStorageKey(scope),noteStorageKey({...scope,userId:'user-b'}));
 assert.notEqual(noteStorageKey(scope),noteStorageKey({...scope,hotelId:'hotel-b'}));
 assert.throws(()=>noteStorageKey({hotelId:'',userId:'u'}));
});
test('lists start beneath a heading, continue indentation, reset checks, and remove a whole prefix',()=>{
 const start=applyNoteTextEdit('Heading',noteToggleList('Heading',7,7,'check'));
 assert.equal(start.value,'Heading\n    ☐ ');
 const body=start.value+'Check seal';
 const returned=applyNoteTextEdit(body,noteInputEdit(body,body.length,body.length,'return'));
 assert.equal(returned.value,body+'\n    ☐ ');
 assert.equal(applyNoteTextEdit(returned.value,noteInputEdit(returned.value,returned.caret,returned.caret,'backspace')).value,body+'\n');
 assert.equal(noteInputEdit('    ☑ Done',10,10,'return').insert,'\n    ☐ ');
 assert.equal(noteInputEdit('    • Item',10,10,'return').insert,'\n    • ');
 assert.equal(noteInputEdit('    • Item',10,10,'backspace'),null);
 assert.equal(noteInputEdit('    • Item',6,8,'backspace'),null);
});
test('local saves preserve separate notes and reject stale edits/deletes instead of overwriting',()=>{
 const data=new Map(),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
 saveGeneralNote(storage,scope,note,null);
 saveGeneralNote(storage,scope,{...note,id:'note-b',title:'Another note'},null);
 const updated=saveGeneralNote(storage,scope,{...note,text:'Updated'},1);
 assert.equal(updated.length,2);assert.equal(updated.find(n=>n.id==='note-a').revision,2);
 assert.throws(()=>saveGeneralNote(storage,scope,{...note,text:'stale'},1),/another window/);
 assert.equal(parseGeneralNotes(storage.getItem(noteStorageKey(scope))).find(n=>n.id==='note-a').text,'Updated');
});
test('invalid notebook data is not silently discarded or overwritten',()=>{
 for(const change of [{fontSize:9},{strokes:[{...note.strokes[0],points:[{x:NaN,y:1,p:1}]}]},{title:''},{revision:0}])assert.throws(()=>parseGeneralNotes(JSON.stringify([{...note,...change}])));
 let wrote=false;assert.throws(()=>saveGeneralNote({getItem:()=>'{broken',setItem:()=>{wrote=true}},scope,note,null));assert.equal(wrote,false);
});

test('private autosaves bypass the generic response cache and do not refresh unrelated work orders',async()=>{
 const {dataCachePolicy,mutationTopics}=await import('../src/lib/data-cache/policy.ts');
 assert.equal(dataCachePolicy('/api/notes'),null);assert.deepEqual(mutationTopics('/api/notes'),[]);
});
