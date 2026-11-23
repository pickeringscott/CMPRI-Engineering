import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM, VirtualConsole} from 'jsdom';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../public/notepad/editor.html');
const css = read('../public/notepad/notepad.css');
const approved = read('../docs/previews/Notepad.html');
const modules = ['ink', 'formatting', 'attachments', 'app'].map(name => read(`../public/notepad/${name}.js`));
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

test('editing and formatting the title updates the sidebar and emitted document without changing the body font', () => {
  const s = setup();
  try {
    const title = s.focus('#note-title');
    s.input('#note-title', 'Pump repair'); title.setSelectionRange(2, 6); s.event(title, 'select');
    const font = s.find('[data-format-select=font]');
    s.event(font, 'pointerdown'); font.focus(); font.value = 'Georgia'; s.event(font, 'change');
    const saved = s.latestSave();
    assert.equal(saved.document.title, 'Pump repair');
    assert.equal(saved.document.titleFontFamily, 'Georgia');
    assert.equal(saved.document.fontFamily, 'Comic Sans MS');
    assert.match(title.style.fontFamily, /^"?Georgia"?,/);
    assert.match(s.find('.note-item strong').style.fontFamily, /^"?Georgia"?,/);
    assert.equal(s.find('.note-item strong').textContent.replace('!', ''), 'Pump repair');
    assert.equal(s.document.activeElement, title, 'Title focus is restored after choosing its font');
    assert.equal(title.selectionStart, 2); assert.equal(title.selectionEnd, 6);
    assert.ok(title.style.fontFamily.includes('Comic Sans MS'));
  } finally {s.cleanup();}
});

test('title, urgent markers, metadata and borderless actions retain the approved markup and styles', () => {
  const s = setup();
  try {
    const editor = s.find('.general-notes-editor'), details = s.find('.note-details');
    assert.ok(editor.firstElementChild.classList.contains('title-row'));
    assert.equal(editor.children[1], details);
    assert.deepEqual(Array.from(details.children, node => node.tagName), ['LABEL', 'SELECT', 'SPAN', 'TIME']);
    assert.equal(s.find('[data-action=share]').textContent, 'Shared with…');
    assert.equal(s.find('[data-action=share]').querySelectorAll('svg').length, 1);
    const priority = s.find('#note-priority'); priority.value = 'Urgent'; s.event(priority, 'change');
    assert.equal(priority.selectedOptions[0].textContent, 'Urgent!');
    assert.equal(s.find('.note-heading .note-urgent').hidden, false);
    assert.equal(s.find('.note-item .note-urgent').hidden, false);
    assert.equal(s.latestSave().document.priority, 'Urgent');
    const selectors = ['.layout-1 .priority-row.note-details', '.layout-1 .priority-row.note-details > *', '.layout-1 .priority-row.note-details #note-priority', '.layout-1 .title-actions button', '.layout-1 .note-urgent'];
    for (const selector of selectors) {
      const rule = css.split('\n').find(line => line.startsWith(selector + ' {'));
      assert.ok(rule, selector); assert.ok(approved.includes(rule), `Approved rule changed: ${selector}`);
    }
    assert.match(css, /\.priority-row\.note-details \{[^}]*grid-template-columns: repeat\(4, max-content\)[^}]*gap: 0 5px[^}]*font: 10px\/1\.4/);
    assert.match(css, /\.priority-row\.note-details > \* \{[^}]*font: inherit/);
    assert.match(css, /\.priority-row\.note-details #note-priority \{[^}]*border: 0[^}]*color: var\(--accent\)[^}]*font: inherit/);
    assert.match(css, /\.title-actions button \{[^}]*border: 0/);
    assert.match(css, /\.note-urgent \{[^}]*color: #ff3b3b/);
  } finally {s.cleanup();}
});

test('new notes default to Just me, and Engineering and All Roles serialize canonical recipients', () => {
  const s = setup();
  try {
    s.click('[data-action=new]');
    assert.equal(s.find('[data-recipient=private]').checked, true);
    assert.deepEqual(Array.from(s.document.querySelectorAll('.recipient-section h3'), el => el.textContent), ['Roles and Departments', 'Individual Names']);
    assert.equal(s.document.querySelectorAll('.recipient-dialog input:checked').length, 1);
    s.event(s.find('#recipient-form'), 'submit');
    assert.deepEqual(s.latestSave().document.audience, {all: false, roles: [], people: []});
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

test('mentions and individual recipients exclude deactivated and six test accounts', () => {
  const excludedEmails = ['assmgr@test.com', 'chief@test.com', 'frontmgr@test.com', 'gm@test.com', 'gpt@test.com', 'frontdesk@test.com'];
  const excluded = excludedEmails.map((email, i) => ({...colleague, id: uuid(100 + i), name: `Excluded ${i}`, email: ` ${email.toUpperCase()} `}));
  for (const [i, flag] of [{active: false}, {is_active: false}, {isActive: false}, {deactivated: true}, {deactivated_at: '2026-11-01'}, {deactivatedAt: '2026-11-01'}, {status: 'disabled'}, {status: 'inactive'}, {status: 'deactivated'}, {taggable: false}].entries()) {
    excluded.push({...colleague, id: uuid(200 + i), name: `Inactive ${i}`, ...flag});
  }
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
    assert.equal(s.find('.mention-option strong').textContent, '@Morgan Technician');
    s.click('.mention-option');
    assert.equal(s.find('.mention').dataset.mentionId, colleague.id);
    assert.match(s.latestSave().document.content, /data-mention-id="00000000-0000-4000-8000-000000000002"/);
  } finally {s.cleanup();}
});

test('the dock invokes the native file picker, verifies upload through the host, and persists no signed URL', async () => {
  const s = setup();
  try {
    assert.equal(s.find('[data-action=redo]').nextElementSibling, s.find('[data-notepad-attachments-trigger]'));
    const fileInput = s.find('input[type=file]'); let picked = 0;
    fileInput.click = () => {picked++;};
    s.click('[data-notepad-attachments-trigger]');
    assert.equal(s.document.querySelectorAll('.attachment-choice').length, 2);
    s.click('[data-attachment-choice=files]'); assert.equal(picked, 1);
    const file = new s.window.File(['actual image bytes'], 'pump.png', {type: 'image/png'});
    Object.defineProperty(fileInput, 'files', {value: [file], configurable: true}); s.event(fileInput, 'change');
    const request = s.outgoing.find(({data}) => data.type === 'request' && data.action === 'upload');
    assert.ok(request); assert.equal(request.raw.payload.file, file); assert.equal(request.data.payload.noteId, uuid(10));
    assert.equal(s.document.querySelector('.attachment-chip'), null);
    s.send('result', {requestId: request.data.requestId, result: {id: request.data.payload.id, kind: 'file', name: 'pump.png', type: 'image/png', size: file.size, url: 'https://storage.example/signed-private-file'}});
    await tick();
    assert.equal(s.find('.attachment-open').textContent, 'pump.png');
    const attachment = s.latestSave().document.attachments[0];
    assert.equal(attachment.id, request.data.payload.id); assert.equal(attachment.name, 'pump.png');
    assert.equal(attachment.url, undefined); assert.equal(attachment.preview, undefined);
  } finally {s.cleanup();}
});

test('a remote refresh cannot detach the native file picker while the user is choosing an attachment', () => {
  const s = setup();
  try {
    const fileInput = s.find('input[type=file]'); fileInput.click = () => {};
    s.click('[data-notepad-attachments-trigger]'); s.click('[data-attachment-choice=files]');
    s.send('remote', {notes: [{...s.bootstrap.notes[0], title: 'Updated elsewhere', revision: 2}]});
    assert.equal(fileInput.isConnected, true);
    assert.equal(s.find('input[type=file]'), fileInput);
    assert.equal(s.find('#note-title').value, 'Maintenance planning');
  } finally {s.cleanup();}
});

for (const field of ['title', 'body']) test(`save acknowledgement and remote update preserve the focused ${field} until blur`, async () => {
  const s = setup();
  try {
    const target = s.focus(field === 'title' ? '#note-title' : '.note-content');
    if (field === 'title') s.input('#note-title', 'Local edited title');
    else {target.firstElementChild.textContent = 'Local edited body'; s.event(target, 'input');}
    const sent = s.latestSave(), canonical = {...s.bootstrap.notes[0], ...sent.document, revision: 2};
    s.send('saved', {id: canonical.id, sequence: sent.sequence, revision: 2, note: canonical});
    assert.equal(s.find(field === 'title' ? '#note-title' : '.note-content'), target);
    assert.equal(s.document.activeElement, target);
    const incoming = {...canonical, title: 'Remote latest title', content: `<p data-item-id="${uuid(20)}">Remote latest body</p>`, revision: 3};
    s.send('remote', {notes: [incoming]});
    assert.equal(s.find(field === 'title' ? '#note-title' : '.note-content'), target);
    assert.equal(field === 'title' ? target.value : target.textContent, field === 'title' ? 'Local edited title' : 'Local edited body');
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
    const sent = s.latestSave(), canonical = {...s.bootstrap.notes[0], ...sent.document, revision: 2};
    s.send('saved', {id: canonical.id, sequence: sent.sequence, revision: 2, note: canonical});
    const trigger = s.find('[data-notepad-attachments-trigger]'), fileInput = s.find('input[type=file]');
    s.event(trigger, 'pointerdown'); title.blur();
    assert.equal(s.document.activeElement, s.document.body);
    // Native blur may drain microtasks before the dock receives focus. A refresh
    // in this gap would remove the pending click target and its controller.
    await Promise.resolve();
    assert.equal(trigger.isConnected, true);
    assert.equal(s.find('[data-notepad-attachments-trigger]'), trigger);
    assert.equal(s.find('input[type=file]'), fileInput, 'The original attachment controller remains attached');
    trigger.focus();
    trigger.click();
    await settleFocus(s);
    assert.equal(s.document.querySelectorAll('.attachment-choice').length, 2);
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
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
