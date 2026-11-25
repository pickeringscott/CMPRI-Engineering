import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';
import { historyExamples, historyPeople } from './fixtures/notepad-history-examples.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/notepad/editor.html');
const css = read('../public/notepad/notepad.css');
const hostCss = read('../public/notepad/host.css');
const approved = read('../docs/previews/Notepad.html');
const modules = ['ink', 'formatting', 'attachments', 'history', 'app'].map(name => read(`../public/notepad/${name}.js`));
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
const settleFocus = s => new Promise(resolve => s.window.setTimeout(resolve, 0));
const plain = value => JSON.parse(JSON.stringify(value));
const user = {id: uuid(1), name: 'Avery Engineer', short: 'Avery', initials: 'AE', role: 'Chief Engineer', roles: ['engineer'], active: true, taggable: true};
const colleague = {id: uuid(2), name: 'Morgan Technician', short: 'Morgan', initials: 'MT', role: 'Technician', roles: ['technician'], active: true, taggable: true};
const roles = [
  {id: 'engineer', label: 'Chief Engineer'}, {id: 'technician', label: 'Technician'},
  {id: 'system_admin', label: 'System Admin'}, {id: 'manager', label: 'General Manager'},
];
const makeNote = (extra = {}) => ({
  id: uuid(10), title: 'Maintenance planning', audience: {all: false, roles: [], people: []},
  content: `<p data-item-id="${uuid(20)}">Review the parts list.</p>`, priority: 'Normal',
  fontSize: 16, fontFamily: 'Comic Sans MS', titleFontFamily: 'Arial', ink: [], itemThreads: {}, attachments: [],
  authorId: user.id, createdAt: '2026-11-23T20:30:00.000Z', updatedAt: '2026-11-23T20:42:00.000Z', revision: 1,
  ...extra,
});

// Run the shipped iframe and its real modules, with only browser APIs missing
// from jsdom shimmed. Host traffic crosses the same message boundary as production.
function setup(extra = {}, initialize = true) {
  const errors = [], outgoing = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html, {url: 'https://cmpri.example/notepad/editor.html?bridge=test-bridge', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole});
  const {window} = dom, {document} = window;
  const host = {postMessage(data, origin) {outgoing.push({data: plain(data), raw: data, origin});}};
  Object.defineProperty(window, 'parent', {value: host, configurable: true});
  window.matchMedia = () => ({matches: true});
  window.Element.prototype.getAnimations = () => [];
  window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  window.HTMLDialogElement.prototype.close = function () {this.open = false;};
  window.HTMLMediaElement.prototype.pause = function () {};
  window.HTMLMediaElement.prototype.load = function () {};
  document.queryCommandState = () => false;
  window.Range.prototype.getBoundingClientRect = () => ({left: 0, top: 0, bottom: 0, width: 0, height: 0});
  const bootstrap = {hotelId: uuid(90), userId: user.id, people: [user, colleague], roles, notes: [makeNote()], order: [uuid(10)], legacyAliases: {}, ...extra};
  const send = (type, payload = {}, boundary = {}) => window.dispatchEvent(new window.MessageEvent('message', {
    origin: boundary.origin ?? window.location.origin, source: boundary.source ?? host,
    data: {channel: 'cmpri-notepad', token: boundary.token ?? 'test-bridge', type, payload: plain(payload)},
  }));
  for (const source of modules) window.eval(source);
  if (initialize) send('initialize', bootstrap);
  const find = selector => {const element = document.querySelector(selector); assert.ok(element, `Missing ${selector}`); return element;};
  const event = (element, type) => element.dispatchEvent(new window.Event(type, {bubbles: true, cancelable: true}));
  const input = (selector, value) => {const element = find(selector); element.value = value; event(element, 'input'); return element;};
  const focus = selector => {
    const element = find(selector);
    // jsdom does not yet recognize contenteditable elements as focusable.
    if (element.hasAttribute('contenteditable')) element.tabIndex = 0;
    element.focus();
    assert.equal(document.activeElement, element);
    return element;
  };
  const saves = () => outgoing.filter(({data}) => data.type === 'save').map(({data}) => data.payload);
  const latestSave = id => saves().filter(save => !id || save.id === id).at(-1);
  const typeMention = value => {
    const editor = focus('.note-content');
    const p = document.createElement('p'); p.dataset.itemId = uuid(20); p.textContent = value;
    editor.replaceChildren(p);
    const range = document.createRange(); range.setStart(p.firstChild, p.textContent.length); range.collapse(true);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    event(editor, 'input');
  };
  return {
    dom, window, document, bootstrap, outgoing, errors, send, find, event, input, focus, saves, latestSave, typeMention,
    click: selector => find(selector).click(),
    cleanup() {send('clear'); window.close(); assert.deepEqual(errors.map(error => error.message), [], 'Runtime raised a browser exception');},
  };
}

function controlledAnimations(s) {
  const animations = [];
  s.window.matchMedia = () => ({matches: false});
  const rectangle = (left,top,width,height) => ({left,top,width,height,right:left+width,bottom:top+height,x:left,y:top});
  s.window.Element.prototype.getBoundingClientRect = function () {
    if (this.matches('[data-action=new]')) return rectangle(12,18,24,24);
    if (this.matches('[data-action=share]')) return rectangle(800,32,100,28);
    if (this.matches('.recipient-dialog')) return rectangle(300,120,440,300);
    return rectangle(230,20,750,600);
  };
  s.window.Element.prototype.animate = function (keyframes,options) {
    let resolve, reject;
    const finished = new Promise((yes,no) => {resolve=yes;reject=no;});
    // Observe cancellation even for a reveal animation whose caller need not await it.
    finished.catch(() => {});
    const animation = {element:this,keyframes:plain(keyframes),options:plain(options),finished,running:true,
      finish() {this.running=false;resolve();},
      cancel() {this.running=false;this.cancelled=true;reject(new Error('Animation cancelled'));},
    };
    animations.push(animation);return animation;
  };
  s.window.Element.prototype.getAnimations = function () {return animations.filter(a => a.element===this&&a.running);};
  return animations;
}

function titleKey(s, key) {
  const event = new s.window.KeyboardEvent('keydown', {key, bubbles: true, cancelable: true});
  s.find('#note-title').dispatchEvent(event);
  return event;
}

test('the approved Familiar Sidebar boots from authenticated data with the exact toolbar and no preview accounts', () => {
  const s = setup({}, false);
  try {
    assert.equal(s.outgoing[0].data.type, 'ready');
    assert.equal(s.document.querySelector('.note-row'), null);
    s.send('initialize', s.bootstrap, {token: 'wrong-token'});
    s.send('initialize', s.bootstrap, {origin: 'https://other.example'});
    s.send('initialize', s.bootstrap, {source: {}});
    assert.equal(s.document.querySelector('.note-row'), null, 'Untrusted host data must not initialize the editor');
    s.send('initialize', s.bootstrap);
    assert.equal(s.find('.np-layout').getAttribute('aria-label'), 'Familiar Sidebar');
    assert.equal(s.document.querySelectorAll('.note-row').length, 1);
    assert.equal(s.document.querySelector('#preview-person'), null);
    for (const name of ['Scott Pickering', 'Isaiah', 'Deon', 'Juana', 'Doug', 'Workshop project']) assert.ok(!s.document.body.textContent.includes(name), name);
    assert.deepEqual(Array.from(s.find('.notepad-formatting').querySelectorAll('button,select'), control => control.getAttribute('aria-label')), [
      'Font', 'Font Size', 'Bold', 'Italic', 'Underline', 'Font Color', 'Align Left', 'Center', 'Align Right', 'Justify',
      'Checklist', 'Bullets', 'Numbers', 'Letters', 'Decrease Indent', 'Increase Indent',
    ]);
    assert.equal(s.find('.note-content').getAttribute('spellcheck'), 'true');
    assert.equal(s.find('.note-row').draggable, true);
    assert.equal(s.document.querySelector('.drag-handle,.drag-placeholder,[data-drag-handle]'), null);
    assert.equal(s.document.querySelectorAll('.search-box button').length, 1);
    assert.equal(s.find('.search-box').firstElementChild.dataset.action, 'new');
    assert.equal(s.find('.note-ink').getAttribute('viewBox'), '0 0 800 1100', 'The real ink controller is attached');
    assert.equal(s.outgoing.some(({data}) => data.type === 'request'), false, 'No GIPHY or file requests occur on boot');
  } finally {s.cleanup();}
});

test('Enter saves a title draft after choosing its font without changing the body font', () => {
  const s = setup();
  try {
    const title = s.focus('#note-title');
    assert.equal(title.tagName, 'TEXTAREA');
    assert.equal(title.getAttribute('wrap'), 'soft');
    s.input('#note-title', 'Pump repair'); title.setSelectionRange(2, 6); s.event(title, 'select');
    assert.equal(s.saves().length, 0);
    const font = s.find('[data-format-select=font]');
    s.event(font, 'pointerdown'); font.focus(); font.value = 'Georgia'; s.event(font, 'change');
    assert.equal(s.saves().length, 0, 'Changing the font stays in the title draft');
    assert.match(title.style.fontFamily, /^"?Georgia"?,/);
    assert.match(s.find('.note-item strong').style.fontFamily, /^"?Arial"?,/);
    assert.equal(s.document.activeElement, title, 'Title focus is restored after choosing its font');
    assert.equal(title.selectionStart, 2); assert.equal(title.selectionEnd, 6);
    const writing = s.find('.note-content'); writing.tabIndex = 0;
    assert.equal(titleKey(s, 'Enter').defaultPrevented, true);
    assert.equal(s.document.activeElement, writing);
    const saved = s.latestSave();
    assert.equal(saved.document.title, 'Pump repair');
    assert.equal(saved.document.titleFontFamily, 'Georgia');
    assert.equal(saved.document.fontFamily, 'Comic Sans MS');
    assert.match(title.style.fontFamily, /^"?Georgia"?,/);
    assert.match(s.find('.note-item strong').style.fontFamily, /^"?Georgia"?,/);
    assert.equal(s.find('.note-item strong').textContent.replace('!', ''), 'Pump repair');
    assert.ok(title.style.fontFamily.includes('Comic Sans MS'));
  } finally {s.cleanup();}
});

test('the title grows and shrinks after editing or narrowing without losing its text or selection', () => {
  const s = setup();
  try {
    const title = s.focus('#note-title');
    let contentHeight = 86;
    Object.defineProperty(title, 'scrollHeight', {get: () => contentHeight});
    const text = 'Shared engineering project: review the lobby lighting and equipment before the holiday weekend';
    s.input('#note-title', text);
    assert.equal(title.style.height, '86px');
    title.setSelectionRange(7, 18);
    contentHeight = 170;
    s.window.dispatchEvent(new s.window.Event('resize'));
    assert.equal(title.style.height, '170px');
    assert.equal(title.value, text);
    assert.equal(s.saves().length, 0);
    assert.equal(title.selectionStart, 7); assert.equal(title.selectionEnd, 18);
    contentHeight = 30;
    s.window.dispatchEvent(new s.window.Event('resize'));
    assert.equal(title.style.height, '30px');
    s.focus('.search-box input');
    assert.equal(s.latestSave().document.title, text);
  } finally {s.cleanup();}
});

test('Escape discards the whole title draft before any title autosave and returns focus to writing', () => {
  const s = setup();
  try {
    const original=s.bootstrap.notes[0].title, title=s.focus('#note-title');
    s.input('#note-title', 'First draft');
    s.input('#note-title', 'Later draft');
    const font=s.find('[data-format-select=font]');
    s.event(font,'pointerdown');font.focus();font.value='Georgia';s.event(font,'change');
    assert.equal(s.saves().length,0);
    const priority=s.find('#note-priority');
    priority.value='High';s.event(priority,'change');
    assert.equal(s.latestSave().document.title,original,'An unrelated save never flushes title text');
    assert.equal(s.latestSave().document.titleFontFamily,'Arial');
    const body=s.find('.note-content');body.tabIndex=0;
    assert.equal(titleKey(s,'Escape').defaultPrevented,true);
    assert.equal(title.value,original);
    assert.match(title.style.fontFamily,/^"?Arial"?,/);
    assert.equal(s.find('.note-item strong').textContent,original);
    assert.equal(s.document.activeElement,body);
    assert.ok(body.contains(s.window.getSelection().anchorNode));
    s.focus('#note-title');s.input('#note-title','A second draft');
    font.focus();
    font.dispatchEvent(new s.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    assert.equal(title.value,original);
    assert.equal(s.document.activeElement,body);
    s.send('flush',{requestId:uuid(400)});
    assert.ok(s.saves().every(({document})=>document.title===original&&document.titleFontFamily==='Arial'));
  } finally {s.cleanup();}
});

test('collaborators cannot edit the title and still autosave body changes', () => {
  const saved=makeNote({authorId:colleague.id,audience:{all:true,roles:[],people:[]}});
  const s=setup({notes:[saved]});
  try {
    const title=s.focus('#note-title');
    assert.equal(title.readOnly,true);
    assert.match(title.title,/creator/);
    const font=s.find('[data-format-select=font]');
    assert.equal(font.disabled,true);
    font.value='Georgia';s.event(font,'change');
    assert.match(title.style.fontFamily,/^"?Arial"?,/);
    s.input('#note-title','Synthetic title change');
    assert.equal(title.value,saved.title);
    assert.equal(s.saves().length,0);
    title.value='Unsanctioned DOM value';
    const body=s.focus('.note-content');
    assert.equal(font.disabled,false);
    body.firstElementChild.textContent='Collaborator can still write';
    s.event(body,'input');
    assert.equal(s.latestSave().document.title,saved.title);
    assert.match(s.latestSave().document.content,/Collaborator can still write/);
  } finally {s.cleanup();}
});

test('switching notes commits the creator’s title once to the original note', async () => {
  const original=makeNote(), next=makeNote({id:uuid(11),title:'Other note'});
  const s=setup({notes:[original,next],order:[original.id,next.id]});
  try {
    s.focus('#note-title');
    s.input('#note-title','Edit before switching');
    s.send('select',{id:next.id});
    await tick();
    assert.equal(s.find('#note-title').value,next.title);
    assert.deepEqual(s.saves().map(entry=>[entry.id,entry.document.title]),[[original.id,'Edit before switching']]);
  } finally {s.cleanup();}
});

test('urgent images, left-aligned priority and inline attribution share the note header', () => {
  const s = setup();
  try {
    const editor = s.find('.general-notes-editor'), details = s.find('.note-details');
    assert.ok(editor.firstElementChild.classList.contains('title-row'));
    assert.equal(details.parentElement, s.find('.note-title-fields'));
    assert.equal(details.previousElementSibling, s.find('.note-heading'));
    assert.deepEqual(Array.from(details.children, node => node.tagName), ['LABEL', 'SELECT']);
    assert.equal(editor.firstElementChild.nextElementSibling, s.find('.notepad-formatting'));
    assert.equal(s.find('.title-identity').firstElementChild, s.find('.title-actions'));
    assert.equal(s.find('.title-actions').nextElementSibling, s.find('.note-attribution'));
    assert.equal(s.find('.note-attribution').firstElementChild, s.find('.note-creator'));
    assert.equal(s.find('.note-creator').textContent, user.name);
    assert.equal(s.find('.note-creator').nextElementSibling, s.find('.note-attribution time'));
    assert.equal(s.find('.note-attribution time').getAttribute('datetime'),s.bootstrap.notes[0].createdAt);
    assert.equal(s.find('.note-attribution time').textContent,'11/23 14:30');
    assert.equal(s.find('.note-attribution time').nextElementSibling, s.find('.note-history-link'));
    assert.equal(s.find('.sidebar-creation').textContent,'23 Nov 14:30');
    assert.equal(s.document.querySelector('.general-notes-save'), null);
    s.send('status', {message: 'Saving…'});
    s.send('status', {message: 'Saved 14:42'});
    assert.equal(s.document.querySelector('.save-label'), null);
    assert.ok(!s.document.body.textContent.includes('Saved 14:42'));
    assert.ok(!s.document.body.textContent.includes('Saving…'));
    assert.equal(s.find('[data-action=share]').textContent, 'Shared with…');
    assert.equal(s.find('[data-action=share]').querySelectorAll('svg').length, 1);
    const priority = s.find('#note-priority'); priority.value = 'Urgent'; s.event(priority, 'change');
    assert.equal(priority.selectedOptions[0].textContent, 'Urgent!');
    assert.equal(s.find('.note-heading .note-urgent').hidden, false);
    assert.equal(s.find('.note-item .note-urgent').hidden, false);
    for (const selector of ['.note-heading .note-urgent', '.note-item .note-urgent']) {
      const marker = s.find(selector);
      assert.equal(marker.textContent, '');
      assert.equal(marker.querySelector('img').getAttribute('src'), '/notepad/urgent-button.jpg');
    }
    assert.equal(s.latestSave().document.priority, 'Urgent');
    assert.match(hostCss, /\.priority-row\.note-details\{[^}]*justify-content:flex-start[^}]*font-size:var\(--note-metadata-size\)/);
    assert.match(hostCss, /\.note-attribution\{[^}]*font:var\(--note-metadata-size\)/);
    assert.match(css, /\.priority-row\.note-details > \* \{[^}]*font: inherit/);
    assert.match(hostCss, /\.priority-row\.note-details #note-priority\{[^}]*border:0/);
    assert.match(css, /\.title-actions button \{[^}]*border: 0/);
    assert.match(hostCss, /\.title-actions\{align-items:flex-end/);
    assert.match(hostCss, /\.title-actions \.scope-button\{[^}]*box-shadow:none;cursor:pointer/);
    priority.value = 'Normal'; s.event(priority, 'change');
    assert.equal(s.find('.note-heading .note-urgent').hidden, true);
    assert.equal(s.find('.note-item .note-urgent').hidden, true);
  } finally {s.cleanup();}
});

test('pen controls keep the chosen swatch and live stroke width without extra heading or close button',()=>{
  const s=setup();
  try{
    s.click('[data-mode=pen]');
    const popover=s.find('.tool-bubble');
    assert.equal(popover.querySelector('.popover-header,[data-action=close-popover]'),null);
    assert.deepEqual(Array.from(popover.querySelectorAll('.color-swatches button'),el=>el.getAttribute('aria-label')),['Black ink','Red ink','Green ink','Blue ink','Orange ink','Yellow ink','Purple ink','White ink']);
    for(const name of ['Orange','Yellow','White'])assert.equal(s.find(`[aria-label="${name} ink"]`).style.getPropertyValue('--swatch-check'),'#000000');
    s.click('[aria-label="Orange ink"]');
    assert.equal(s.find('[aria-label="Orange ink"]').getAttribute('aria-pressed'),'true');
    assert.equal(s.find('[aria-label="White ink"]').getAttribute('aria-pressed'),'false');
    const slider=s.find('[aria-label="Pen width"]');slider.value='9';s.event(slider,'input');
    assert.equal(slider.style.getPropertyValue('--pen-size'),'9px');
    assert.equal(s.find('.width-control output').value,'9');
    s.event(s.find('.note-heading'),'pointerdown');
    assert.equal(s.document.querySelector('.tool-bubble'),null);
    assert.equal(s.find('[data-mode=pen]').getAttribute('aria-pressed'),'true');
    s.click('[data-mode=pen]');
    assert.equal(s.find('[aria-label="Pen width"]').value,'9');
    assert.equal(s.find('[aria-label="Orange ink"]').getAttribute('aria-pressed'),'true');
    assert.equal(s.saves().length,0,'Choosing pen tools does not change note content before drawing');
  }finally{s.cleanup();}
});

test('all five synthetic notes show actor-attributed additions, edits, deletions and replies inside the note',async()=>{
  for(const {note,entries} of historyExamples){
    const s=setup({userId:historyPeople[0].id,people:historyPeople,notes:[note],order:[note.id]});
    try{
      const link=s.find('.note-history-link'),panel=s.find('.note-history');
      assert.equal(panel.hidden,true);
      link.click();
      const request=s.outgoing.at(-1).data;
      assert.equal(request.action,'history');
      assert.deepEqual(request.payload,{id:note.id,before:null});
      s.send('result',{requestId:request.requestId,result:{entries,next:null}});await tick();
      assert.equal(panel.hidden,false);
      assert.equal(link.getAttribute('aria-expanded'),'true');
      assert.equal(panel.closest('.general-notes-editor'),s.find('.general-notes-editor'));
      assert.equal(panel.querySelectorAll('.history-version').length,3);
      assert.equal(panel.querySelector('.history-version .history-editor-name').textContent,entries[0].actorName);
      assert.equal(panel.querySelector('.history-version time').dateTime,entries[0].at);
      assert.match(panel.querySelector('.history-version').textContent,/Note text/);
      assert.match(panel.querySelector('.history-version').textContent,/Replies/);
      assert.ok(panel.querySelector('.history-line[data-change=added]'));
      assert.ok(panel.querySelector('.history-line[data-change=removed]'));
      assert.match(panel.querySelector('.history-version').textContent,/before leaving the area/);
      panel.querySelector('.history-button').click();
      assert.equal(panel.hidden,true);
      assert.equal(s.document.activeElement,link);
      assert.equal(s.saves().length,0);
    }finally{s.cleanup();}
  }
});

test('Edit History opens for a private note owner and for each kind of authorized recipient', async () => {
  const audiences = [
    [user, {all: false, roles: [], people: []}],
    [colleague, {all: false, roles: [], people: [colleague.id]}],
    [colleague, {all: false, roles: ['technician'], people: []}],
    [colleague, {all: true, roles: [], people: []}],
  ];
  for (const [viewer, audience] of audiences) {
    const note = makeNote({audience});
    const s = setup({userId: viewer.id, notes: [note], order: [note.id]});
    try {
      s.click('.note-history-link');
      const request = s.outgoing.at(-1).data;
      assert.equal(request.action, 'history');
      assert.equal(request.payload.id, note.id);
      s.send('result', {requestId: request.requestId, result: {entries: [], next: null}});
      await tick();
      assert.equal(s.find('.note-history').hidden, false);
      assert.match(s.find('.history-status').textContent, /No edits have been recorded/);
    } finally {s.cleanup();}
  }
});

test('Edit History shows selected body and reply tags without exposing their @ prefixes',async()=>{
  const s=setup();
  try{
    s.click('.note-history-link');
    const request=s.outgoing.at(-1).data;
    const body='<p><span class="mention" data-mention-kind="person">@Morgan</span> and literal @Morgan</p>';
    const text='@Morgan and literal @Morgan';
    const reply={authorId:colleague.id,text,mentions:[{id:colleague.id,kind:'person',start:0,end:7}],replies:[]};
    const entry={revision:2,at:'2026-11-23T20:31:00.000Z',kind:'updated',actorId:user.id,
      before:{content:'<p>Before</p>',itemThreads:{}},after:{content:body,itemThreads:{item:[reply]}}};
    s.send('result',{requestId:request.requestId,result:{entries:[entry],next:null}});
    await tick();
    const added=[...s.document.querySelectorAll('.history-line[data-change=added]')].map(line=>line.textContent);
    assert.equal(added.filter(line=>line.includes('Morgan and literal @Morgan')).length,2);
    assert.ok(added.every(line=>!line.includes('@Morgan and literal')));
  }finally{s.cleanup();}
});

test('Revoking a recipient closes their history panel and preserves their unsaved draft', async () => {
  const note = makeNote({audience: {all: false, roles: [], people: [colleague.id]}});
  const s = setup({userId: colleague.id, notes: [note], order: [note.id]});
  try {
    const body = s.focus('.note-content');
    body.firstElementChild.textContent = 'Unsaved synthetic edit';
    s.event(body, 'input');
    s.click('.note-history-link');
    const request = s.outgoing.at(-1).data;
    assert.equal(request.action, 'history');
    assert.equal(s.find('.note-history').hidden, false);
    s.send('remote', {notes: []});
    s.send('result', {requestId: request.requestId, result: {entries: [], next: null}});
    await tick();
    assert.equal(s.find('.note-history').hidden, true);
    assert.match(s.find('.note-content').textContent, /Unsaved synthetic edit/);
    assert.match(s.latestSave().document.content, /Unsaved synthetic edit/);
  } finally {s.cleanup();}
});

test('sidebar shows recipient first names before the creation time and responds to time preference changes',()=>{
  const note=makeNote({audience:{all:false,roles:[],people:[colleague.id]},createdAt:'2026-11-25T04:38:00.000Z'});
  const s=setup({notes:[note]});
  try{
    assert.equal(s.find('.audience-meta').textContent,colleague.short);
    assert.equal(s.find('.audience-meta').nextElementSibling,s.find('.sidebar-creation'));
    assert.equal(s.find('.sidebar-creation').textContent,'24 Nov 22:38');
    assert.ok(!s.find('.note-meta').textContent.includes(user.name));
    s.send('remote',{people:[user,colleague],roles,notes:[note],timeFormat:'12h'});
    assert.equal(s.find('.sidebar-creation').textContent,'24 Nov 10:38 PM');
  }finally{s.cleanup();}
});

test('stored tags display without the trigger while formatted and literal text survives editing',()=>{
  const content='<p data-item-id="fixture"><span class="mention" data-mention-kind="location" data-mention-id="lobby"><strong>@Lobby</strong></span> <span class="mention" data-mention-kind="person" data-mention-id="person"><strong>@Morgan</strong></span> <span class="mention" data-mention-kind="role" data-mention-id="engineer">@Chief Engineer</span> plain @Morgan</p>';
  const s=setup({notes:[makeNote({content})]});
  try{
    assert.equal(s.find('.mention[data-mention-kind=location] strong').textContent,'Lobby');
    assert.equal(s.find('.mention[data-mention-kind=person] strong').textContent,'Morgan');
    assert.equal(s.find('.mention[data-mention-kind=role]').textContent,'Chief Engineer');
    assert.match(s.find('.note-content').textContent,/plain @Morgan/);
    s.event(s.find('.note-content'),'input');
    s.input('#note-title','Edited location note');
    titleKey(s,'Enter');
    assert.match(s.latestSave().document.content,/<strong>Lobby<\/strong>/);
    assert.match(s.latestSave().document.content,/<strong>@Morgan<\/strong>/);
    assert.match(s.latestSave().document.content,/>@Chief Engineer<\/span>/);
    assert.doesNotMatch(s.latestSave().document.content,/data-np-tag-prefix/);
  }finally{s.cleanup();}
});

test('new notes default to Just me, and Engineering and All Roles serialize canonical recipients', () => {
  const s = setup();
  try {
    s.click('[data-action=new]');
    assert.equal(s.find('[data-recipient=private]').checked, true);
    assert.deepEqual(Array.from(s.document.querySelectorAll('.recipient-section h3'), el => el.textContent), ['Individual Names', 'Roles and Departments']);
    assert.equal(s.document.querySelectorAll('.recipient-dialog input:checked').length, 1);
    s.event(s.find('#recipient-form'), 'submit');
    assert.deepEqual(s.latestSave().document.audience, {all: false, roles: [], people: []});
    assert.equal(s.latestSave().document.titleFontFamily,'Comic Sans MS');
    s.click('[data-action=share]');
    const engineering = s.find('[data-recipient=engineering]'); engineering.checked = true; s.event(engineering, 'change');
    s.event(s.find('#recipient-form'), 'submit');
    assert.deepEqual(s.latestSave().document.audience, {all: false, roles: ['engineer', 'technician', 'system_admin'], people: []});
    s.click('[data-action=share]');
    const all = s.find('[data-recipient=all]'); all.checked = true; s.event(all, 'change');
    s.event(s.find('#recipient-form'), 'submit');
    assert.deepEqual(s.latestSave().document.audience, {all: true, roles: [], people: []});
  } finally {s.cleanup();}
});

test('New Note silently reopens a named old untouched draft and a first-save pre-update draft', async () => {
  for (const extra of [{untouchedDraft:true,revision:7},{revision:1,content:'<p><br></p>'}]) {
    const draft=makeNote({id:uuid(11),title:'Project saved long ago',content:'',createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2020-01-01T00:00:00.000Z',...extra});
    const s=setup({notes:[makeNote(),draft],order:[uuid(10),draft.id]});
    try {
      s.input('.search-box input','parts');
      s.click('[data-action=new]');await tick();
      assert.equal(s.document.querySelector('.recipient-dialog'),null);
      assert.equal(s.document.querySelector('.delete-dialog'),null);
      assert.equal(s.find('#preview-toast').textContent,'');
      assert.equal(s.find('#note-title').value,draft.title);
      assert.equal(s.document.activeElement,s.find('#note-title'));
      assert.equal(s.find('.search-box input').value,'');
      assert.equal(s.document.querySelectorAll('.note-row').length,2);
      assert.equal(s.find('.note-row[data-current=true]').dataset.row,draft.id);
      if (draft.untouchedDraft!==true) assert.equal(s.latestSave(draft.id).document.untouchedDraft,true);
    } finally {s.cleanup();}
  }
});

test('a new draft is reusable until a title or body edit, even when that edit is cleared before saving', () => {
  for (const field of ['title','body']) {
    const s=setup();
    try {
      s.click('[data-action=new]');s.event(s.find('#recipient-form'),'submit');
      const created=s.latestSave(),draftId=created.id;
      assert.equal(created.document.untouchedDraft,true);
      assert.equal(created.baseRevision,null);
      s.click('[data-action=new]');
      assert.equal(s.document.querySelector('.recipient-dialog'),null);
      assert.equal(s.find('.note-row[data-current=true]').dataset.row,draftId);
      if(field==='title'){s.input('#note-title','Temporary title');s.input('#note-title','');titleKey(s,'Enter');}
      else{const body=s.find('.note-content');body.innerHTML='<p>Temporary body</p>';s.event(body,'input');body.innerHTML='';s.event(body,'input');}
      assert.equal(s.latestSave(draftId).document.untouchedDraft,false);
      s.click('[data-action=new]');assert.ok(s.find('.recipient-dialog'));
      s.event(s.find('#recipient-form'),'submit');
      assert.notEqual(s.latestSave().id,draftId);
      assert.equal(s.document.querySelectorAll('.note-row').length,3);
    } finally {s.cleanup();}
  }
});

test('New Note does not reuse collaborators, legacy records, edited empty notes, or empty list structures', () => {
  const candidates=[
    {authorId:colleague.id,audience:{all:true,roles:[],people:[]},untouchedDraft:true},
    {legacySource:'general',revision:0,untouchedDraft:true},
    {untouchedDraft:false},
    {revision:2},
    {content:'<ul><li></li></ul>',untouchedDraft:true},
    {content:'<input type="checkbox">',untouchedDraft:true},
    {ink:[{id:'ink',color:'#000000',size:2,points:[{x:1,y:2,p:.5}]}],untouchedDraft:true},
  ];
  for(const extra of candidates){
    const s=setup({notes:[makeNote({content:'',...extra})]});
    try{s.click('[data-action=new]');assert.ok(s.find('#recipient-form'),JSON.stringify(extra));assert.equal(s.document.querySelectorAll('.note-row').length,1);}
    finally{s.cleanup();}
  }
});

test('sharing pills let creators add and remove recipients without duplicating names, while hidden identities stay absent', () => {
  const hidden={...colleague,id:uuid(300),name:'Scott Pickering',role:'System Admin',roles:['system_admin'],recipientSelectable:false};
  const chief={...user,id:uuid(301),name:'Scott P',role:'chief_engineer',recipientSelectable:true};
  const s=setup({people:[user,colleague,hidden,chief]});
  try{
    s.click('[data-action=share]');
    assert.equal(s.find('#recipient-heading').textContent,'Who’s it for?');
    assert.equal(s.document.querySelector('.recipient-summary'),null);
    assert.equal(s.document.querySelector(`[data-recipient=person][value="${hidden.id}"]`),null);
    assert.equal(s.find(`[data-recipient=person][value="${chief.id}"]`).closest('.recipient-pill').textContent,'Scott P (Chief Engineer)');
    assert.equal(s.document.querySelectorAll(`[data-recipient=person][value="${colleague.id}"]`).length,1);
    s.click(`[data-recipient=person][value="${colleague.id}"]`);
    s.event(s.find('#recipient-form'),'submit');
    assert.deepEqual(s.latestSave().document.audience,{all:false,roles:[],people:[colleague.id]});
    s.click('[data-action=share]');assert.equal(s.find(`[data-recipient=person][value="${colleague.id}"]`).checked,true);
    s.click(`[data-recipient=person][value="${colleague.id}"]`);
    assert.equal(s.find('[data-recipient=private]').checked,true);
    s.event(s.find('#recipient-form'),'submit');
    assert.deepEqual(s.latestSave().document.audience,{all:false,roles:[],people:[]});
  }finally{s.cleanup();}
  const shared=setup({notes:[makeNote({authorId:colleague.id,audience:{all:true,roles:[],people:[]}})]});
  try{
    shared.click('[data-action=share]');
    assert.ok(Array.from(shared.find('.recipient-dialog').querySelectorAll('input,button[type=submit]')).every(el=>el.disabled));
    const privateChoice=shared.find('[data-recipient=private]');privateChoice.checked=true;shared.event(privateChoice,'change');
    shared.event(shared.find('#recipient-form'),'submit');
    assert.ok(shared.find('.recipient-dialog'),'A synthetic submit cannot change sharing without ownership');
    assert.equal(shared.saves().length,0);
  }finally{shared.cleanup();}
});

test('sharing telescopes from and back to the control that opened it', async () => {
  const s=setup(),animations=controlledAnimations(s),origins=[];
  try{
    for(const action of ['new','share']){
      const origin=s.find(`[data-action=${action}]`);origin.click();
      const dialog=s.find('.recipient-dialog'),opening=animations.at(-1);
      assert.equal(opening.element,dialog);assert.equal(opening.keyframes[0].opacity,0);
      origins.push(opening.keyframes[0].transform);
      opening.finish();await tick();
      s.click('[data-action=cancel-recipients]');
      const closing=animations.at(-1);
      assert.equal(closing.element,dialog);
      assert.deepEqual(closing.keyframes,[opening.keyframes[1],opening.keyframes[0]]);
      assert.equal(dialog.isConnected,true,'Dialog remains until the closing telescope finishes');
      closing.finish();await tick();
      assert.equal(dialog.isConnected,false);assert.equal(s.document.activeElement,origin);
    }
    assert.notEqual(origins[0],origins[1],'New Note and Shared with use their distinct origins');
  }finally{s.cleanup();}
});

test('recipient backdrop cancels changes and the Create Note button shares the Just Me row', () => {
  const s=setup();
  try {
    for(const action of ['new','share']){
      const origin=s.find('[data-action='+action+']');
      origin.click();
      const dialog=s.find('.recipient-dialog'),privateChoice=s.find('[data-recipient=private]').closest('label'),submit=s.find('#recipient-form button[type=submit]');
      assert.equal(privateChoice.textContent,'Just Me');
      assert.equal(dialog.querySelectorAll('[data-action=cancel-recipients]').length,1);
      assert.equal(dialog.querySelector('[data-action=cancel-recipients]').textContent,'×');
      if(action==='new'){
        assert.equal(submit.textContent,'Create Note');
        assert.equal(submit.parentElement,privateChoice.parentElement);
      }else{
        assert.equal(submit.textContent,'Save recipients');
        assert.equal(submit.closest('.recipient-footer'),submit.parentElement);
      }
      dialog.getBoundingClientRect=()=>({left:20,right:420,top:30,bottom:330});
      const saveCount=s.saves().length;
      s.click('[data-recipient=person][value="'+colleague.id+'"]');
      assert.equal(s.find('[data-recipient=private]').checked,false);
      const pointerAt=(event,x)=>dialog.dispatchEvent(new s.window.MouseEvent(event,{bubbles:true,clientX:x,clientY:32}));
      pointerAt('pointerdown',22);pointerAt('click',22);
      assert.equal(dialog.isConnected,true,'Clicking the dialog padding does not dismiss it');
      pointerAt('pointerdown',22);pointerAt('click',12);
      assert.equal(dialog.isConnected,true,'Dragging off the dialog does not dismiss it');
      pointerAt('pointerdown',12);pointerAt('click',12);
      assert.equal(dialog.isConnected,false);
      assert.equal(s.document.activeElement,origin);
      assert.equal(s.saves().length,saveCount);
      assert.equal(s.document.querySelectorAll('.note-row').length,1);
      assert.equal(s.find('.audience-meta').textContent,'Just me');
    }
  }finally{s.cleanup();}
});

test('Create Note waits for the dialog to collapse, creates once, and expands the new note from its center', async () => {
  const s=setup(),animations=controlledAnimations(s);
  try{
    s.click('[data-action=new]');const opening=animations.at(-1);opening.finish();await tick();
    const form=s.find('#recipient-form');s.event(form,'submit');s.event(form,'submit');
    const closing=animations.at(-1);
    assert.equal(animations.length,2,'Duplicate submits share one closing animation');
    assert.equal(s.document.querySelectorAll('.note-row').length,1);
    assert.equal(s.saves().length,0,'Creation waits for telescope completion');
    assert.deepEqual(closing.keyframes,[opening.keyframes[1],opening.keyframes[0]]);
    closing.finish();await tick();
    assert.equal(s.document.querySelector('.recipient-dialog'),null);
    assert.equal(s.document.querySelectorAll('.note-row').length,2);
    const created=s.saves().filter(save=>save.baseRevision===null);
    assert.equal(created.length,1);assert.equal(created[0].document.untouchedDraft,true);
    const expanding=animations.at(-1);
    assert.equal(expanding.element,s.find('.general-notes-editor'));
    assert.equal(expanding.keyframes[0].transformOrigin,'center center');
    assert.equal(expanding.keyframes[1].transformOrigin,'center center');
    assert.equal(expanding.keyframes[0].opacity,0);assert.equal(expanding.keyframes[1].opacity,1);
    assert.equal(s.document.activeElement,s.find('#note-title'));
    expanding.finish();await tick();
  }finally{s.cleanup();}
});

test('account clear cancels a closing Create Note dialog before it can create in the next account', async () => {
  const s=setup(),animations=controlledAnimations(s);
  try{
    s.click('[data-action=new]');animations.at(-1).finish();await tick();
    s.event(s.find('#recipient-form'),'submit');const closing=animations.at(-1);
    s.send('clear');
    assert.equal(closing.cancelled,true);assert.equal(s.document.querySelector('.recipient-dialog'),null);
    const nextUser={...user,id:uuid(302),name:'Next account'};
    s.send('initialize',{...s.bootstrap,userId:nextUser.id,people:[nextUser],notes:[],order:[]});
    closing.finish();await tick();
    assert.equal(s.document.querySelector('.note-row'),null);
    assert.equal(s.saves().length,0);
  }finally{s.cleanup();}
});

test('a close flush commits an accepted recipient submit before acknowledgement and late animation completion cannot duplicate it', async () => {
  for(const action of ['new','share']){
    const s=setup(),animations=controlledAnimations(s);
    try{
      s.click(`[data-action=${action}]`);animations.at(-1).finish();await tick();
      s.click(`[data-recipient=person][value="${colleague.id}"]`);
      s.event(s.find('#recipient-form'),'submit');const closing=animations.at(-1);
      assert.equal(s.saves().length,0);
      const requestId=uuid(500);s.send('flush',{requestId});
      assert.equal(closing.cancelled,true);
      assert.equal(s.document.querySelector('.recipient-dialog'),null);
      const saveIndex=s.outgoing.findIndex(({data})=>data.type==='save');
      const acknowledgementIndex=s.outgoing.findIndex(({data})=>data.type==='flushed'&&data.payload.requestId===requestId);
      assert.ok(saveIndex>=0&&acknowledgementIndex>saveIndex,'The accepted note change enters the host outbox before closing is acknowledged');
      assert.equal(s.saves().length,1);
      assert.deepEqual(s.latestSave().document.audience,{all:false,roles:[],people:[colleague.id]});
      assert.equal(s.latestSave().document.untouchedDraft,action==='new');
      closing.finish();await tick();
      assert.equal(s.saves().length,1);
      assert.equal(s.document.querySelectorAll('.note-row').length,action==='new'?2:1);
      for(const animation of animations)if(animation.running)animation.finish();
      await tick();
    }finally{s.cleanup();}
  }
});

test('the first trash click after a save acknowledgement survives focusout and deletes only the confirmed note', async () => {
  const s=setup({notes:[makeNote(),makeNote({id:uuid(11),title:'Keep this note'})],order:[uuid(10),uuid(11)]});
  try{
    s.focus('#note-title');s.input('#note-title','Note to delete');titleKey(s,'Enter');s.focus('#note-title');
    const sent=s.latestSave(),canonical={...s.bootstrap.notes[0],...sent.document,revision:2};
    s.send('saved',{id:canonical.id,sequence:sent.sequence,revision:2,note:canonical});
    const trash=s.find('[data-action=delete]');
    s.event(trash,'pointerdown');trash.focus();
    // A real pointer can remain down after focusout's deferred refresh runs.
    await settleFocus(s);
    assert.equal(trash.isConnected,true,'A save refresh must not replace the pending trash click target');
    assert.equal(s.find('[data-action=delete]'),trash);
    trash.click();
    assert.equal(s.find('#delete-message').textContent,'Remove Note to delete from Notepad');
    s.click('[data-action=confirm-delete]');
    const deletion=s.latestSave(uuid(10));
    assert.equal(deletion.document,null);assert.equal(deletion.baseRevision,2);
    assert.equal(s.find('#note-title').value,'Keep this note');
    assert.equal(s.document.querySelectorAll('.note-row').length,1);
  }finally{s.cleanup();}
});

test('a restricted trash click explains ownership and cannot delete through a normal or synthetic click', () => {
  const s=setup({notes:[makeNote({authorId:colleague.id,audience:{all:true,roles:[],people:[]}})]});
  try{
    const trash=s.find('[data-action=delete]');assert.equal(trash.getAttribute('aria-disabled'),'true');
    trash.click();
    assert.equal(s.find('#preview-toast').textContent,'Only the note’s creator can delete it.');
    assert.equal(s.find('#preview-toast').classList.contains('visible'),true);
    s.event(trash,'click');
    assert.equal(s.document.querySelector('.delete-dialog'),null);
    assert.equal(s.document.querySelectorAll('.note-row').length,1);
    assert.equal(s.saves().length,0);
  }finally{s.cleanup();}
});

test('delete confirmation has the requested wording, drags without a title bar, and deletes its captured note only', async () => {
  const title='Pump <repair> & follow-up';
  const s=setup({notes:[makeNote({title}),makeNote({id:uuid(11),title:'Keep this note'})],order:[uuid(10),uuid(11)]});
  try{
    s.click('[data-action=delete]');const dialog=s.find('.delete-dialog');
    assert.equal(s.find('#delete-heading').textContent,'Delete this note');
    assert.equal(s.find('#delete-message').textContent,`Remove ${title} from Notepad`);
    assert.equal(dialog.querySelector('.popover-header,.recipient-heading'),null);
    assert.deepEqual(Array.from(dialog.querySelectorAll('button'),el=>el.textContent),['Cancel','Delete']);
    assert.equal(s.document.activeElement,s.find('[data-action=cancel-delete]'));
    dialog.getBoundingClientRect=()=>({left:100,top:100,width:330,height:120});
    const captured=new Set();dialog.setPointerCapture=id=>captured.add(id);dialog.hasPointerCapture=id=>captured.has(id);dialog.releasePointerCapture=id=>captured.delete(id);
    const pointer=(target,type,x,y)=>{const event=new s.window.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:8});target.dispatchEvent(event);};
    pointer(s.find('#delete-heading'),'pointerdown',120,120);pointer(s.document,'pointermove',170,145);
    assert.equal(dialog.style.left,'150px');assert.equal(dialog.style.top,'125px');
    pointer(s.document,'pointerup',170,145);assert.equal(captured.size,0);
    s.click('[data-action=cancel-delete]');assert.equal(s.document.querySelector('.delete-dialog'),null);assert.equal(s.saves().length,0);
    s.click('[data-action=delete]');
    s.send('select',{id:uuid(11)});await tick();
    assert.equal(s.find('#note-title').value,'Keep this note');
    s.click('[data-action=confirm-delete]');
    assert.equal(s.latestSave(uuid(10)).document,null);
    assert.equal(s.find('#note-title').value,'Keep this note');
    assert.equal(s.document.querySelectorAll('.note-row').length,1);
  }finally{s.cleanup();}
});

test('a slower refresh cannot restore a note after its deletion is acknowledged', () => {
  for(const legacy of [false,true])for(const keepSibling of [false,true]){
    const deleted=makeNote(legacy?{revision:0,legacySource:'staff',legacyVersion:'staff:'+'a'.repeat(64)}:{});
    const kept=makeNote({id:uuid(11),title:'Keep this note'}),notes=keepSibling?[deleted,kept]:[deleted];
    const s=setup({notes,order:notes.map(n=>n.id)});
    try{
      s.click('[data-action=delete]');s.click('[data-action=confirm-delete]');
      const pending=s.latestSave(deleted.id);
      assert.equal(pending.document,null);
      assert.equal(pending.baseRevision,deleted.revision);
      if(legacy)assert.equal(pending.baseLegacyVersion,deleted.legacyVersion);
      s.send('remote',{notes});
      assert.equal(s.document.querySelector(`[data-note="${deleted.id}"]`),null,'Pending deletion survives a refresh');
      s.send('saved',{id:deleted.id,sequence:pending.sequence,note:null,revision:deleted.revision+1});
      // A GET begun before the delete can finish after its PUT acknowledgement.
      s.send('remote',{notes});s.send('remote',{notes});
      assert.equal(s.document.querySelector(`[data-note="${deleted.id}"]`),null,'Acknowledged deletion survives later stale snapshots');
      if(keepSibling)assert.equal(s.find('#note-title').value,kept.title);
      else assert.ok(s.find('.editor-empty'),'Deleting the last note leaves the empty editor');
      assert.equal(s.document.querySelectorAll('.note-row').length,keepSibling?1:0);
      assert.equal(s.saves().filter(save=>save.id===deleted.id).length,1,'Stale snapshots must not cause a new save');
    }finally{s.cleanup();}
  }
});

test('a rejected deletion can restore the saved note after its pending draft is discarded', () => {
  const saved=makeNote(),s=setup({notes:[saved]});
  try{
    s.click('[data-action=delete]');s.click('[data-action=confirm-delete]');
    assert.equal(s.document.querySelector('.note-row'),null);
    s.send('discard',{ids:[saved.id]});
    s.send('remote',{notes:[saved]});
    assert.equal(s.find('.note-row').dataset.row,saved.id);
    assert.equal(s.document.querySelectorAll('.note-row').length,1);
    assert.equal(s.saves().length,1);
  }finally{s.cleanup();}
});

test('confirmed deletion state clears before another account initializes', () => {
  const saved=makeNote(),s=setup({notes:[saved]});
  try{
    s.click('[data-action=delete]');s.click('[data-action=confirm-delete]');
    const pending=s.latestSave(saved.id);
    s.send('saved',{id:saved.id,sequence:pending.sequence,note:null,revision:2});
    s.send('clear');
    s.send('initialize',{...s.bootstrap,hotelId:uuid(91),userId:colleague.id,notes:[],order:[]});
    const otherNote=makeNote({id:saved.id,authorId:colleague.id,title:'Another property note',revision:1});
    s.send('remote',{notes:[otherNote]});
    assert.equal(s.find('.note-row').dataset.row,otherNote.id);
    assert.equal(s.find('.note-item strong').textContent,otherNote.title);
    assert.equal(s.document.querySelectorAll('.note-row').length,1);
  }finally{s.cleanup();}
});

test('tag picker and individual recipients use the same available accounts', () => {
  const excludedEmails = ['assmgr@test.com', 'chief@test.com', 'frontmgr@test.com', 'gm@test.com', 'gpt@test.com', 'frontdesk@test.com'];
  const excluded = excludedEmails.map((email, i) => ({...colleague, id: uuid(100 + i), name: `Excluded ${i}`, email: ` ${email.toUpperCase()} `}));
  for (const [i, flag] of [{active: false}, {is_active: false}, {isActive: false}, {deactivated: true}, {deactivated_at: '2026-11-01'}, {deactivatedAt: '2026-11-01'}, {status: 'disabled'}, {status: 'inactive'}, {status: 'deactivated'}, {taggable: false}].entries()) {
    excluded.push({...colleague, id: uuid(200 + i), name: `Inactive ${i}`, ...flag});
  }
  excluded.push({...colleague,id:uuid(400),name:'Hidden Duplicate',recipientSelectable:false});
  const s = setup({people: [user, colleague, ...excluded]});
  try {
    s.click('[data-action=new]');
    assert.deepEqual(Array.from(s.document.querySelectorAll('[data-recipient=person]'), el => el.value), [user.id, colleague.id]);
    s.click('[data-action=cancel-recipients]');
    for (const account of excluded) {
      s.typeMention('@' + account.name);
      assert.equal(s.document.querySelector('.mention-option'), null, account.name);
    }
    s.typeMention('@Morgan');
    assert.equal(s.find('.mention-option strong').textContent, 'Morgan Technician');
    s.click('.mention-option');
    assert.equal(s.find('.mention').dataset.mentionId, colleague.id);
    assert.equal(s.find('.mention').textContent, 'Morgan Technician');
    assert.match(s.latestSave().document.content, /data-mention-id="00000000-0000-4000-8000-000000000002"/);
  } finally {s.cleanup();}
});

test('the dock invokes the native file picker, verifies upload through the host, and persists no signed URL', async () => {
  const s = setup();
  try {
    const dockButtons = [...s.find('.general-notes-dock').querySelectorAll('button')];
    assert.deepEqual(dockButtons.slice(2), ['[data-mode=eraser]','[data-action=undo]','[data-action=redo]','[data-notepad-gif-trigger]','[data-notepad-camera-trigger]','[data-notepad-attachments-trigger]'].map(selector => s.find(selector)));
    const fileInput = s.find('[data-notepad-attachment-input]'); let picked = 0;
    fileInput.click = () => {picked++;};
    s.click('[data-notepad-attachments-trigger]');
    assert.equal(s.document.querySelector('.attachment-choices'), null);
    assert.equal(picked, 1);
    const file = new s.window.File(['actual image bytes'], 'pump.png', {type: 'image/png'});
    Object.defineProperty(fileInput, 'files', {value: [file], configurable: true}); s.event(fileInput, 'change');
    const request = s.outgoing.find(({data}) => data.type === 'request' && data.action === 'upload');
    assert.ok(request); assert.equal(request.raw.payload.file, file); assert.equal(request.data.payload.noteId, uuid(10));
    assert.equal(s.document.querySelector('.attachment-chip'), null);
    s.send('result', {requestId: request.data.requestId, result: {id: request.data.payload.id, kind: 'file', name: 'pump.png', type: 'image/png', size: file.size, url: 'https://storage.example/signed-private-file'}});
    await tick();
    assert.equal(s.find('.attachment-open').getAttribute('aria-label'), 'Open pump.png');
    assert.equal(s.find('.attachment-open img').getAttribute('src'), 'https://storage.example/signed-private-file');
    s.click('.attachment-open img');
    const open = s.outgoing.find(({data}) => data.type === 'request' && data.action === 'attachment');
    assert.equal(open.data.payload.noteId, uuid(10));
    assert.equal(open.data.payload.id, request.data.payload.id);
    const attachment = s.latestSave().document.attachments[0];
    assert.equal(attachment.id, request.data.payload.id); assert.equal(attachment.name, 'pump.png');
    assert.equal(attachment.url, undefined); assert.equal(attachment.preview, undefined);
  } finally {s.cleanup();}
});

test('a remote refresh cannot detach the native file picker while the user is choosing an attachment', () => {
  const s = setup();
  try {
    const fileInput = s.find('[data-notepad-attachment-input]'); fileInput.click = () => {};
    s.click('[data-notepad-attachments-trigger]');
    s.send('remote', {notes: [{...s.bootstrap.notes[0], title: 'Updated elsewhere', revision: 2}]});
    assert.equal(fileInput.isConnected, true);
    assert.equal(s.find('[data-notepad-attachment-input]'), fileInput);
    assert.equal(s.find('#note-title').value, 'Maintenance planning');
  } finally {s.cleanup();}
});

for (const field of ['title', 'body']) test(`save acknowledgement and remote update preserve the focused ${field} until blur`, async () => {
  const s = setup();
  try {
    const target = s.focus(field === 'title' ? '#note-title' : '.note-content');
    if (field === 'title') {
      const priority=s.find('#note-priority');priority.value='High';s.event(priority,'change');
      s.input('#note-title','Local edited title');
    }
    else {target.firstElementChild.textContent = 'Local edited body'; s.event(target, 'input');}
    const sent = s.latestSave(), canonical = {...s.bootstrap.notes[0], ...sent.document, revision: 2};
    s.send('saved', {id: canonical.id, sequence: sent.sequence, revision: 2, note: canonical});
    assert.equal(s.find(field === 'title' ? '#note-title' : '.note-content'), target);
    assert.equal(s.document.activeElement, target);
    const incoming = {...canonical, title: 'Remote latest title', content: `<p data-item-id="${uuid(20)}">Remote latest body</p>`, revision: 3};
    s.send('remote', {notes: [incoming]});
    assert.equal(s.find(field === 'title' ? '#note-title' : '.note-content'), target);
    assert.equal(field === 'title' ? target.value : target.textContent, field === 'title' ? 'Local edited title' : 'Local edited body');
    if(field==='title'){
      s.find('.note-content').tabIndex=0;
      titleKey(s,'Escape');
      assert.equal(target.value,s.bootstrap.notes[0].title);
      assert.equal(s.saves().length,1,'The canceled edit stays outside the save queue');
    }
    s.focus('.search-box input'); await settleFocus(s);
    assert.equal(s.find('#note-title').value, 'Remote latest title');
    assert.equal(s.find('.note-content').textContent, 'Remote latest body');
  } finally {s.cleanup();}
});

test('the first attachment click after a title-font save keeps its dock controller through focusout', async () => {
  const s = setup();
  try {
    const title = s.focus('#note-title');
    const font = s.find('[data-format-select=font]');
    s.event(font, 'pointerdown'); font.focus(); font.value = 'Georgia'; s.event(font, 'change');
    assert.equal(s.document.activeElement, title);
    titleKey(s,'Enter');s.focus('#note-title');
    const sent = s.latestSave(), canonical = {...s.bootstrap.notes[0], ...sent.document, revision: 2};
    s.send('saved', {id: canonical.id, sequence: sent.sequence, revision: 2, note: canonical});
    const trigger = s.find('[data-notepad-attachments-trigger]'), fileInput = s.find('[data-notepad-attachment-input]');
    let picked = 0; fileInput.click = () => {picked++;};
    s.event(trigger, 'pointerdown'); title.blur();
    assert.equal(s.document.activeElement, s.document.body);
    // Native blur may drain microtasks before the dock receives focus. A refresh
    // in this gap would remove the pending click target and its controller.
    await Promise.resolve();
    assert.equal(trigger.isConnected, true);
    assert.equal(s.find('[data-notepad-attachments-trigger]'), trigger);
    assert.equal(s.find('[data-notepad-attachment-input]'), fileInput, 'The original attachment controller remains attached');
    trigger.focus();
    trigger.click();
    await settleFocus(s);
    assert.equal(picked, 1);
  } finally {s.cleanup();}
});

test('deferred remote messages keep the newest revision while a title is focused', async () => {
  const s = setup();
  try {
    s.focus('#note-title');
    const original = s.bootstrap.notes[0];
    s.send('remote', {notes: [{...original, title: 'Newest revision', revision: 3}]});
    s.send('remote', {notes: [{...original, title: 'Older delayed revision', revision: 2}]});
    s.focus('.search-box input'); await settleFocus(s);
    assert.equal(s.find('#note-title').value, 'Newest revision');
  } finally {s.cleanup();}
});

test('editing a note with a deferred remote update sends the revision actually displayed as its write base', () => {
  const s = setup();
  try {
    s.focus('#note-title');
    s.send('remote', {notes: [{...s.bootstrap.notes[0], title: 'Remote title not displayed yet', revision: 3}]});
    assert.equal(s.find('#note-title').value, 'Maintenance planning');
    s.input('#note-title', 'Local edit of the original title');
    assert.equal(s.saves().length, 0);
    titleKey(s,'Enter');
    const saved = s.latestSave();
    assert.equal(saved.baseRevision, 1, 'A deferred update must not silently authorize overwriting the unseen server version');
    assert.equal(saved.document.title, 'Local edit of the original title');
  } finally {s.cleanup();}
});

test('removing a shared item removes its full reply tree from the rendered and saved note', () => {
  const itemId = uuid(20);
  const replies = [{id: uuid(40), authorId: colleague.id, at: '2026-11-23T20:42:00.000Z', text: 'Parent reply', replies: [{id: uuid(41), authorId: user.id, at: '2026-11-23T20:43:00.000Z', text: 'Nested reply', replies: []}]}];
  const s = setup({notes: [makeNote({audience: {all: true, roles: [], people: []}, itemThreads: {[itemId]: replies}})]});
  try {
    s.click(`[data-item-reply="${itemId}"]`);
    assert.equal(s.document.querySelectorAll('.item-reply').length, 2);
    const editor = s.find('.note-content');
    s.find(`[data-item-id="${itemId}"]`).remove(); s.event(editor, 'input');
    assert.equal(s.document.querySelector('.item-thread'), null);
    assert.deepEqual(s.latestSave().document.itemThreads, {});
    assert.ok(!s.latestSave().document.content.includes('Parent reply'));
    assert.ok(!s.latestSave().document.content.includes('Nested reply'));
  } finally {s.cleanup();}
});

test('imported creator and reply attribution uses the stored name after an account leaves the directory', () => {
  const itemId = uuid(20), replyId = uuid(40);
  const s = setup({notes: [makeNote({authorId: uuid(300), authorName: 'Previous Chief', audience: {all: true, roles: [], people: []}, itemThreads: {[itemId]: [{id: replyId, authorId: uuid(301), authorName: 'Previous Technician', at: '2026-11-23T20:42:00.000Z', text: 'Imported reply', replies: []}]}})]});
  try {
    assert.equal(s.find('.note-creator').textContent, 'Previous Chief');
    s.click(`[data-item-reply="${itemId}"]`);
    assert.equal(s.find('.reply-meta strong').textContent, 'Previous Technician');
    s.click(`[data-parent-reply="${replyId}"]`);
    assert.ok(s.find('.reply-target').textContent.includes('Previous Technician'));
  } finally {s.cleanup();}
});

test('account clear removes open sharing dialogs and all prior-account content', () => {
  const s = setup();
  try {
    s.click('[data-action=share]'); assert.ok(s.find('.recipient-dialog').textContent.includes(colleague.name));
    s.send('clear');
    assert.equal(s.document.querySelector('.recipient-dialog'), null);
    assert.equal(s.document.querySelector('.note-content'), null);
    assert.equal(s.document.querySelector('input[type=file]'), null);
    assert.ok(!s.document.body.textContent.includes(colleague.name));
    assert.match(s.find('#layout-body').textContent, /Sign in/);
  } finally {s.cleanup();}
});

test('account clear removes open mention and popover content before another account initializes', () => {
  const s = setup();
  try {
    s.typeMention('@Morgan'); assert.ok(s.find('.mention-option'));
    s.send('clear');
    assert.equal(s.find('#mention-layer').textContent, '');
    assert.equal(s.find('#popover-layer').textContent, '');
    s.send('initialize', {...s.bootstrap, userId: uuid(302), people: [{...user, id: uuid(302), name: 'New account'}], notes: [], order: []});
    assert.equal(s.document.querySelector('.note-row'), null);
    s.click('[data-action=new]');
    assert.deepEqual(Array.from(s.document.querySelectorAll('[data-recipient=person]'), el => el.value), [uuid(302)]);
  } finally {s.cleanup();}
});

test('a confirmed body tag shows the newly shared recipient and reply controls before the next save', () => {
  const s=setup();
  try{
    s.typeMention('@Morgan');
    assert.equal(s.find('.audience-meta').textContent,'Just me');
    s.click('.mention-option');
    const saved=s.latestSave();
    assert.match(saved.document.content,/data-mention-kind="person"/);
    assert.deepEqual(saved.document.audience.people,[]);
    const note={...s.bootstrap.notes[0],...saved.document,revision:2,audience:{all:false,roles:[],people:[colleague.id]}};
    s.send('saved',{id:note.id,sequence:saved.sequence,revision:2,note,taggedPeople:[colleague.id]});
    assert.equal(s.find('.audience-meta').textContent,'Morgan');
    assert.ok(s.find('.item-reply-button'));
    s.click('[data-action=share]');
    assert.equal(s.find('[data-recipient=person][value="'+colleague.id+'"]').checked,true);
  }finally{s.cleanup();}
});

test('a confirmed self-tag stays checked alongside All Roles and can be unchecked independently',()=>{
  const all={all:true,roles:[],people:[]};
  const s=setup({notes:[makeNote({audience:all})]});
  try{
    s.typeMention('@'+user.name);
    s.click('.mention-option');
    const saved=s.latestSave();
    assert.deepEqual(saved.document.audience,all);
    const audience={...all,people:[user.id]};
    const note={...s.bootstrap.notes[0],...saved.document,revision:2,audience};
    s.send('saved',{id:note.id,sequence:saved.sequence,revision:2,note,taggedPeople:[user.id]});
    assert.equal(s.find('.audience-meta').textContent,user.short+', All Roles');
    s.click('[data-action=share]');
    const person=s.find('[data-recipient=person][value="'+user.id+'"]');
    assert.equal(person.checked,true);
    assert.equal(s.find('[data-recipient=all]').checked,true);
    person.click();
    assert.equal(s.find('[data-recipient=all]').checked,true);
    s.event(s.find('#recipient-form'),'submit');
    assert.deepEqual(s.latestSave().document.audience,all);
  }finally{s.cleanup();}
});

test('a nested reply preserves selected tag ranges through typing and leaves literal @text untagged', () => {
  const person={...colleague,id:uuid(408),name:'Taylor Quinn',short:'Taylor'};
  const parent={id:'parent',authorId:colleague.id,at:'2026-11-23T20:31:00.000Z',text:'Please check the unit',replies:[]};
  const initial=makeNote({authorId:colleague.id,audience:{all:false,roles:['engineer'],people:[]},itemThreads:{[uuid(20)]:[parent]}});
  const s=setup({notes:[initial],people:[user,colleague,person]});
  try{
    s.click('.item-reply-button');
    s.click('.reply-nested');
    const input=s.find('.reply-input');
    input.value='   @Taylor';
    input.setSelectionRange(input.value.length,input.value.length);s.event(input,'input');
    s.click('.mention-option');
    assert.equal(input.value,'   Taylor Quinn ');
    input.value+='and plain @Taylor Quinn';
    input.setSelectionRange(input.value.length,input.value.length);s.event(input,'input');
    input.value='  For '+input.value;
    input.setSelectionRange(6,6);s.event(input,'input');
    s.event(s.find('.item-reply-form'),'submit');
    const reply=s.latestSave().document.itemThreads[uuid(20)][0].replies[0];
    assert.equal(reply.text,'For    @Taylor Quinn and plain @Taylor Quinn');
    assert.deepEqual(reply.mentions,[{id:person.id,kind:'person',start:7,end:20}]);
    assert.equal(s.find('.reply-children .mention').textContent,'Taylor Quinn');
    assert.equal(s.find('.reply-children .reply-text').textContent,'For    Taylor Quinn and plain @Taylor Quinn');
    assert.equal(s.document.querySelectorAll('.reply-children .mention').length,1);
  }finally{s.cleanup();}
});

test('sidebar reorder persists without exposing drag placeholders', () => {
  const s = setup({notes: [makeNote(), makeNote({id: uuid(11), title: 'Second note'})], order: [uuid(10), uuid(11)]});
  try {
    const second = s.find(`[data-note="${uuid(11)}"]`);
    second.dispatchEvent(new s.window.KeyboardEvent('keydown', {key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true}));
    const order = s.outgoing.filter(({data}) => data.type === 'order').at(-1);
    assert.deepEqual(order.data.payload.order, [uuid(11), uuid(10)]);
    assert.equal(s.find('.note-row').dataset.row, uuid(11));
    assert.equal(s.document.querySelector('.drag-handle,.drag-placeholder,[data-drag-handle]'), null);
  } finally {s.cleanup();}
});
