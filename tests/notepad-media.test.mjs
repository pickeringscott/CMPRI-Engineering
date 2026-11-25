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
 window.setTimeout=(fn,delay)=>{timers.set(++timerId,{fn,delay});return timerId};window.clearTimeout=id=>timers.delete(id);
 window.eval(source);
 const original={id:uuid(1),attachments:[]},other={id:uuid(2),attachments:[]};let current=original;
 const container=window.document.querySelector('.dock');container.innerHTML=window.NotepadAttachments.html();
 const changes=[],errors=[],available=new Set([original.id,other.id]);
 const pickerRoot=window.document.querySelector('.general-notes-body');
 const controller=window.NotepadAttachments.attach({container,pickerRoot,getNote:()=>current,request,onChange:value=>changes.push(value),onError:value=>errors.push(value),isNoteAvailable:id=>available.has(id),badge:'/Poweredby_100px_Badge.gif',...extraOptions});
 const click=selector=>{const target=window.document.querySelector(selector);assert.ok(target,selector);target.click()};
 return {dom,window,original,other,changes,errors,available,controller,click,timers,setNote:note=>{current=note},runTimers(){for(const [id,{fn}] of [...timers]){timers.delete(id);fn()}},cleanup(){controller.destroy();dom.window.close()}};
}
test('GIPHY loads only when opened, ignores stale searches, and saves the provider ID without preview placeholders',async()=>{
 const calls=[];const s=setup((action,payload)=>{const pending=deferred();calls.push({action,payload,pending});return pending.promise});
 try{
  assert.equal(calls.length,0);
  s.click('[data-notepad-gif-trigger]');assert.equal(calls.length,1);assert.equal(calls[0].action,'giphy');assert.equal(calls[0].payload.query,'');
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
test('GIPHY waits 750 ms of stationary hover, cancels on exit, and attaches the expanded GIF on click',async()=>{
 const s=setup(async()=>({gifs:[{...gif('portrait'),original:{url:'https://media.giphy.com/portrait-full.gif',width:200,height:360}}],total:1}));
 try{
  s.click('[data-notepad-gif-trigger]');await tick();
  const {document,MouseEvent}=s.window;
  const panel=document.querySelector('.note-giphy-picker'),grid=panel.querySelector('.staff-gif-grid'),tile=grid.querySelector('[data-attachment-gif]');
  const boxes=[{left:10,top:20,width:640,height:490},{left:10,top:65,width:640,height:445},{left:10,top:65,width:100,height:75}];
  for(const [index,node] of [panel,grid,tile].entries())node.getBoundingClientRect=()=>boxes[index];
  Object.defineProperties(grid,{clientWidth:{value:640},clientHeight:{value:445}});
  const move=(type,x,relatedTarget=null)=>tile.dispatchEvent(new MouseEvent(type,{bubbles:true,clientX:x,clientY:90,relatedTarget}));
  move('pointerover',30);
  const first=Array.from(s.timers.keys())[0];
  assert.equal(s.timers.get(first).delay,750);
  move('pointermove',30);
  assert.equal(s.timers.has(first),true,'A duplicate pointer position does not restart the timer');
  move('pointermove',31);
  assert.equal(s.timers.has(first),false);
  assert.deepEqual([...s.timers.values()].map(({delay})=>delay),[750]);
  move('pointerout',31,panel.querySelector('input'));s.runTimers();
  assert.equal(grid.querySelector('.staff-gif-preview'),null);
  move('pointerover',32);s.runTimers();
  const preview=grid.querySelector('.staff-gif-preview');
  assert.equal(preview.querySelector('img').src,'https://media.giphy.com/portrait-full.gif');
  assert.equal(preview.style.width,'125px');assert.equal(preview.style.height,'225px');
  assert.equal(grid.querySelector('.staff-gif-results').children.length,1);
  move('pointerout',32,preview);
  assert.equal(preview.isConnected,true,'Covering the tile with its preview does not dismiss it');
  preview.click();await tick();
  assert.equal(s.original.attachments[0].gifId,'portrait');
  assert.equal(preview.isConnected,false);
  assert.equal(document.activeElement,document.querySelector('[data-notepad-gif-trigger]'));
 }finally{s.cleanup()}
});
test('native file upload verifies before attaching and remains bound to its original note after switching',async()=>{
 const uploaded=deferred(),calls=[];const s=setup((action,payload)=>{calls.push({action,payload});return uploaded.promise});
 try{
  s.click('[data-notepad-attachments-trigger]');
  const input=s.window.document.querySelector('[data-notepad-attachment-input]'),file=new s.window.File(['real bytes'],'photo.png',{type:'image/png'});
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
  s.click('[data-notepad-attachments-trigger]');
  const input=s.window.document.querySelector('[data-notepad-attachment-input]');Object.defineProperty(input,'files',{value:[new s.window.File(['bytes'],'video.mp4',{type:'video/mp4'})]});input.dispatchEvent(new s.window.Event('change'));await tick();
  assert.equal(s.original.attachments.length,0);assert.equal(s.changes.length,0);assert.deepEqual(s.errors,['File verification failed']);assert.equal(s.window.document.querySelector('.attachment-status').textContent,'File verification failed');
 }finally{s.cleanup()}
});
test('an upload attaches to the current originating record after a save acknowledgement replaces its object',async()=>{
 const uploaded=deferred(),calls=[];let latest;
 const s=setup((action,payload)=>{calls.push({action,payload});return uploaded.promise},{getNoteById:id=>latest?.id===id?latest:null});
 try{
  latest=s.original;
  s.click('[data-notepad-attachments-trigger]');
  assert.equal(s.controller.isInteracting(),true,'The native chooser counts as active editing');
  const input=s.window.document.querySelector('[data-notepad-attachment-input]'),file=new s.window.File(['real bytes'],'pump.png',{type:'image/png'});
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
  s.click('[data-notepad-attachments-trigger]');
  const input=s.window.document.querySelector('[data-notepad-attachment-input]'),file=new s.window.File(['bytes'],'pump.png',{type:'image/png'});
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

test('the device camera picker captures one photo and cancellation returns focus without writing',async()=>{
 const calls=[];
 const s=setup(async(action,payload)=>{calls.push({action,payload});return {id:payload.id,kind:'file',url:'https://storage.example/photo.jpg?token=verified'}});
 try{
  const {window}=s,{document}=window;
  const input=document.querySelector('[data-notepad-camera-input]'),trigger=document.querySelector('[data-notepad-camera-trigger]');
  let opened=0;input.click=()=>{opened++;};
  assert.equal(input.accept,'image/*');assert.equal(input.getAttribute('capture'),'environment');assert.equal(input.multiple,false);
  trigger.click();assert.equal(opened,1);assert.equal(s.controller.isInteracting(),true);
  input.dispatchEvent(new window.Event('cancel'));
  assert.equal(s.controller.isInteracting(),false);assert.equal(document.activeElement,trigger);assert.equal(calls.length,0);
  trigger.click();assert.equal(opened,2);
  const photo=new window.File(['synthetic JPEG'],'camera.jpg',{type:'image/jpeg'});
  Object.defineProperty(input,'files',{value:[photo]});input.dispatchEvent(new window.Event('change'));await tick();
  assert.equal(calls[0].action,'upload');assert.equal(calls[0].payload.noteId,s.original.id);assert.equal(calls[0].payload.file,photo);
  assert.equal(window.NotepadAttachments.photoPreview(s.original.attachments[0]),'https://storage.example/photo.jpg?token=verified');
 }finally{s.cleanup()}
});

test('desktop Camera captures the live video frame and stops the webcam before upload',async()=>{
 const calls=[],captureOperations=[];
 const s=setup(async(action,payload)=>{calls.push({action,payload});return {id:payload.id,kind:'file'}});
 try{
  const {window}=s,{document}=window;
  window.matchMedia=query=>({matches:query!=='(pointer: coarse)'});
  const stream={getTracks:()=>[{stop:()=>captureOperations.push('stop')}]};
  Object.defineProperty(window.navigator,'mediaDevices',{value:{getUserMedia:async constraints=>{
   assert.equal(constraints.audio,false);assert.equal(constraints.video.facingMode.ideal,'environment');return stream;
  }}});
  window.HTMLMediaElement.prototype.play=async function(){};
  Object.defineProperties(window.HTMLVideoElement.prototype,{videoWidth:{get:()=>640},videoHeight:{get:()=>480}});
  window.HTMLCanvasElement.prototype.getContext=function(){
   assert.equal(this.width,640);assert.equal(this.height,480);
   return {drawImage:video=>{assert.equal(video.srcObject,stream);captureOperations.push('draw')}};
  };
  window.HTMLCanvasElement.prototype.toBlob=(callback,type)=>callback(new window.Blob(['JPEG fixture'],{type}));
  s.click('[data-notepad-camera-trigger]');await tick();
  assert.equal(document.querySelector('dialog video').srcObject,stream);assert.equal(calls.length,0);
  s.click('[data-camera-capture]');await tick();
  assert.equal(document.querySelector('.notepad-camera'),null);
  assert.deepEqual(captureOperations,['draw','stop']);
  assert.equal(calls[0].action,'upload');assert.equal(calls[0].payload.noteId,s.original.id);
  assert.equal(calls[0].payload.file.type,'image/jpeg');assert.match(calls[0].payload.file.name,/^Camera photo .+\.jpg$/);
  assert.equal(s.original.attachments.length,1);
 }finally{s.cleanup()}
});

test('closing desktop Camera before permission resolves stops a late stream without attaching',async()=>{
 const permission=deferred();const s=setup(async()=>{throw Error('Unexpected upload')});let stopped=0;
 try{
  const {window}=s;
  window.matchMedia=query=>({matches:query!=='(pointer: coarse)'});
  Object.defineProperty(window.navigator,'mediaDevices',{value:{getUserMedia:()=>permission.promise}});
  s.click('[data-notepad-camera-trigger]');s.click('[data-camera-close]');
  permission.resolve({getTracks:()=>[{stop:()=>{stopped++;}}]});await tick();
  assert.equal(stopped,1);assert.equal(s.original.attachments.length,0);
  assert.equal(window.document.activeElement,window.document.querySelector('[data-notepad-camera-trigger]'));
 }finally{s.cleanup()}
});

test('opening a photo renews its authorization and shows the original signed file',async()=>{
 const original='https://storage.example/original.jpg?token=fresh',calls=[];
 const s=setup(async(action,payload)=>{calls.push({action,payload});return {url:original,type:'image/jpeg'}});
 try{
  const {window}=s;
  const attachment={id:uuid(3),kind:'file',name:'Photo',type:'image/jpeg',url:'https://storage.example/dimmed-preview.jpg?token=old'};
  assert.equal(window.NotepadAttachments.photoPreview(attachment),attachment.url);
  assert.equal(window.NotepadAttachments.photoPreview({...attachment,url:'javascript:alert(1)'}),'');
  assert.equal(window.NotepadAttachments.photoPreview({...attachment,type:'image/svg+xml'}),'');
  await s.controller.openAttachment(attachment);
  assert.equal(calls[0].action,'attachment');assert.equal(calls[0].payload.noteId,s.original.id);assert.equal(calls[0].payload.id,attachment.id);
  assert.equal(window.document.querySelector('.notepad-attachment-viewer img').src,original);
 }finally{s.cleanup()}
});

test('a PDF click sends the authenticated original into a native browser tab and closes an unauthorized tab',async()=>{
 const request=deferred(),url='https://storage.example/manual.pdf?token=fresh';let blankClosed=false,navigated;
 const s=setup(()=>request.promise);
 try{
  const tab={opener:{},close:()=>{blankClosed=true;},location:{replace:value=>{navigated=value;}}};
  s.window.open=()=>tab;
  const file={id:uuid(3),kind:'file',name:'Manual',type:'application/pdf',url:'https://storage.example/stale.pdf'};
  const opening=s.controller.openAttachment(file);
  assert.equal(tab.opener,null);assert.equal(navigated,undefined);
  request.resolve({type:'application/pdf',url});await opening;
  assert.equal(navigated,url);assert.equal(blankClosed,false);
  assert.equal(s.window.document.querySelector('.notepad-attachment-viewer'),null);
  const denied=setup(async()=>{throw Error('Attachment no longer available')});
  try{
   denied.window.open=()=>tab;
   await denied.controller.openAttachment(file);
   assert.equal(blankClosed,true);
   assert.equal(denied.window.document.querySelector('.notepad-attachment-body').textContent,'Attachment no longer available');
  }finally{denied.cleanup()}
 }finally{s.cleanup()}
});
