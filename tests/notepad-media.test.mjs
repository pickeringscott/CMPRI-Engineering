import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const source=readFileSync(new URL('../public/notepad/attachments.js',import.meta.url),'utf8');
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const image=id=>({url:`https://media.giphy.com/${id}.gif`,width:200,height:150});
const gif=id=>({id,title:id,preview:image(id),original:image(id)});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
function setup(request,extraOptions={}){
 const dom=new JSDOM('<div class="layout-body"><div class="general-notes-body"></div><div class="dock"></div></div>',{url:'https://cmpri.example/notepad/editor.html',runScripts:'outside-only'}),{window}=dom;
 window.matchMedia=()=>({matches:true});
 window.HTMLDialogElement.prototype.showModal=function(){this.open=true};
 window.HTMLDialogElement.prototype.close=function(){this.open=false};
 window.HTMLMediaElement.prototype.pause=function(){};window.HTMLMediaElement.prototype.load=function(){};
 const timers=new Map();let timerId=0;
 window.setTimeout=fn=>{timers.set(++timerId,fn);return timerId};window.clearTimeout=id=>timers.delete(id);
 window.eval(source);
 const original={id:uuid(1),attachments:[]},other={id:uuid(2),attachments:[]};let current=original;
 const container=window.document.querySelector('.dock');container.innerHTML=window.NotepadAttachments.html();
 const changes=[],errors=[],available=new Set([original.id,other.id]);
 const pickerRoot=window.document.querySelector('.general-notes-body');
 const controller=window.NotepadAttachments.attach({container,pickerRoot,getNote:()=>current,request,onChange:value=>changes.push(value),onError:value=>errors.push(value),isNoteAvailable:id=>available.has(id),badge:'/Poweredby_100px_Badge.gif',...extraOptions});
 const click=selector=>{const target=window.document.querySelector(selector);assert.ok(target,selector);target.click()};
 return {dom,window,original,other,changes,errors,available,controller,click,setNote:note=>{current=note},runTimers(){for(const [id,fn] of [...timers]){timers.delete(id);fn()}},cleanup(){controller.destroy();dom.window.close()}};
}
test('GIPHY loads only when opened, ignores stale searches, and saves the provider ID without preview placeholders',async()=>{
 const calls=[];const s=setup((action,payload)=>{const pending=deferred();calls.push({action,payload,pending});return pending.promise});
 try{
  assert.equal(calls.length,0);
  s.click('[data-notepad-attachments-trigger]');assert.equal(calls.length,0);
  assert.equal(s.window.document.querySelectorAll('.attachment-choice').length,2);
  s.click('[data-attachment-choice="gif"]');assert.equal(calls.length,1);assert.equal(calls[0].action,'giphy');assert.equal(calls[0].payload.query,'');
  assert.equal(s.window.document.querySelector('[aria-label="GIPHY picker"]').parentElement.className,'general-notes-body');
  const input=s.window.document.querySelector('[aria-label="Search GIPHY"]');
  input.value='old';input.dispatchEvent(new s.window.Event('input'));s.runTimers();
  input.value='new';input.dispatchEvent(new s.window.Event('input'));s.runTimers();
  calls[2].pending.resolve({gifs:[gif('newgif')],total:1});await tick();
  calls[0].pending.resolve({gifs:[gif('trending')],total:1});calls[1].pending.resolve({gifs:[gif('oldgif')],total:1});await tick();
  assert.equal(s.window.document.querySelectorAll('[data-attachment-gif]').length,1);
  assert.equal(s.window.document.querySelector('[data-attachment-gif]').dataset.attachmentGif,'newgif');
  assert.equal(s.window.document.querySelector('.gif-placeholder'),null);
  s.click('[data-attachment-gif="newgif"]');await tick();
  assert.equal(s.original.attachments.length,1);assert.equal(s.original.attachments[0].gifId,'newgif');assert.equal(s.original.attachments[0].kind,'gif');
  assert.equal(s.original.attachments[0].url,undefined);assert.equal(s.original.attachments[0].localOnly,undefined);assert.equal(s.changes.length,1);
 }finally{s.cleanup()}
});
test('native file upload verifies before attaching and remains bound to its original note after switching',async()=>{
 const uploaded=deferred(),calls=[];const s=setup((action,payload)=>{calls.push({action,payload});return uploaded.promise});
 try{
  s.click('[data-notepad-attachments-trigger]');s.click('[data-attachment-choice="files"]');
  const input=s.window.document.querySelector('input[type=file]'),file=new s.window.File(['real bytes'],'photo.png',{type:'image/png'});
  Object.defineProperty(input,'files',{configurable:true,value:[file]});input.dispatchEvent(new s.window.Event('change'));
  assert.equal(calls.length,1);assert.equal(calls[0].action,'upload');assert.equal(calls[0].payload.noteId,s.original.id);assert.equal(calls[0].payload.file,file);
  assert.equal(s.original.attachments.length,0);assert.equal(s.controller.uploading(),true);
  s.setNote(s.other);s.controller.destroy();
  uploaded.resolve({id:calls[0].payload.id,kind:'file',name:file.name,type:file.type,size:file.size});await tick();
  assert.equal(s.original.attachments.length,1);assert.equal(s.other.attachments.length,0);assert.equal(s.changes[0].noteId,s.original.id);assert.equal(s.controller.uploading(),false);
 }finally{s.cleanup()}
});
test('a failed upload never appears as a saved attachment and reports its error',async()=>{
 const s=setup(async()=>{throw Error('File verification failed')});
 try{
  s.click('[data-notepad-attachments-trigger]');s.click('[data-attachment-choice="files"]');
  const input=s.window.document.querySelector('input[type=file]');Object.defineProperty(input,'files',{value:[new s.window.File(['bytes'],'video.mp4',{type:'video/mp4'})]});input.dispatchEvent(new s.window.Event('change'));await tick();
  assert.equal(s.original.attachments.length,0);assert.equal(s.changes.length,0);assert.deepEqual(s.errors,['File verification failed']);assert.equal(s.window.document.querySelector('.attachment-status').textContent,'File verification failed');
 }finally{s.cleanup()}
});
test('an upload attaches to the current originating record after a save acknowledgement replaces its object',async()=>{
 const uploaded=deferred(),calls=[];let latest;
 const s=setup((action,payload)=>{calls.push({action,payload});return uploaded.promise},{getNoteById:id=>latest?.id===id?latest:null});
 try{
  latest=s.original;
  s.click('[data-notepad-attachments-trigger]');s.click('[data-attachment-choice="files"]');
  assert.equal(s.controller.isInteracting(),true,'The native chooser counts as active editing');
  const input=s.window.document.querySelector('input[type=file]'),file=new s.window.File(['real bytes'],'pump.png',{type:'image/png'});
  Object.defineProperty(input,'files',{value:[file]});input.dispatchEvent(new s.window.Event('change'));
  latest={...s.original,title:'Canonical acknowledged title',attachments:[]};
  s.setNote(latest);s.controller.destroy();
  uploaded.resolve({id:calls[0].payload.id,kind:'file',name:file.name,type:file.type,size:file.size});await tick();
  assert.equal(s.original.attachments.length,0,'A stale note object is not mutated');
  assert.equal(latest.attachments.length,1);assert.equal(s.changes[0].note,latest);
 }finally{s.cleanup()}
});
test('an upload completing after its account scope disappears cannot attach to another record',async()=>{
 const uploaded=deferred(),calls=[];let latest;
 const s=setup((action,payload)=>{calls.push({action,payload});return uploaded.promise},{getNoteById:id=>latest?.id===id?latest:null});
 try{
  latest=s.original;
  s.click('[data-notepad-attachments-trigger]');s.click('[data-attachment-choice="files"]');
  const input=s.window.document.querySelector('input[type=file]'),file=new s.window.File(['bytes'],'pump.png',{type:'image/png'});
  Object.defineProperty(input,'files',{value:[file]});input.dispatchEvent(new s.window.Event('change'));
  s.available.clear();latest={...s.original,attachments:[]};s.controller.destroy();
  uploaded.resolve({id:calls[0].payload.id,kind:'file',name:file.name,type:file.type,size:file.size});await tick();
  assert.equal(latest.attachments.length,0);assert.equal(s.original.attachments.length,0);assert.equal(s.changes.length,0);
  assert.match(s.errors[0],/original note is no longer available/);
 }finally{s.cleanup()}
});
test('video is resolved and receives a src only after an explicit open, with preload disabled',async()=>{
 const calls=[];const s=setup(async(action,payload)=>{calls.push({action,payload});return {url:'https://storage.example/verified.mp4?token=test',type:'video/mp4'}});
 try{
  const item={id:uuid(3),kind:'file',name:'Video',type:'video/mp4',size:200};s.original.attachments.push(item);
  assert.equal(calls.length,0);assert.equal(s.window.document.querySelector('video'),null);
  await s.controller.openAttachment(item);
  assert.equal(calls.length,1);assert.equal(calls[0].action,'attachment');assert.equal(calls[0].payload.noteId,s.original.id);
  const video=s.window.document.querySelector('video');assert.ok(video);assert.equal(video.preload,'none');assert.equal(video.autoplay,false);assert.equal(video.src,'https://storage.example/verified.mp4?token=test');
  await s.controller.close({immediate:true});assert.equal(s.window.document.querySelector('video'),null);
 }finally{s.cleanup()}
});
