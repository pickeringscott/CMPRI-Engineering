(function(){
'use strict';
// CSS caret-animation preserves the native caret where supported. The fallback
// paints outside the editor, so measurements never enter saved note content or
// disturb its Selection, undo history, spellcheck, handwriting, or IME text.
const root=document.documentElement;
const nativeCaret=Boolean(window.CSS?.supports?.('caret-animation','manual'));
const motion=window.matchMedia?.('(prefers-reduced-motion: reduce)');
const blinkStep=500,urgentPhaseSteps=3,epoch=performance.now();
let blinkTimer=0,frame=0,disposed=false,composing=false,observed=null;
root.dataset.notepadCaret=nativeCaret?'native':'overlay';

function clock(){
  clearTimeout(blinkTimer);
  const elapsed=performance.now()-epoch;
  const step=Math.floor(elapsed/blinkStep);
  const visible=motion?.matches||step%2===0;
  const urgentVisible=motion?.matches||step%(urgentPhaseSteps*2)<urgentPhaseSteps;
  root.style.setProperty('--notepad-blink-opacity',visible?'1':'0');
  root.style.setProperty('--notepad-urgent-opacity',urgentVisible?'1':'0');
  root.dataset.notepadBlinkOn=visible?'true':'false';
  if(!disposed&&!motion?.matches&&!document.hidden){
    blinkTimer=setTimeout(clock,Math.max(1,blinkStep-elapsed%blinkStep));
  }
}

const overlay=nativeCaret?null:document.createElement('span');
const mirror=nativeCaret?null:document.createElement('div');
if(overlay){
  overlay.className='notepad-caret-overlay';overlay.hidden=true;overlay.setAttribute('aria-hidden','true');
  mirror.className='notepad-caret-mirror';mirror.setAttribute('aria-hidden','true');
  document.body.append(overlay,mirror);
}
const fieldSelector='#note-title,.note-content,.task-label,.reply-input';
const number=value=>parseFloat(value)||0;
const textFields=new Set(['text','search','email','url','tel','password']);
function textControl(el){return el?.tagName==='TEXTAREA'||(el?.tagName==='INPUT'&&textFields.has(el.type));}
function editingField(){
  if(document.hidden||!document.hasFocus()||composing)return null;
  const active=document.activeElement;
  if(textControl(active))return active.matches(fieldSelector)&&!active.disabled&&!active.readOnly?active:null;
  const selection=window.getSelection();
  if(!selection?.rangeCount||!selection.isCollapsed)return null;
  const anchor=selection.focusNode?.nodeType===Node.ELEMENT_NODE?selection.focusNode:selection.focusNode?.parentElement;
  const field=anchor?.closest('[contenteditable="true"]');
  if(!field?.matches(fieldSelector)||!(active===field||active?.contains(field)))return null;
  return field;
}
function usableRect(rect){return rect&&Number.isFinite(rect.left)&&Number.isFinite(rect.top)&&rect.height>0;}
function rangeRect(range){
  const rects=range.getClientRects?.();
  if(rects)for(const rect of rects)if(usableRect(rect))return rect;
  const rect=range.getBoundingClientRect?.();
  return usableRect(rect)?rect:null;
}
const mirrorProperties=['boxSizing','paddingTop','paddingRight','paddingBottom','paddingLeft','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','borderTopStyle','borderRightStyle','borderBottomStyle','borderLeftStyle','fontFamily','fontSize','fontWeight','fontStyle','fontVariant','fontStretch','lineHeight','letterSpacing','wordSpacing','textAlign','textIndent','textTransform','direction','tabSize','overflowWrap','wordBreak'];
function controlRect(field){
  if(field.selectionStart===null||field.selectionStart!==field.selectionEnd)return null;
  const style=getComputedStyle(field),box=field.getBoundingClientRect();
  if(!usableRect(box))return null;
  for(const property of mirrorProperties)mirror.style[property]=style[property];
  mirror.style.boxSizing='border-box';
  mirror.style.width=(field.clientWidth+number(style.borderLeftWidth)+number(style.borderRightWidth)||box.width)+'px';
  mirror.style.whiteSpace=field.tagName==='TEXTAREA'?'pre-wrap':'pre';
  const marker=document.createElement('span'),position=field.selectionStart;
  marker.textContent=field.value.slice(position)||'\u200b';
  mirror.replaceChildren(document.createTextNode(field.value.slice(0,position)),marker);
  const range=document.createRange();range.setStart(marker.firstChild,0);range.collapse(true);
  const caret=rangeRect(range)||Array.from(marker.getClientRects()).find(usableRect);
  if(!caret)return null;
  const mirrorBox=mirror.getBoundingClientRect();
  return {left:box.left+caret.left-mirrorBox.left-field.scrollLeft,top:box.top+caret.top-mirrorBox.top-field.scrollTop,height:caret.height};
}
function editableRect(field){
  const selection=window.getSelection();
  if(!selection?.rangeCount||!selection.isCollapsed)return null;
  const range=selection.getRangeAt(0);
  if(!field.contains(range.startContainer))return null;
  const direct=rangeRect(range);
  if(direct)return {left:direct.left,top:direct.top,height:direct.height};
  // Empty text blocks and selection boundaries beside an uneditable mention may
  // not yield a collapsed rectangle. Read a neighboring glyph without inserting
  // markers into the document or moving the user's actual selection.
  const container=range.startContainer,offset=range.startOffset;
  if(container.nodeType===Node.TEXT_NODE&&container.length){
    const adjacent=range.cloneRange(),after=offset<container.length;
    adjacent.setStart(container,after?offset:offset-1);adjacent.setEnd(container,after?offset+1:offset);
    const rect=rangeRect(adjacent),rtl=getComputedStyle(container.parentElement).direction==='rtl';
    if(rect)return {left:after!==rtl?rect.left:rect.right,top:rect.top,height:rect.height};
  }
  const element=container.nodeType===Node.ELEMENT_NODE?container:container.parentElement;
  if(!element)return null;
  const child=element.childNodes[offset],previous=element.childNodes[offset-1];
  const neighbor=child?.nodeType===Node.ELEMENT_NODE?child:previous?.nodeType===Node.ELEMENT_NODE?previous:null;
  const target=neighbor||element,style=getComputedStyle(target),rect=target.getBoundingClientRect();
  if(!usableRect(rect))return null;
  const fontSize=number(style.fontSize)||16,lineHeight=number(style.lineHeight)||fontSize*1.2;
  const left=rect.left+number(style.borderLeftWidth)+number(style.paddingLeft);
  const right=rect.right-number(style.borderRightWidth)-number(style.paddingRight);
  const align=style.textAlign,rtl=style.direction==='rtl';
  const x=align==='center'?(left+right)/2:align==='right'||(rtl&&align!=='left')?right:left;
  return {left:x,top:rect.top+number(style.borderTopWidth)+number(style.paddingTop),height:lineHeight};
}
function clippedRect(field,caret){
  let left=0,top=0,right=innerWidth,bottom=innerHeight;
  for(let element=field;element&&element!==document.body;element=element.parentElement){
    const style=getComputedStyle(element),box=element.getBoundingClientRect();
    const clipX=element===field&&textControl(field)||/(auto|scroll|hidden|clip)/.test(style.overflowX||style.overflow);
    const clipY=element===field&&textControl(field)||/(auto|scroll|hidden|clip)/.test(style.overflowY||style.overflow);
    if(clipX){left=Math.max(left,box.left+number(style.borderLeftWidth));right=Math.min(right,box.right-number(style.borderRightWidth));}
    if(clipY){top=Math.max(top,box.top+number(style.borderTopWidth));bottom=Math.min(bottom,box.bottom-number(style.borderBottomWidth));}
  }
  if(caret.left<left-1||caret.left>right+1||caret.top+caret.height<=top||caret.top>=bottom)return null;
  const y=Math.max(caret.top,top);
  return {left:Math.max(left,Math.min(caret.left,right-1)),top:y,height:Math.min(caret.top+caret.height,bottom)-y};
}
function hide(){
  if(overlay)overlay.hidden=true;
  if(mirror?.firstChild)mirror.replaceChildren();
  delete root.dataset.notepadCaretOverlay;
}
function refresh(){
  frame=0;if(disposed||!overlay)return;
  const field=editingField();
  if(field!==observed){resizeObserver?.disconnect();observed=field;if(field)resizeObserver?.observe(field);}
  if(!field){hide();return;}
  delete root.dataset.notepadCaretOverlay;
  const fieldStyle=getComputedStyle(field),caretColor=fieldStyle.caretColor;
  const caret=textControl(field)?controlRect(field):editableRect(field);
  const rect=caret&&clippedRect(field,caret);
  if(!rect){hide();return;}
  overlay.style.left=rect.left+'px';overlay.style.top=rect.top+'px';overlay.style.height=rect.height+'px';
  overlay.style.color=caretColor&&caretColor!=='auto'?caretColor:fieldStyle.color;
  overlay.hidden=false;root.dataset.notepadCaretOverlay='true';
}
function schedule(){if(!disposed&&overlay&&!frame)frame=requestAnimationFrame(refresh);}
function compositionStart(){composing=true;hide();}
function compositionEnd(){composing=false;schedule();}
function visibilityChanged(){clock();schedule();}
function pageHide(event){if(event.persisted){clearTimeout(blinkTimer);hide();}else destroy();}
function pageShow(){if(!disposed){clock();schedule();}}
const resizeObserver=overlay&&typeof ResizeObserver==='function'?new ResizeObserver(schedule):null;
const observer=overlay&&typeof MutationObserver==='function'?new MutationObserver(schedule):null;
observer?.observe(document.getElementById('layout-body')||document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','style','contenteditable']});
const events=['focusin','focusout','input','select','selectionchange','keyup','pointerup','scroll'];
if(overlay){
  for(const event of events)document.addEventListener(event,schedule,true);
  document.addEventListener('compositionstart',compositionStart,true);document.addEventListener('compositionend',compositionEnd,true);
  window.addEventListener('resize',schedule);window.addEventListener('blur',hide);window.addEventListener('focus',schedule);
  window.visualViewport?.addEventListener('resize',schedule);window.visualViewport?.addEventListener('scroll',schedule);
}
document.addEventListener('visibilitychange',visibilityChanged);
motion?.addEventListener?.('change',clock);
function destroy(){
  if(disposed)return;disposed=true;clearTimeout(blinkTimer);cancelAnimationFrame(frame);observer?.disconnect();resizeObserver?.disconnect();
  for(const event of events)document.removeEventListener(event,schedule,true);
  document.removeEventListener('compositionstart',compositionStart,true);document.removeEventListener('compositionend',compositionEnd,true);
  document.removeEventListener('visibilitychange',visibilityChanged);motion?.removeEventListener?.('change',clock);
  window.removeEventListener('resize',schedule);window.removeEventListener('blur',hide);window.removeEventListener('focus',schedule);
  window.visualViewport?.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('scroll',schedule);
  window.removeEventListener('pagehide',pageHide);window.removeEventListener('pageshow',pageShow);overlay?.remove();mirror?.remove();
  delete root.dataset.notepadCaret;delete root.dataset.notepadCaretOverlay;delete root.dataset.notepadBlinkOn;
  root.style.removeProperty('--notepad-blink-opacity');
  root.style.removeProperty('--notepad-urgent-opacity');
}
window.addEventListener('pagehide',pageHide);window.addEventListener('pageshow',pageShow);
window.NotepadCaret={destroy};
clock();schedule();
})();
