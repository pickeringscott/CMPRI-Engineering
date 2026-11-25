import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';

const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const html=read('../public/notepad/editor.html');
const sources=['ink','formatting','attachments','app'].map(name=>read(`../public/notepad/${name}.js`));
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height,x:left,y:top});
function setup(content,extra={},otherNotes=[]){
  const errors=[],traffic=[],console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error.message));
  const dom=new JSDOM(html,{url:'https://cmpri.example/notepad/editor.html?bridge=pointer-test',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console});
  const {window}=dom,{document}=window,host={postMessage:data=>traffic.push(data)};
  Object.defineProperty(window,'parent',{value:host});window.matchMedia=()=>({matches:true});
  window.Element.prototype.getAnimations=()=>[];
  window.Element.prototype.getBoundingClientRect=function(){
    if(this.matches('.note-ink'))return rect(100,100,800,1100);
    if(this.matches('.note-content'))return rect(100,100,500,500);
    return rect(100,120,300,24);
  };
  window.Element.prototype.setPointerCapture=function(){};
  window.Element.prototype.hasPointerCapture=()=>false;
  window.Range.prototype.getBoundingClientRect=function(){return this.startContainer===document.querySelector('.note-content')?rect(0,0,0,0):rect(120,120,0,24);};
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  document.queryCommandState=()=>false;
  for(const source of sources)window.eval(source);
  const person={id:id(1),name:'Avery Engineer',short:'Avery',role:'Chief Engineer',roles:['engineer'],active:true,taggable:true,recipientSelectable:true};
  const note={id:id(10),title:'Pointer behavior',content,audience:{all:false,roles:[],people:[]},authorId:person.id,createdAt:'2026-11-24T08:00:00Z',updatedAt:'2026-11-24T08:00:00Z',revision:1,priority:'Normal',fontSize:16,fontFamily:'Comic Sans MS',titleFontFamily:'Arial',ink:[],itemThreads:{},attachments:[],...extra};
  const send=(type,payload={})=>window.dispatchEvent(new window.MessageEvent('message',{source:host,origin:window.location.origin,data:{channel:'cmpri-notepad',token:'pointer-test',type,payload}}));
  const notes=[note,...otherNotes.map(other=>({...note,...other}))];
  send('initialize',{hotelId:id(90),userId:person.id,people:[person],roles:[{id:'engineer',label:'Chief Engineer'}],notes,order:notes.map(item=>item.id),legacyAliases:{}});
  const editor=document.querySelector('.note-content');editor.tabIndex=0;
  for(const field of editor.querySelectorAll('[contenteditable=true]'))field.tabIndex=0;
  const select=(node,start,end=start)=>{editor.focus();const range=document.createRange();range.setStart(node,start);range.setEnd(node,end);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);};
  const pointer=(target,type,x=200,y=400,extra={})=>{
    const event=new window.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y,...extra});
    for(const [key,value]of Object.entries({pointerId:7,pointerType:'mouse',pressure:.5,...extra}))if(!['shiftKey','ctrlKey','metaKey','altKey','button'].includes(key))Object.defineProperty(event,key,{value});
    target.dispatchEvent(event);return event;
  };
  const clickBelow=()=>{pointer(editor,'pointerdown');pointer(editor,'pointerup');};
  const saves=()=>traffic.filter(message=>message.type==='save');
  return {window,document,editor,select,pointer,clickBelow,saves,send,traffic,initialNotes:notes,close(){send('clear');window.close();assert.deepEqual(errors,[]);}};
}

const settle=()=>new Promise(resolve=>setImmediate(resolve));

function controlledAnimations(s){
  const animations=[];s.window.matchMedia=()=>({matches:false});
  s.window.Element.prototype.animate=function(keyframes,options){
    let resolve;const finished=new Promise(done=>{resolve=done;});
    const animation={target:this,options,finished,settled:false,finish(){this.settled=true;resolve();},cancel(){this.finish();}};
    animations.push(animation);if(options.duration!==130)animation.finish();return animation;
  };
  s.window.Element.prototype.getAnimations=function(){return animations.filter(item=>item.target===this&&!item.settled);};
  return animations;
}

test('a saved acknowledgement during the closing animation cannot cancel opening the chosen note',async()=>{
  const task='<div class="note-check" contenteditable="false" data-item-id="task" data-task-id="task"><input type="checkbox"><span class="task-label" contenteditable="true">Existing task</span></div>';
  const s=setup(task,{audience:{all:true,roles:[],people:[]}},[{id:id(11),title:'Second note',content:'<p data-item-id="second">Second note</p>'}]);
  try{
    const animations=controlledAnimations(s),oldEditor=s.document.querySelector('.general-notes-editor'),button=s.document.querySelector(`[data-note="${id(11)}"]`);
    s.pointer(button,'pointerdown',150,130);s.pointer(button,'pointerup',150,130);
    const save=s.saves().at(-1)?.payload;assert.equal(save?.id,id(10),'Normalizing the original shared checklist produces a save when leaving it');
    assert.equal(animations.filter(item=>item.options.duration===130).length,1);
    const accepted={...s.initialNotes[0],...save.document,revision:2,authorName:'Avery from server'};
    s.send('saved',{id:save.id,sequence:save.sequence,revision:2,note:accepted});
    assert.equal(s.document.querySelector('.general-notes-editor'),oldEditor,'An acknowledgement must not rerender the editor while it is closing');
    s.send('flush',{requestId:'during-close'});
    assert.equal(s.saves().length,1,'Flushing while closing still belongs to the original note');
    animations.find(item=>item.options.duration===130).finish();await settle();
    assert.equal(s.document.querySelector('#note-title').value,'Second note');
    assert.equal(s.document.querySelector(`[data-note="${id(11)}"]`).getAttribute('aria-current'),'true');
    s.window.matchMedia=()=>({matches:true});s.document.querySelector(`[data-note="${id(10)}"]`).click();await settle();
    assert.equal(s.document.querySelector('.note-creator').textContent,'Avery from server','The deferred acknowledgement is retained when returning to the old note');
    assert.equal(s.document.querySelector('.task-label').textContent,'Existing task');
  }finally{s.close();}
});

test('sidebar pointer release opens a note without relying on a follow-up click and keyboard activation still works',async()=>{
  const s=setup('<p data-item-id="first">First note</p>',{},[{id:id(11),title:'Second note',content:'<p data-item-id="second">Second note</p>'}]);
  try{
    const button=s.document.querySelector(`[data-note="${id(11)}"]`),oldEditor=s.document.querySelector('.general-notes-editor');
    let closes=0;oldEditor.getAnimations=()=>{closes++;return [];};
    s.pointer(button,'pointerdown',150,130);s.pointer(button,'pointerup',150,130);
    assert.equal(closes,1,'Releasing an unmoved pointer starts opening the note without a click event');
    button.dispatchEvent(new s.window.MouseEvent('click',{bubbles:true,cancelable:true,detail:1}));
    assert.equal(closes,1,'The browser follow-up click must not start a second note transition');
    await settle();
    assert.equal(s.document.querySelector('#note-title').value,'Second note');
    assert.equal(s.document.querySelector(`[data-note="${id(11)}"]`).getAttribute('aria-current'),'true');
    // Enter/Space activation produces a click with detail 0. It must remain
    // usable even if a completed pointer gesture had no follow-up click.
    const active=s.document.querySelector(`[data-note="${id(11)}"]`);
    s.pointer(active,'pointerdown',150,130);s.pointer(active,'pointerup',150,130);
    s.document.querySelector(`[data-note="${id(10)}"]`).click();await settle();
    assert.equal(s.document.querySelector('#note-title').value,'Pointer behavior');
    assert.equal(s.saves().length,0);
  }finally{s.close();}
});

test('sidebar cancellation, release outside the button, and reorder gestures do not activate a different note',async()=>{
  const s=setup('<p data-item-id="first">First note</p>',{},[{id:id(11),title:'Second note',content:'<p data-item-id="second">Second note</p>'}]);
  try{
    const button=s.document.querySelector(`[data-note="${id(11)}"]`);
    s.pointer(button,'pointerdown',150,130);s.pointer(button,'pointercancel',150,130);s.pointer(button,'pointerup',150,130);
    await settle();assert.equal(s.document.querySelector('#note-title').value,'Pointer behavior');
    s.pointer(button,'pointerdown',150,130);s.pointer(button,'pointerup',500,130);
    await settle();assert.equal(s.document.querySelector('#note-title').value,'Pointer behavior');
    s.document.elementFromPoint=()=>s.document.querySelector(`[data-row="${id(10)}"]`);
    s.pointer(button,'pointerdown',150,136);s.pointer(button,'pointermove',150,121);s.pointer(button,'pointerup',150,121);
    await settle();
    assert.deepEqual([...s.document.querySelectorAll('[data-note]')].map(item=>item.dataset.note),[id(11),id(10)]);
    assert.deepEqual(s.traffic.filter(message=>message.type==='order').at(-1).payload.order,[id(11),id(10)]);
    assert.equal(s.document.querySelector('#note-title').value,'Pointer behavior');
    const moved=s.document.querySelector(`[data-note="${id(11)}"]`);
    moved.dispatchEvent(new s.window.MouseEvent('click',{bubbles:true,cancelable:true,detail:1}));
    await settle();assert.equal(s.document.querySelector('#note-title').value,'Pointer behavior');
    assert.equal(s.saves().length,0);
  }finally{s.close();}
});

test('clicking below the last paragraph moves to its existing end without adding or saving a line',()=>{
  const s=setup('<p data-item-id="first">First line</p><p data-item-id="last">Last <strong>existing line</strong></p>');
  try{
    const first=s.editor.querySelector('p').firstChild,last=s.editor.querySelector('strong').firstChild;
    s.select(first,2);const before=s.editor.innerHTML;
    s.clickBelow();
    assert.equal(s.window.getSelection().anchorNode,last);assert.equal(s.window.getSelection().anchorOffset,last.length);
    assert.equal(s.window.getSelection().isCollapsed,true);assert.equal(s.editor.innerHTML,before);assert.equal(s.saves().length,0);
    const enter=new s.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});s.editor.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented,false,'Normal paragraphs still use the browser Enter behavior');
  }finally{s.close();}
});

test('empty notes and existing empty final lines receive a caret without manufacturing blank paragraphs',()=>{
  for(const content of ['', '<p data-item-id="first">First</p><p data-item-id="last"><br></p>']){
    const s=setup(content);
    try{
      const before=s.editor.innerHTML;s.clickBelow();const selection=s.window.getSelection();
      assert.equal(selection.anchorNode,content?s.editor.lastElementChild:s.editor);assert.equal(selection.anchorOffset,0);
      assert.equal(s.editor.innerHTML,before);assert.equal(s.saves().length,0);
    }finally{s.close();}
  }
  const s=setup('<p data-item-id="first">First</p><br><br>');
  try{
    const before=s.editor.innerHTML;s.clickBelow();
    assert.equal(s.window.getSelection().anchorNode,s.editor);assert.equal(s.window.getSelection().anchorOffset,s.editor.childNodes.length-1,'The caret stays on the last existing BR line');
    assert.equal(s.editor.innerHTML,before);assert.equal(s.saves().length,0);
  }finally{s.close();}
});

test('shared checklist and list endings ignore reply decorations and Enter creates the next real item',()=>{
  for(const [content,selector,countSelector]of [
    ['<div class="note-check" contenteditable="false" data-item-id="task" data-task-id="task"><input type="checkbox"><span class="task-label" contenteditable="true">Last task</span></div>','.task-label','.note-check'],
    ['<ul class="np-format-list" data-format-list="bullet"><li data-item-id="task">Last list item</li></ul>','li','.np-format-list>li'],
  ]){
    const s=setup(content,{audience:{all:true,roles:[],people:[]},itemThreads:{task:[{id:'reply',authorId:id(1),at:'2026-11-24T08:00:00Z',text:'A linked reply',replies:[]}]}});
    try{
      s.editor.querySelector('[data-item-reply]').click();const target=s.editor.querySelector(selector),lastText=target.firstChild;
      const before=s.editor.innerHTML,savesBefore=s.saves().length;s.clickBelow();
      assert.equal(s.window.getSelection().anchorNode,lastText);assert.equal(s.window.getSelection().anchorOffset,lastText.length);
      assert.equal(s.editor.innerHTML,before);assert.equal(s.saves().length,savesBefore,'Clicking adds no document mutation');
      const enter=new s.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});target.dispatchEvent(enter);
      assert.equal(enter.defaultPrevented,true);assert.equal(s.editor.querySelectorAll(countSelector).length,2);
      assert.ok(s.saves().length>savesBefore,'The explicit Enter edit is autosaved');
    }finally{s.close();}
  }
});

test('dragging, Shift selection, on-line clicks, and reply editing keep their native selections',()=>{
  const s=setup('<p data-item-id="task">Select these words</p>',{audience:{all:true,roles:[],people:[]}});
  try{
    const text=s.editor.querySelector('p').firstChild;
    s.select(text,2,8);s.pointer(s.editor,'pointerdown');s.pointer(s.editor,'pointermove',240,350);s.pointer(s.editor,'pointerup',240,350);
    assert.equal(s.window.getSelection().toString(),'lect t');
    s.pointer(s.editor,'pointerdown',200,400,{shiftKey:true});s.pointer(s.editor,'pointerup',200,400,{shiftKey:true});
    assert.equal(s.window.getSelection().toString(),'lect t');
    s.pointer(s.editor,'pointerdown',200,130);s.pointer(s.editor,'pointerup',200,130);
    assert.equal(s.window.getSelection().toString(),'lect t');
    s.editor.querySelector('[data-item-reply]').click();const reply=s.editor.querySelector('.reply-input');
    reply.value='Reply text';reply.focus();reply.setSelectionRange(2,5);
    s.pointer(reply,'pointerdown');s.pointer(reply,'pointerup');
    assert.equal(s.document.activeElement,reply);assert.equal(reply.selectionStart,2);assert.equal(reply.selectionEnd,5);
    assert.equal(s.saves().length,0);
  }finally{s.close();}
});

test('pen and eraser cursors stay on the ink area and do not change drawing coordinates or outside cursors',()=>{
  const s=setup('<p data-item-id="task">Note text</p>');
  try{
    const svg=s.editor.parentElement.querySelector('.note-ink'),bodyCursor=s.document.body.style.cursor,paperCursor=s.editor.parentElement.style.cursor;
    s.document.querySelector('[data-mode=pen]').click();
    assert.match(svg.style.cursor,/pencil-cursor\.svg.*3 18/);
    assert.equal(svg.getAttribute('viewBox'),'0 0 800 1100');assert.equal(svg.getAttribute('preserveAspectRatio'),'xMidYMid meet');
    s.pointer(svg,'pointerdown',500,650,{pointerType:'pen',pressure:.5});s.pointer(svg,'pointerup',500,650,{pointerType:'pen',pressure:.5});
    const stroke=s.saves().at(-1).payload.document.ink[0];assert.equal(stroke.points[0].x,400);assert.equal(stroke.points[0].y,550);
    s.document.querySelector('[data-mode=eraser]').click();assert.match(svg.style.cursor,/eraser-cursor\.svg.*4 17/);
    s.pointer(svg,'pointerdown',500,650,{pointerType:'pen',pressure:.5});s.pointer(svg,'pointerup',500,650,{pointerType:'pen',pressure:.5});
    assert.equal(s.saves().at(-1).payload.document.ink.length,0);
    assert.equal(s.document.body.style.cursor,bodyCursor);assert.equal(s.editor.parentElement.style.cursor,paperCursor);
    s.document.querySelector('[data-mode=text]').click();assert.equal(svg.style.cursor,'auto');assert.equal(svg.style.pointerEvents,'none');
    for(const asset of ['pencil','eraser']){
      const parsed=new s.window.DOMParser().parseFromString(read(`../public/notepad/${asset}-cursor.svg`),'image/svg+xml');
      assert.equal(parsed.querySelector('parsererror'),null);
      assert.equal(parsed.documentElement.getAttribute('width'),'21');
      assert.equal(parsed.documentElement.getAttribute('height'),'21');
      assert.equal(parsed.documentElement.getAttribute('viewBox'),'0 0 24 24');
    }
  }finally{s.close();}
});
