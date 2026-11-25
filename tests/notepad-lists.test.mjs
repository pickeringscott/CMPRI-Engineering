import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {sanitizeNotepadHTML} from '../src/lib/server/notepad-document.ts';

const formatting = readFileSync(new URL('../public/notepad/formatting.js', import.meta.url), 'utf8');

function setup(content) {
  const dom = new JSDOM('<div id="toolbar"></div><div class="note-content" contenteditable="true" tabindex="0">'+content+'</div>', {
    runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const {window} = dom, {document} = window;
  document.queryCommandState = () => false;
  window.eval(formatting);
  document.querySelector('#toolbar').innerHTML = window.NotepadFormatting.html();
  const editor = document.querySelector('.note-content');
  const toolbar = document.querySelector('.notepad-formatting');
  const controller = window.NotepadFormatting.attach({editor, toolbar});
  function select(node, start = 0, end = start) {
    editor.focus();
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new window.Event('selectionchange'));
  }
  function key(key, options = {}) {
    const event = new window.KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...options});
    editor.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, key);
  }
  return {editor, document, window, controller, select, key, close() {controller.destroy(); window.close();}};
}

for (const [kind, selector] of [['bullet', 'ul>li'], ['letter', 'ol>li'], ['number', 'ol>li'], ['check', '.note-check']]) {
  test(`${kind} preserves the earlier left-aligned line when converting a right-aligned line`, () => {
    const s = setup('<div data-item-id="first" style="text-align:left"><b>First line</b><div data-item-id="second" style="text-align:right">Second line</div></div>');
    try {
      s.select(s.editor.querySelector('[data-item-id=second]').firstChild, 4);
      s.controller.run(kind);
      assert.equal(s.editor.firstElementChild.textContent, 'First line');
      assert.equal(s.editor.firstElementChild.style.textAlign, 'left');
      assert.equal(s.editor.firstElementChild.dataset.itemId, 'first');
      assert.equal(s.editor.querySelector(selector).textContent, 'Second line');
      assert.equal(s.editor.querySelector(selector).style.textAlign, 'right');
      assert.equal(s.editor.querySelector(selector).dataset.itemId, 'second');
      assert.equal(s.window.getSelection().anchorNode.textContent, 'Second line');
    } finally {s.close();}
  });

  test(`${kind} starts one step below the preceding paragraph, continues, and exits at paragraph indentation`, () => {
    const s = setup('<p data-item-id="first" data-list-level="2">Indented paragraph</p><p data-item-id="second">Second line</p>');
    try {
      s.select(s.editor.lastElementChild.firstChild, 11);
      s.controller.run(kind);
      let item = s.editor.querySelector(selector);
      assert.equal(item.dataset.listLevel, '3');
      assert.equal(item.parentElement.style.listStyleType, {bullet:'square', number:'decimal', letter:'lower-alpha', check:''}[kind]);
      s.key('Enter');
      const items = s.editor.querySelectorAll(selector);
      assert.equal(items.length, 2);
      item = items[1];
      assert.equal(item.dataset.listLevel, '3');
      s.key('Enter');
      assert.equal(s.editor.querySelectorAll(selector).length, 1);
      const paragraph = s.editor.lastElementChild;
      assert.equal(paragraph.tagName, 'P');
      assert.equal(paragraph.dataset.listLevel, '2');
      assert.ok(paragraph.querySelector('br'), 'The new empty line has a caret position');
      s.controller.run('align-center');
      assert.equal(paragraph.style.textAlign, 'center');
    } finally {s.close();}
  });

  test(`${kind} marker follows a chosen font size and persists through the document allowlist`, () => {
    const s = setup('<p data-item-id="first">Resize this item</p>');
    try {
      s.select(s.editor.firstElementChild.firstChild, 0, 16);
      s.controller.run('size', '20');
      s.controller.run(kind);
      assert.equal(s.editor.querySelector(selector).style.getPropertyValue('--np-marker-size'), '20px');
      s.controller.run('size', '36');
      assert.equal(s.editor.querySelector(selector).style.getPropertyValue('--np-marker-size'), '36px');
      assert.match(sanitizeNotepadHTML(s.editor.innerHTML), /--np-marker-size:36px/);
    } finally {s.close();}
  });
}

test('Tab uses the same indent step for a plain paragraph and a mixed list beneath a checkbox', () => {
  const s = setup('<p data-item-id="paragraph">First line</p><p data-item-id="parent">Checkbox parent</p><p data-item-id="child">Lettered child</p>');
  try {
    s.select(s.editor.firstElementChild.firstChild, 2);
    s.key('Tab');
    assert.equal(s.editor.firstElementChild.dataset.listLevel, '2');
    s.select(s.editor.querySelector('[data-item-id=parent]').firstChild, 2);
    s.controller.run('check');
    assert.equal(s.editor.querySelector('.note-check').dataset.listLevel, '3');
    s.select(s.editor.querySelector('[data-item-id=child]').firstChild, 2);
    s.controller.run('letter');
    for (let level = 2; level <= 4; level += 1) {
      s.key('Tab');
      const child = s.editor.querySelector('ol>li');
      assert.equal(child.dataset.listLevel, String(level));
      assert.equal(child.parentElement.style.listStyleType, 'lower-alpha');
    }
    assert.match(sanitizeNotepadHTML(s.editor.innerHTML), /margin-inline-start:72px/);
    s.select(s.editor.querySelector('.task-label').firstChild, 2);
    s.key('Tab', {shiftKey:true});
    assert.equal(s.editor.querySelector('.note-check').dataset.listLevel, '2');
    const child = s.editor.querySelector('ol>li');
    assert.equal(child.dataset.listLevel, '3');
    assert.equal(child.parentElement.dataset.baseLevel, '3');
  } finally {s.close();}
});

test('a bare inline line before a block survives rebuilding the document', () => {
  const s = setup('<strong>First line</strong><div data-item-id="second" style="text-align:right">Second line</div>');
  try {
    s.select(s.editor.querySelector('[data-item-id=second]').firstChild, 4);
    s.controller.run('bullet');
    assert.equal(s.editor.querySelector('p>strong').textContent, 'First line');
    assert.equal(s.editor.querySelector('li').textContent, 'Second line');
  } finally {s.close();}
});

test('markers follow formerly saved inline font sizes on reopen', () => {
  const s = setup('<ol class="np-format-list"><li><span style="font-size:36px">Large item</span></li><li>Regular item</li></ol><div class="note-check"><input type="checkbox"><span class="task-label" style="font-size:20px">Checklist item</span></div>');
  try {
    assert.equal(s.editor.querySelector('li').style.getPropertyValue('--np-marker-size'), '36px');
    assert.equal(s.editor.querySelector('li+li').style.getPropertyValue('--np-marker-size'), '');
    assert.equal(s.editor.querySelector('.note-check').style.getPropertyValue('--np-marker-size'), '20px');
  } finally {s.close();}
});

test('clearing all text resets inherited alignment and allows another alignment immediately', () => {
  const s = setup('<div data-item-id="first" style="text-align:right">First line</div>');
  try {
    const paragraph = s.editor.firstElementChild;
    s.select(paragraph.firstChild, 0, 10);
    s.editor.dispatchEvent(new s.window.InputEvent('beforeinput', {inputType:'deleteContentBackward', bubbles:true, cancelable:true}));
    paragraph.innerHTML = '<br>';
    s.select(paragraph, 0);
    s.editor.dispatchEvent(new s.window.InputEvent('input', {inputType:'deleteContentBackward', bubbles:true}));
    assert.equal(s.editor.firstElementChild.style.textAlign, '');
    s.controller.run('align-center');
    assert.equal(s.editor.firstElementChild.style.textAlign, 'center');
    assert.equal(s.window.getSelection().anchorNode, s.editor.firstElementChild);
  } finally {s.close();}
});
