import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const source=readFileSync(new URL('../public/notepad/formatting.js',import.meta.url),'utf8');
const palette=[['Black','#000000'],['Red','#ff0000'],['Green','#008000'],['Blue','#0000ff'],['Orange','#ffa500'],['Yellow','#ffff00'],['Purple','#800080'],['White','#ffffff']];
function setup(content='<p data-item-id="line">Color this text</p>') {
  const dom=new JSDOM('<textarea id="title">Project title</textarea><div id="toolbar"></div><div class="note-content" contenteditable="true" tabindex="0" style="color:#ffffff;font-size:16px">'+content+'</div><button id="outside">Other control</button>',{url:'https://cmpri.example',runScripts:'outside-only',pretendToBeVisual:true});
  const {window}=dom,{document}=window,changes=[];
  document.queryCommandState=()=>false;
  window.eval(source);
  document.querySelector('#toolbar').innerHTML=window.NotepadFormatting.html();
  const editor=document.querySelector('.note-content'),toolbar=document.querySelector('.notepad-formatting'),titleInput=document.querySelector('#title');
  const controller=window.NotepadFormatting.attach({editor,toolbar,titleInput,getNote:()=>({fontFamily:'Arial',titleFontFamily:'Arial'}),onChange:()=>changes.push(editor.innerHTML)});
  const find=selector=>{const element=document.querySelector(selector);assert.ok(element,selector);return element;};
  const event=(element,type)=>element.dispatchEvent(new window.Event(type,{bubbles:true,cancelable:true}));
  const click=selector=>{const element=find(selector);event(element,'pointerdown');element.click();};
  const key=(key,options={})=>document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options}));
  const select=(node,start,end=start)=>{(node.parentElement?.closest('.task-label')||editor).focus();const range=document.createRange();range.setStart(node,start);range.setEnd(node,end);window.getSelection().removeAllRanges();window.getSelection().addRange(range);event(document,'selectionchange');};
  return {window,document,editor,toolbar,titleInput,controller,changes,find,event,click,key,select,close(){controller.destroy();window.close();}};
}

test('Font Color opens one horizontal dot-only palette outside the unchanged toolbar order',()=>{
  const s=setup();
  try{
    const labels=Array.from(s.toolbar.querySelectorAll('button,select'),node=>node.getAttribute('aria-label'));
    assert.deepEqual(labels,['Font','Font Size','Bold','Italic','Underline','Font Color','Align Left','Center','Align Right','Justify','Checklist','Bullets','Numbers','Letters','Decrease Indent','Increase Indent']);
    assert.equal(s.document.querySelector('[data-format-select=color]'),null);
    s.click('[data-format-color-trigger]');
    const popup=s.find('.notepad-color-popover');
    assert.equal(s.toolbar.contains(popup),false);
    assert.equal(popup.getAttribute('aria-orientation'),'horizontal');
    assert.equal(s.controller.isInteracting(),true);
    assert.equal(s.find('[data-format-color-trigger]').getAttribute('aria-controls'),popup.id);
    assert.deepEqual(Array.from(popup.querySelectorAll('[role=option]'),node=>[node.getAttribute('aria-label'),node.dataset.formatColor]),palette);
    for(const button of popup.querySelectorAll('button')){
      assert.equal(button.textContent,'','Only the colored dot is visible');
      assert.equal(button.querySelectorAll('.fmt-color-dot').length,1);
    }
    assert.equal(s.toolbar.querySelectorAll('button,select').length,16);
    assert.equal(s.changes.length,0);
  }finally{s.close();}
});

test('choosing a dot preserves the selected body text, applies its color, and restores editing focus',()=>{
  const s=setup();
  try{
    s.select(s.editor.firstElementChild.firstChild,6,10);
    s.click('[data-format-color-trigger]');
    s.event(s.document,'selectionchange');
    s.click('[data-format-color="#ff0000"]');
    const colored=s.editor.querySelector('span[style]');
    assert.equal(colored.textContent,'this');assert.equal(colored.style.color,'rgb(255, 0, 0)');
    assert.equal(s.editor.textContent,'Color this text');
    assert.equal(s.window.getSelection().toString(),'this');
    assert.equal(s.document.activeElement,s.editor);
    assert.equal(s.changes.length,1);
    assert.equal(s.controller.isInteracting(),false);
    assert.equal(s.document.querySelector('.notepad-color-popover'),null);
  }finally{s.close();}
});

test('a dot selected at the caret sets the color for subsequent typing without coloring previous text',()=>{
  const s=setup();
  try{
    s.select(s.editor.firstElementChild.firstChild,15);
    s.click('[data-format-color-trigger]');s.click('[data-format-color="#008000"]');
    const carrier=s.find('[data-format-caret]');
    assert.equal(carrier.style.color,'rgb(0, 128, 0)');
    assert.equal(s.editor.firstElementChild.firstChild.textContent,'Color this text');
    assert.equal(s.window.getSelection().anchorNode,carrier.firstChild);
    carrier.firstChild.textContent+=' new';
    s.select(carrier.firstChild,carrier.firstChild.length);s.event(s.editor,'input');
    assert.equal(carrier.textContent,' new');
    assert.equal(carrier.style.color,'rgb(0, 128, 0)');
    assert.equal(s.editor.textContent,'Color this text new');
  }finally{s.close();}
});

test('horizontal keyboard navigation, Escape, outside click, and Tab dismiss without altering the document',()=>{
  const s=setup();
  try{
    s.select(s.editor.firstElementChild.firstChild,3);
    const before=s.editor.innerHTML,trigger=s.find('[data-format-color-trigger]');
    trigger.focus();s.key('ArrowDown');
    assert.equal(s.document.activeElement.getAttribute('aria-label'),'White');
    s.key('ArrowRight');assert.equal(s.document.activeElement.getAttribute('aria-label'),'Black');
    s.key('End');assert.equal(s.document.activeElement.getAttribute('aria-label'),'White');
    s.key('Home');assert.equal(s.document.activeElement.getAttribute('aria-label'),'Black');
    s.key('Escape');assert.equal(s.document.activeElement,trigger);assert.equal(s.controller.isInteracting(),false);
    s.click('[data-format-color-trigger]');s.key('Tab');
    assert.equal(s.document.activeElement.getAttribute('aria-label'),'Align Left');
    assert.equal(s.controller.isInteracting(),false);
    s.click('[data-format-color-trigger]');s.key('Tab',{shiftKey:true});
    assert.equal(s.document.activeElement.getAttribute('aria-label'),'Underline');
    s.click('[data-format-color-trigger]');s.click('#outside');
    assert.equal(s.document.querySelector('.notepad-color-popover'),null);
    assert.equal(s.editor.innerHTML,before);assert.equal(s.changes.length,0);
  }finally{s.close();}
});

test('keyboard dot selection works on checklist text and avoids title or reply selection leaks',()=>{
  const s=setup('<div class="note-check" contenteditable="false"><input type="checkbox"><span class="task-label" contenteditable="true" tabindex="0">Task label</span></div><div class="item-thread" contenteditable="false"><textarea class="reply-input">Reply text</textarea></div>');
  try{
    const task=s.find('.task-label');s.select(task.firstChild,0,4);task.focus();s.event(s.document,'selectionchange');
    s.click('[data-format-color-trigger]');s.key('Home');s.key('ArrowRight');s.key('Enter');
    assert.equal(task.querySelector('span').textContent,'Task');assert.equal(task.querySelector('span').style.color,'rgb(255, 0, 0)');
    assert.equal(s.document.activeElement,task);
    const body=s.editor.innerHTML,count=s.changes.length;
    s.titleInput.focus();s.titleInput.setSelectionRange(2,7);s.event(s.titleInput,'select');
    s.click('[data-format-color-trigger]');s.click('[data-format-color="#0000ff"]');
    assert.equal(s.editor.innerHTML,body);assert.equal(s.changes.length,count);
    assert.equal(s.document.activeElement,s.titleInput);assert.equal(s.titleInput.selectionStart,2);assert.equal(s.titleInput.selectionEnd,7);
    s.find('.reply-input').focus();s.click('[data-format-color-trigger]');s.click('[data-format-color="#800080"]');
    assert.equal(s.editor.innerHTML,body);assert.equal(s.changes.length,count);
  }finally{s.close();}
});

test('destroy removes an open palette and prevents stale color actions after note switching',()=>{
  const s=setup();
  try{
    s.select(s.editor.firstElementChild.firstChild,0,5);s.click('[data-format-color-trigger]');
    const red=s.find('[data-format-color="#ff0000"]');s.controller.destroy();
    assert.equal(s.document.querySelector('.notepad-color-popover'),null);
    assert.equal(s.find('[data-format-color-trigger]').getAttribute('aria-expanded'),'false');
    red.click();assert.equal(s.changes.length,0);assert.equal(s.editor.textContent,'Color this text');
  }finally{s.close();}
});
