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
test('selected mention identity survives note storage; stale or URL-overlapping ranges are rejected',()=>{const text='@Sam https://example.invalid/@Sam',selected={id:'sam-id',kind:'person',label:'Sam',start:0,end:4};const withMention={...note,text,mentions:[selected]};assert.deepEqual(parseGeneralNotes(JSON.stringify([withMention]))[0].mentions,[selected]);assert.throws(()=>parseGeneralNotes(JSON.stringify([{...withMention,text:'Changed'}])));assert.throws(()=>parseGeneralNotes(JSON.stringify([{...withMention,mentions:[{...selected,start:text.lastIndexOf('@'),end:text.length}]}])))});
test('selection formatting splits runs, preserves the other attribute and merges matching neighbors',async()=>{const {formatNoteRange,noteStyleAt,validNoteStyles}=await import('../src/lib/general-note-formatting.ts');let runs=formatNoteRange([],0,5,{color:'rgb(20, 80, 200)'});runs=formatNoteRange(runs,2,8,{fontSize:24});assert.equal(noteStyleAt(runs,0).fontSize,undefined);assert.equal(noteStyleAt(runs,3).color,'rgb(20, 80, 200)');assert.equal(noteStyleAt(runs,3).fontSize,24);assert.equal(noteStyleAt(runs,6).color,undefined);assert.equal(noteStyleAt(runs,8).fontSize,undefined);assert.ok(validNoteStyles('abcdefghij',runs));runs=formatNoteRange(runs,0,8,{color:'text',fontSize:16});assert.deepEqual(runs,[{start:0,end:8,color:'text',fontSize:16}])});
test('edits retain styled fragments, style inserted text, and shift later ranges without altering plain text',async()=>{const {rebaseNoteStyles}=await import('../src/lib/general-note-formatting.ts');const blue={color:'rgb(0, 100, 200)',fontSize:12};assert.deepEqual(rebaseNoteStyles('abcDEFghi','abcXghi',[{start:3,end:6,...blue}]),[{start:3,end:4,...blue}]);assert.deepEqual(rebaseNoteStyles('abcDEFghi','abchi',[{start:3,end:6,...blue}]),[]);assert.deepEqual(rebaseNoteStyles('abc','abcXY',[{start:0,end:3,...blue}],{fontSize:24}),[{start:0,end:3,...blue},{start:3,end:5,color:blue.color,fontSize:24}]);assert.deepEqual(rebaseNoteStyles('abc','aXXbc',[{start:2,end:3,...blue}]),[{start:4,end:5,...blue}])});
test('formatting persists in note documents while unsafe CSS, overlapping ranges and invalid sizes fail validation',async()=>{const {noteDocument,validNoteDocument}=await import('../src/lib/general-notes.ts');const valid={...note,textStyles:[{start:0,end:7,color:'rgb(0, 100, 200)',fontSize:24}]};assert.deepEqual(noteDocument(valid).textStyles,valid.textStyles);assert.ok(validNoteDocument(noteDocument(valid)));assert.deepEqual(parseGeneralNotes(JSON.stringify([valid]))[0].textStyles,valid.textStyles);for(const textStyles of [[{start:0,end:999,fontSize:24}],[{start:0,end:2,fontSize:25}],[{start:0,end:2,color:'url(javascript:alert(1))'}],[{start:0,end:2,color:'rgb(999, 0, 0)'}],[{start:0,end:2,fontSize:16},{start:1,end:3,color:'text'}],[{start:0,end:2,color:'text',background:'red'}]])assert.equal(validNoteDocument({...noteDocument(note),textStyles}),false)});
test('native rich editor normalizes IME/paste blocks and measures selection boundaries across styled spans',async()=>{const {JSDOM}=await import('jsdom'),{loadTs}=await import('./helpers/load-ts.mjs'),formatting=await import('../src/lib/general-note-formatting.ts');const dom=new JSDOM('<body></body>');try{const editor=loadTs('src/components/GeneralNotesText.tsx',{'react':{forwardRef:fn=>fn},'react/jsx-runtime':{jsx:()=>null},'@/lib/general-note-formatting':formatting},{document:dom.window.document,NodeFilter:dom.window.NodeFilter});const root=dom.window.document.createElement('div');for(const [html,text]of [['<div>One</div><div>Two</div>','One\nTwo'],['One<div><br></div>','One\n'],['<span>One\n</span><br data-note-tail>','One\n'],['<br>',''],['<span>ab</span><span style="font-size:24px">☐ Task</span>','ab☐ Task']]){root.innerHTML=html;assert.equal(editor.noteEditorPlainText(root),text)}const range=editor.noteTextRange(root,2,3);assert.equal(range.toString(),'☐');assert.equal(range.startContainer.textContent,'☐ Task');assert.equal(range.startOffset,0)}finally{dom.window.close()}});
