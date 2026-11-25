import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const source=readFileSync(new URL('../public/notepad/caret.js',import.meta.url),'utf8');
const markup=`<!doctype html><html><body><div id="layout-body"><span class="note-urgent"></span><div class="general-notes-scroll" style="overflow:auto"><textarea id="note-title" style="font:20px/24px Arial;color:rgb(240,240,240);border:0;padding:0">Project title</textarea><div class="note-content" contenteditable="true" tabindex="0" style="font:16px/20px Arial;color:rgb(240,240,240)"><p>Review parts</p><div class="note-check" contenteditable="false"><span class="task-label" contenteditable="true" tabindex="0">Order a gasket</span></div></div><textarea class="reply-input" style="font:16px/20px Arial;border:0;padding:0">Reply text</textarea></div></div></body></html>`;
const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height,x:left,y:top});

function setup({native=false,reduced=false,mobile=false,keyboard=false}={}){
  const options={runScripts:'outside-only',pretendToBeVisual:true};
  const dom=new JSDOM(keyboard?'<iframe></iframe>':markup,options);
  const outer=dom.window;
  const frame=outer.document.querySelector('iframe');
  const window=frame?.contentWindow||outer,{document}=window;
  let viewport;
  if(frame){
    document.open();document.write(markup);document.close();
    frame.getBoundingClientRect=()=>rect(0,175,390,560);
    viewport=Object.assign(new outer.EventTarget(),{height:720,scale:1,offsetTop:0});
    Object.defineProperty(outer,'innerWidth',{value:mobile?390:1000});
    Object.defineProperty(outer,'innerHeight',{value:720});
    Object.defineProperty(outer,'visualViewport',{value:viewport});
    Object.defineProperty(window,'innerWidth',{value:mobile?390:1000});
    Object.defineProperty(window,'innerHeight',{value:560});
  }
  let now=0,nextId=0,focused=true,hidden=false,caretTop=80;
  const timers=new Map(),frames=new Map(),media=new window.EventTarget();media.matches=reduced;
  Object.defineProperty(window.performance,'now',{value:()=>now});
  Object.defineProperty(document,'hasFocus',{value:()=>focused});
  Object.defineProperty(document,'hidden',{get:()=>hidden});
  window.CSS={supports:(property,value)=>native&&property==='caret-animation'&&value==='manual'};
  window.matchMedia=()=>media;
  window.setTimeout=(fn,delay)=>{const id=++nextId;timers.set(id,{fn,at:now+delay});return id;};
  window.clearTimeout=id=>timers.delete(id);
  window.requestAnimationFrame=fn=>{const id=++nextId;frames.set(id,fn);return id;};
  window.cancelAnimationFrame=id=>frames.delete(id);
  window.HTMLElement.prototype.getBoundingClientRect=function(){
    if(this.classList.contains('notepad-caret-mirror'))return rect(0,0,180,100);
    if(this.matches('textarea'))return rect(30,20,180,60);
    if(this.classList.contains('general-notes-scroll'))return rect(20,10,400,250);
    return rect(40,60,300,100);
  };
  window.Range.prototype.getClientRects=function(){
    if(this.startContainer.parentElement?.closest('.notepad-caret-mirror'))return [rect(72,24,0,24)];
    return [rect(100+this.startOffset*7,caretTop,0,20)];
  };
  window.Range.prototype.getBoundingClientRect=function(){return this.getClientRects()[0]||rect(0,0,0,0);};
  window.eval(source);
  const flush=()=>{const current=Array.from(frames.values());frames.clear();current.forEach(fn=>fn(now));};
  const advance=target=>{
    while(true){
      const next=Array.from(timers.entries()).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next||next[1].at>target)break;
      now=next[1].at;timers.delete(next[0]);next[1].fn();
    }
    now=target;
  };
  const event=(target,name)=>target.dispatchEvent(new window.Event(name,{bubbles:true}));
  const select=(selector,start=0,end=start)=>{
    const field=document.querySelector(selector);field.focus();
    if(field.tagName==='TEXTAREA')field.setSelectionRange(start,end);
    else{
      const text=field.matches('.note-content')?field.querySelector('p').firstChild:field.firstChild;
      const range=document.createRange();range.setStart(text,start);range.setEnd(text,end);
      window.getSelection().removeAllRanges();window.getSelection().addRange(range);
    }
    event(document,'selectionchange');flush();return field;
  };
  return {window,document,root:document.documentElement,advance,flush,event,select,timers,frames,media,
    overlay:()=>document.querySelector('.notepad-caret-overlay'),
    phase:()=>document.documentElement.style.getPropertyValue('--notepad-blink-opacity'),
    urgentPhase:()=>document.documentElement.style.getPropertyValue('--notepad-urgent-opacity'),
    motion(value){media.matches=value;event(media,'change');},
    visibility(value){hidden=value;event(document,'visibilitychange');flush();},
    focus(value){focused=value;event(window,value?'focus':'blur');flush();},
    caretTop(value){caretTop=value;},
    viewport(changes,eventName='resize'){Object.assign(viewport,changes);viewport.dispatchEvent(new outer.Event(eventName));flush();},
    close(){window.NotepadCaret.destroy();outer.close();},
  };
}

test('urgent marks are lit for on/off/on and dark for off/on/off without resetting during focus and typing',()=>{
  const s=setup({native:true});
  try{
    assert.equal(s.root.dataset.notepadCaret,'native');assert.equal(s.overlay(),null);
    assert.equal(s.phase(),'1');assert.equal(s.urgentPhase(),'1');
    s.advance(475);s.select('#note-title',3);
    s.document.querySelector('.note-urgent').replaceWith(s.document.createElement('span'));
    s.event(s.document.querySelector('#note-title'),'input');
    s.advance(500);assert.equal(s.phase(),'0');assert.equal(s.urgentPhase(),'1');
    assert.equal(s.root.dataset.notepadBlinkOn,'false');
    s.advance(999);assert.equal(s.phase(),'0');assert.equal(s.urgentPhase(),'1');
    s.advance(1000);assert.equal(s.phase(),'1');assert.equal(s.urgentPhase(),'1');
    assert.equal(s.root.dataset.notepadBlinkOn,'true');
    s.advance(1499);assert.equal(s.phase(),'1');assert.equal(s.urgentPhase(),'1');
    s.advance(1500);assert.equal(s.phase(),'0');assert.equal(s.urgentPhase(),'0');
    s.advance(2000);assert.equal(s.phase(),'1');assert.equal(s.urgentPhase(),'0');
    s.advance(2500);assert.equal(s.phase(),'0');assert.equal(s.urgentPhase(),'0');
    s.advance(2999);assert.equal(s.phase(),'0');assert.equal(s.urgentPhase(),'0');
    s.advance(3000);assert.equal(s.phase(),'1');assert.equal(s.urgentPhase(),'1');
    s.advance(4500);assert.equal(s.phase(),'0');assert.equal(s.urgentPhase(),'0');
  }finally{s.close();}
});

test('reduced motion keeps icons and caret steady, and visibility resumes the same clock phase',()=>{
  const s=setup({native:true});
  try{
    s.advance(1600);assert.equal(s.phase(),'0');assert.equal(s.urgentPhase(),'0');
    s.motion(true);assert.equal(s.phase(),'1');assert.equal(s.urgentPhase(),'1');assert.equal(s.timers.size,0);
    s.advance(2200);s.motion(false);assert.equal(s.phase(),'1');assert.equal(s.urgentPhase(),'0');
    s.advance(2500);assert.equal(s.phase(),'0');assert.equal(s.urgentPhase(),'0');
    s.visibility(true);assert.equal(s.timers.size,0);
    s.advance(3300);s.visibility(false);assert.equal(s.phase(),'1');assert.equal(s.urgentPhase(),'1');
    s.advance(3500);assert.equal(s.phase(),'0');assert.equal(s.urgentPhase(),'1');
  }finally{s.close();}
});

test('fallback caret tracks body and checklist selections outside saved content and keeps the selection intact',()=>{
  const s=setup();
  try{
    const editor=s.document.querySelector('.note-content'),before=editor.innerHTML;
    s.select('.note-content',3);
    assert.equal(s.overlay().hidden,false);assert.equal(s.overlay().style.left,'121px');
    assert.equal(s.overlay().style.top,'80px');assert.equal(s.overlay().style.height,'20px');
    assert.equal(s.root.dataset.notepadCaretOverlay,'true');
    assert.equal(s.window.getSelection().anchorOffset,3);assert.equal(editor.innerHTML,before);
    s.select('.task-label',5);
    assert.equal(s.overlay().style.left,'135px');assert.equal(editor.innerHTML,before);
    s.advance(500);assert.equal(s.phase(),'0');
    s.select('.task-label',5,9);
    assert.equal(s.overlay().hidden,true);assert.equal(s.root.dataset.notepadCaretOverlay,undefined);
    assert.equal(s.window.getSelection().toString(),' a g');
    assert.equal(editor.innerHTML,before);
  }finally{s.close();}
});

test('fallback measures wrapping text controls without touching their value, and preserves IME behavior',()=>{
  const s=setup();
  try{
    const title=s.select('#note-title',4),value=title.value;
    assert.equal(s.overlay().hidden,false);assert.equal(s.overlay().style.left,'102px');assert.equal(s.overlay().style.top,'44px');
    assert.equal(title.selectionStart,4);assert.equal(title.value,value);
    s.event(title,'compositionstart');
    assert.equal(s.overlay().hidden,true);assert.equal(s.root.dataset.notepadCaretOverlay,undefined);
    s.event(title,'input');s.flush();assert.equal(s.overlay().hidden,true);
    s.event(title,'compositionend');s.flush();assert.equal(s.overlay().hidden,false);
    const reply=s.select('.reply-input',6);reply.scrollTop=10;
    s.event(reply,'scroll');s.flush();assert.equal(s.overlay().style.top,'34px');
    assert.equal(reply.value,'Reply text');assert.equal(reply.selectionStart,6);
    reply.readOnly=true;s.event(reply,'input');s.flush();assert.equal(s.overlay().hidden,true);
  }finally{s.close();}
});

test('fallback hides for clipping, blur, and cleared account content, and tears down cleanly',async()=>{
  const s=setup();
  try{
    s.select('.note-content',2);assert.equal(s.overlay().hidden,false);
    const clip=s.document.querySelector('.general-notes-scroll');
    clip.getBoundingClientRect=()=>rect(20,10,400,50);
    s.event(clip,'scroll');s.flush();assert.equal(s.overlay().hidden,true);
    clip.getBoundingClientRect=()=>rect(20,10,400,250);
    s.event(clip,'scroll');s.flush();assert.equal(s.overlay().hidden,false);
    s.focus(false);assert.equal(s.overlay().hidden,true);
    s.focus(true);assert.equal(s.overlay().hidden,false);
    s.document.querySelector('#layout-body').replaceChildren();
    await Promise.resolve();s.flush();assert.equal(s.overlay().hidden,true);
    assert.equal(s.document.querySelector('.notepad-caret-mirror').textContent,'');
    s.window.NotepadCaret.destroy();
    assert.equal(s.overlay(),null);assert.equal(s.document.querySelector('.notepad-caret-mirror'),null);
    assert.equal(s.phase(),'');assert.equal(s.timers.size,0);assert.equal(s.frames.size,0);
    assert.equal(s.root.dataset.notepadCaret,undefined);
  }finally{s.close();}
});

test('mobile keyboard reveals the caret using the outer viewport of the note iframe and then leaves manual scroll alone',()=>{
  const s=setup({native:true,mobile:true,keyboard:true});
  try{
    const scroller=s.document.querySelector('.general-notes-scroll');
    const editor=s.select('.note-content',7);
    const before=editor.innerHTML;
    s.caretTop(245);
    s.viewport({height:340,offsetTop:20});
    assert.equal(scroller.scrollTop,92);
    assert.equal(scroller.style.getPropertyValue('--notepad-keyboard-inset'),'75px');
    assert.equal(s.window.getSelection().anchorOffset,7);
    assert.equal(editor.innerHTML,before);
    scroller.scrollTop=42;
    s.event(scroller,'scroll');
    s.viewport({offsetTop:30},'scroll');
    s.viewport({});
    assert.equal(scroller.scrollTop,42);
    s.viewport({height:720,offsetTop:0});
    assert.equal(scroller.style.getPropertyValue('--notepad-keyboard-inset'),'');
  }finally{s.close();}
});

test('a caret already in view, address bar movement, pinch zoom, and desktop viewports do not reposition the note',()=>{
  const mobile=setup({native:true,mobile:true,keyboard:true});
  const desktop=setup({native:true,keyboard:true});
  try{
    const mobileScroll=mobile.document.querySelector('.general-notes-scroll');
    mobile.select('.note-content',4);
    mobile.caretTop(245);
    mobile.viewport({height:656});
    assert.equal(mobileScroll.scrollTop,0);
    mobile.viewport({height:360,scale:2});
    assert.equal(mobileScroll.scrollTop,0);
    mobile.caretTop(85);
    mobile.viewport({height:340,scale:1});
    assert.equal(mobileScroll.scrollTop,0);
    const desktopScroll=desktop.document.querySelector('.general-notes-scroll');
    desktop.select('.note-content',4);
    desktop.caretTop(245);
    desktop.viewport({height:340});
    assert.equal(desktopScroll.scrollTop,0);
    assert.equal(desktopScroll.style.getPropertyValue('--notepad-keyboard-inset'),'');
  }finally{mobile.close();desktop.close();}
});
