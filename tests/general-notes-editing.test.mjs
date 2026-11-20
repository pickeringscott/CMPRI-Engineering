import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {JSDOM} from 'jsdom';
import {loadTs} from './helpers/load-ts.mjs';
import * as notes from '../src/lib/general-notes.ts';
import * as formatting from '../src/lib/general-note-formatting.ts';
import * as mentions from '../src/lib/staff-note-targets.ts';
import * as view from '../src/lib/general-notes-view.ts';
import {GeneralNotesSync} from '../src/lib/general-notes-sync.ts';

const require=createRequire(import.meta.url),dom=new JSDOM('<div id="root"></div>',{url:'https://cmpri.test/notes',pretendToBeVisual:true});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,Event:dom.window.Event,IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const React=await import('react'),{createRoot}=await import('react-dom/client');
const baseGlobals={window,document,localStorage:window.localStorage,NodeFilter:dom.window.NodeFilter,getComputedStyle:dom.window.getComputedStyle,crypto:globalThis.crypto,structuredClone,setTimeout,clearTimeout,requestAnimationFrame:callback=>setTimeout(callback,0),HTMLElement,Element,Event};
const deps={'react':require('react'),'react/jsx-runtime':require('react/jsx-runtime'),'@/lib/general-note-formatting':formatting};
const textModule=loadTs('src/components/GeneralNotesText.tsx',deps,baseGlobals);
const scope={hotelId:'hotel-a',userId:'user-a'};
const saved=(id='older')=>({id,title:id,text:'☑ Inspect seals',fontSize:16,textStyles:[{start:2,end:15,fontSize:24,color:'rgb(10, 100, 200)'}],strokes:[],revision:1,updated:id==='older'?1:2,titleAutomatic:false});
let records,engines,root;
const storage=window.localStorage;
const Component=loadTs('src/components/GeneralNotes.tsx',{
 ...deps,
 './GeneralNotesText':textModule,
 './GeneralNotesChecks':{default:()=>null},'./GeneralNotesInk':{default:()=>null},
 './GeneralNotesMentions':{useGeneralNotesMentions:()=>({tokens:[],keyDown:()=>false})},
 '@/lib/staff-note-targets':mentions,'@/lib/general-notes':notes,'@/lib/general-notes-view':view,
 '@/lib/ui/site-palette-defaults':{sitePalette:{accents:[]},paletteToken:()=>''},'@/app/notes/notes.css':{},
 '@/lib/general-notes-browser':{
  createNotesSync:scope=>{const engine=new GeneralNotesSync(scope,storage,{
   list:async()=>[...records.values()].map(note=>({...note})),read:async id=>records.get(id)||null,write:async()=>{throw Error('Fixture offline');},
  },{idleMs:60_000,maxWaitMs:600_000});engines.push(engine);return engine;},watchNotes:()=>()=>{},
 },
},baseGlobals).default;
const editor=()=>document.querySelector('[aria-label="Note text"]');
async function settle(){for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));}
async function mount(principal=scope){root=createRoot(document.getElementById('root'));await React.act(async()=>{root.render(React.createElement(Component,{scope:principal}));await settle();});}
async function unmount(){if(root){await React.act(async()=>root.unmount());root=null;}}
async function caret(at=editor().textContent.length){await React.act(async()=>{const element=editor();element.focus();const range=textModule.noteTextRange(element,at),selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new dom.window.Event('selectionchange'));});}
async function key(key,options={}){await React.act(async()=>{editor().dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options}));await settle();});}
async function before(inputType,options={}){let event;await React.act(async()=>{event=new dom.window.InputEvent('beforeinput',{inputType,bubbles:true,cancelable:true,...options});editor().dispatchEvent(event);await settle();});return event;}
function reset(){storage.clear();records=new Map([['older',saved()],['newer',saved('newer')]]);engines=[];view.rememberActiveNote(storage,scope,'older');}
test.afterEach(async()=>{await unmount();for(const engine of engines)engine.stop();});
test.after(()=>dom.window.close());

test('desktop Return continues check/bullet lists, empty Return exits, and Shift+Return is a plain line break',async()=>{
 reset();await mount();assert.equal(document.querySelector('#general-note-title').value,'older');await caret();await key('Enter');
 assert.equal(editor().textContent,'☑ Inspect seals\n☐ ');await key('Enter');assert.equal(editor().textContent,'☑ Inspect seals\n');
 await key('Enter',{shiftKey:true});assert.equal(editor().textContent,'☑ Inspect seals\n\n');
 // A soft break inside the existing checked item never creates another marker.
 await caret(7);await key('Enter',{shiftKey:true});assert.equal(editor().textContent,'☑ Inspe\nct seals\n\n');
});

test('mobile beforeinput uses paragraph list semantics, distinct soft breaks, and ignores active IME composition',async()=>{
 reset();records.set('older',{...saved(),text:'• Task',textStyles:[]});await mount();await caret();
 assert.equal((await before('insertParagraph')).defaultPrevented,true);assert.equal(editor().textContent,'• Task\n• ');
 await before('insertParagraph');assert.equal(editor().textContent,'• Task\n');
 await before('insertLineBreak');assert.equal(editor().textContent,'• Task\n\n');
 const composing=await before('insertParagraph',{isComposing:true});assert.equal(composing.defaultPrevented,false);assert.equal(editor().textContent,'• Task\n\n');
});

test('restarting Notes reopens the selected older note with its unsynced check state and style runs',async()=>{
 reset();await mount();await caret(4);await key('Enter',{ctrlKey:true});
 assert.equal(editor().textContent,'☐ Inspect seals');const outboxKey=notes.noteStorageKey(scope)+':outbox';
 const protectedDraft=JSON.parse(storage.getItem(outboxKey));assert.equal(protectedDraft[0].note.text,'☐ Inspect seals');assert.equal(protectedDraft[0].note.textStyles[0].fontSize,24);
 await unmount();await mount();assert.equal(document.querySelector('#general-note-title').value,'older');assert.equal(editor().textContent,'☐ Inspect seals');
 assert.ok([...editor().querySelectorAll('[data-note-size="24"]')].some(span=>span.textContent==='Inspect seals'));
 assert.equal(engines.at(-1).pending.get('older').changeId,protectedDraft[0].changeId,'restart retains the idempotent pending mutation');
});

test('another property or user does not inherit selected-note navigation or the protected draft',async()=>{
 reset();await mount();await caret();await key('Enter');await unmount();
 const originalOutbox=storage.getItem(notes.noteStorageKey(scope)+':outbox');
 records=new Map();await mount({...scope,userId:'user-b'});assert.equal(editor().textContent,'');assert.equal(storage.getItem(notes.noteStorageKey(scope)+':outbox'),originalOutbox);
 assert.equal(view.readActiveNote(storage,{...scope,userId:'user-b'})!==view.readActiveNote(storage,scope),true);
});

test('native insertion replaces a styled selection and treats pasted markup as literal text without execCommand',()=>{
 reset();const element=document.createElement('div');element.innerHTML='<span>☑ </span><span>Task</span>';document.body.append(element);
 try{const selected=window.getSelection(),range=textModule.noteTextRange(element,2,6);selected.removeAllRanges();selected.addRange(range);textModule.noteEditorInsertText(element,'<b>New</b>\n');assert.equal(textModule.noteEditorPlainText(element),'☑ <b>New</b>\n');assert.equal(element.querySelector('b'),null);assert.equal(element.querySelectorAll('[data-note-tail]').length,1);assert.equal(selected.getRangeAt(0).startContainer.textContent,'<b>New</b>\n');}
 finally{element.remove();}
});

test('active-note navigation safely tolerates blocked storage and rejects malformed ids',()=>{
 reset();const denied={getItem(){throw Error('Denied');},setItem(){throw Error('Denied');}};assert.equal(view.readActiveNote(denied,scope),null);assert.doesNotThrow(()=>view.rememberActiveNote(denied,scope,'older'));
 for(const id of ['', 'a'.repeat(201),'bad\nid']){view.rememberActiveNote(storage,scope,id);assert.equal(view.readActiveNote(storage,scope),'older');}
});
