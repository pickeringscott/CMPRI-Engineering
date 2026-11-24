(function (global) {
  'use strict';
  const ANNOTATION = '.item-reply-actions,.item-thread,.task-completion,.task-stamp';
  const BLOCK = 'p,div,h1,h2,h3,h4,h5,h6,blockquote,li,.note-check';
  const FONT_DEFAULT = 'Comic Sans MS';
  const FONTS = ['Comic Sans MS','Arial','Calibri','Cambria','Georgia','Helvetica','Tahoma','Times New Roman','Trebuchet MS','Verdana','Courier New'];
  const SIZES = [8,9,10,11,12,14,16,18,20,22,24,28,32,36,48,60,72];
  const COLORS = [['Black','#000000'],['Red','#ff0000'],['Green','#008000'],['Blue','#0000ff'],['Orange','#ffa500'],['Yellow','#ffff00'],['Purple','#800080'],['White','#ffffff']];
  const STYLES = [['p','Normal text'],['h1','Title'],['h2','Heading 1'],['h3','Heading 2'],['h4','Heading 3']];
  const $ = (s,r) => r.querySelector(s);
  const $$ = (s,r) => Array.from(r.querySelectorAll(s));
  const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const svg = paths => '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+paths+'</svg>';
  const ICONS = {
    bold: '<strong>B</strong>', italic: '<em>I</em>', underline: '<span style="text-decoration:underline">U</span>',
    'align-left': svg('<path d="M3 5h18M3 10h12M3 15h18M3 20h12"/>'),
    'align-center': svg('<path d="M3 5h18M6 10h12M3 15h18M6 20h12"/>'),
    'align-right': svg('<path d="M3 5h18M9 10h12M3 15h18M9 20h12"/>'),
    'align-justify': svg('<path d="M3 5h18M3 10h18M3 15h18M3 20h18"/>'),
    check: svg('<rect x="3" y="4" width="6" height="6" rx="1"/><path d="m4.5 7 1 1 2-2M13 7h8M13 17h8"/><rect x="3" y="14" width="6" height="6" rx="1"/>'),
    bullet: svg('<circle cx="5" cy="6" r="1" fill="currentColor"/><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="5" cy="18" r="1" fill="currentColor"/><path d="M10 6h11M10 12h11M10 18h11"/>'),
    number: svg('<path d="M3 4h2v5M3 9h4M3 14c0-2 4-2 4 0 0 1-4 3-4 5h4M11 6h10M11 12h10M11 18h10"/>'),
    letter: '<span class="fmt-letter-icon">a.<br>b.</span>',
    outdent: svg('<path d="M10 5h11M10 10h11M10 15h11M10 20h11M6 8l-4 4 4 4"/>'),
    indent: svg('<path d="M10 5h11M10 10h11M10 15h11M10 20h11M2 8l4 4-4 4"/>')
  };
  function button(command,label) {return '<button type="button" data-format-command="'+command+'" aria-label="'+label+'" title="'+label+'" aria-pressed="false">'+ICONS[command]+'</button>';}
  function html() {
    return '<div class="notepad-formatting" role="toolbar" aria-label="Text formatting">'+
      '<div class="fmt-group"><select class="fmt-font" aria-label="Font" data-format-select="font">'+FONTS.map(f=>'<option value="'+escape(f)+'">'+escape(f)+'</option>').join('')+'<option value="__installed__">Installed fonts…</option></select>'+
      '<select class="fmt-size" aria-label="Font Size" data-format-select="size">'+SIZES.map(n=>'<option value="'+n+'"'+(n===16?' selected':'')+'>'+n+'</option>').join('')+'</select></div>'+
      '<div class="fmt-group">'+button('bold','Bold')+button('italic','Italic')+button('underline','Underline')+
      '<button type="button" class="fmt-color-control" data-format-color-trigger aria-label="Font Color" title="Font Color" aria-haspopup="listbox" aria-expanded="false"><span aria-hidden="true">A<span class="fmt-color-line"></span></span></button></div>'+
      '<div class="fmt-group">'+button('align-left','Align Left')+button('align-center','Center')+button('align-right','Align Right')+button('align-justify','Justify')+'</div>'+
      '<div class="fmt-group">'+button('check','Checklist')+button('bullet','Bullets')+button('number','Numbers')+button('letter','Letters')+'</div>'+
      '<div class="fmt-group">'+button('outdent','Decrease Indent')+button('indent','Increase Indent')+'</div><span class="fmt-status" role="status" aria-live="polite"></span></div>';
  }
  function familyName(name,fallback=FONT_DEFAULT) {
    return String(name||fallback).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,120)||fallback;
  }
  function family(name) {
    const cleaned=familyName(name);
    return '"'+cleaned.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"'+(cleaned===FONT_DEFAULT?'':', "Comic Sans MS"')+', cursive';
  }
  function attach({editor,toolbar,titleInput=null,getNote,onChange=function(){},onTitleFontChange=function(){}}) {
    if(!editor||!toolbar)throw new TypeError('Formatting needs editor and toolbar elements.');
    const doc=editor.ownerDocument, win=doc.defaultView||global;
    let saved=null,composing=false,destroyed=false,blocked=false,refreshing=false,fontRequest=0,selectedFamily=FONT_DEFAULT;
    let titleActive=false,titleSelection=null,titleFontFamily='Arial',colorMenu=null,selectedColor=null;
    const colorTrigger=$('[data-format-color-trigger]',toolbar);
    const removers=[];
    function listen(node,type,fn,capture=false){node.addEventListener(type,fn,capture);removers.push(()=>node.removeEventListener(type,fn,capture));}
    const element=node=>node?.nodeType===1?node:node?.parentElement;
    const annotation=node=>!!element(node)?.closest(ANNOTATION);
    function cleanText(root) {
      const copy=root.cloneNode(true);
      if(copy.querySelectorAll) $$(ANNOTATION,copy).forEach(n=>n.remove());
      return(copy.textContent||'').replace(/\u200b/g,'');
    }
    function textNodes(root) {
      const result=[],walker=doc.createTreeWalker(root,win.NodeFilter.SHOW_TEXT);
      let node;while((node=walker.nextNode()))if(!annotation(node))result.push(node);
      return result;
    }
    function canonical(node) {
      let el=element(node);if(!el||annotation(el)||!editor.contains(el))return null;
      const check=el.closest('.note-check');if(check&&editor.contains(check))return check;
      for(;el&&el!==editor;el=el.parentElement)if(el.matches(BLOCK)&&!el.matches('.task-label'))return el;
      return null;
    }
    function visibleLengthBefore(root,node,offset) {
      try {const r=doc.createRange();r.selectNodeContents(root);r.setEnd(node,offset);return cleanText(r.cloneContents()).length;}catch{return 0;}
    }
    function endpoint(node,offset) {
      const item=canonical(node);
      return {node,offset,item,id:item?.dataset.itemId,relative:item?visibleLengthBefore(item,node,offset):0,global:visibleLengthBefore(editor,node,offset)};
    }
    function bookmark(range) {return {start:endpoint(range.startContainer,range.startOffset),end:endpoint(range.endContainer,range.endOffset),collapsed:range.collapsed};}
    function captureTitle() {
      titleActive=true;
      titleSelection={start:titleInput.selectionStart,end:titleInput.selectionEnd,direction:titleInput.selectionDirection};
    }
    function capture() {
      if(destroyed||colorMenu)return;
      if(titleInput&&doc.activeElement===titleInput){captureTitle();return;}
      if(annotation(doc.activeElement)){blocked=true;saved=null;return;}
      // Native inputs keep a separate selection. Do not reuse the body's last range
      // while the Font dropdown is being used for the title.
      if(titleActive)return;
      const s=win.getSelection();if(!s?.rangeCount)return;
      const r=s.getRangeAt(0);
      if(editor.contains(r.startContainer)&&editor.contains(r.endContainer)&&!annotation(r.startContainer)&&!annotation(r.endContainer)){
        saved=bookmark(r);blocked=false;
      }
    }
    function endpointAfter(point) {
      if(point.node?.nodeType===3&&editor.contains(point.node)&&!annotation(point.node))return {node:point.node,offset:Math.min(point.offset,point.node.length)};
      const item=(point.item&&editor.contains(point.item)?point.item:null)||(point.id?$$('[data-item-id]',editor).find(n=>n.dataset.itemId===point.id):null);
      const root=item||editor;let left=item?point.relative:point.global;
      const nodes=textNodes(root);
      for(const node of nodes){
        const length=node.length;
        if(left<=length)return {node,offset:Math.max(0,left)};
        left-=length;
      }
      const target=item?.matches('.note-check')?$('.task-label',item):root;
      return {node:target||editor,offset:0};
    }
    function restore(mark=saved) {
      if(!mark)return null;
      const a=endpointAfter(mark.start),b=endpointAfter(mark.end),r=doc.createRange();
      try {r.setStart(a.node,a.offset);r.setEnd(b.node,b.offset);}catch{return null;}
      const s=win.getSelection();s.removeAllRanges();s.addRange(r);
      return r;
    }
    function focusAt(item,at=0) {
      const surface=item.matches('.note-check')?$('.task-label',item):item;
      (surface.matches('.task-label')?surface:editor).focus({preventScroll:true});
      let left=at,node=surface,offset=0;
      for(const text of textNodes(surface)){
        if(left<=text.length){node=text;offset=left;break;}left-=text.length;node=text;offset=text.length;
      }
      const r=doc.createRange();r.setStart(node,offset);r.collapse(true);
      const s=win.getSelection();s.removeAllRanges();s.addRange(r);capture();
    }
    function currentRange() {
      if(blocked)return null;
      let r=restore();
      if(r)return r;
      const first=items()[0]?.node;
      if(first){focusAt(first,0);return restore();}
      const p=doc.createElement('p');p.appendChild(doc.createElement('br'));editor.appendChild(p);focusAt(p,0);return restore();
    }
    function kindOf(list) {return list.dataset.formatList||(list.tagName==='UL'?'bullet':(list.getAttribute('type')==='a'?'letter':'number'));}
    function items() {
      const result=[];
      function walk(parent,depth=0,kind=null){
        for(const node of Array.from(parent.children)){
          if(node.matches(ANNOTATION))continue;
          if(node.matches('ul,ol')){walk(node,Math.max(depth+1,Number(node.dataset.baseLevel)||0),kindOf(node));continue;}
          if(node.matches('.note-check')){result.push({node,kind:'check',level:Math.min(3,Math.max(1,Number(node.dataset.listLevel)||(Number(node.dataset.depth)||0)+1))});continue;}
          if(node.tagName==='LI'){
            result.push({node,kind:kind||kindOf(node.parentElement),level:Math.min(3,Math.max(1,depth))});
            for(const list of Array.from(node.children).filter(el=>el.matches('ul,ol')))walk(list,depth+1,kindOf(list));
            continue;
          }
          if(node.tagName==='DIV'&&Array.from(node.children).some(el=>el.matches('p,div,ul,ol,h1,h2,h3,h4,blockquote')&&!el.matches(ANNOTATION))){walk(node,depth,kind);continue;}
          if(node.matches('p,div,h1,h2,h3,h4,h5,h6,blockquote'))result.push({node,kind:'plain',level:Math.min(3,Math.max(1,Number(node.dataset.listLevel)||1))});
        }
      }
      walk(editor);return result;
    }
    function selected(records,range) {
      const containing=node=>records.map((r,i)=>({r,i})).filter(x=>x.r.node.contains(node)).at(-1)?.i;
      let start=containing(range.startContainer),end=containing(range.endContainer);
      const touched=records.map((r,i)=>({r,i})).filter(x=>range.intersectsNode(x.r.node));
      if(start===undefined)start=touched[0]?.i;
      if(end===undefined)end=touched.at(-1)?.i;
      if(start===undefined)return [];
      if(range.collapsed)end=start;
      return records.slice(Math.min(start,end??start),Math.max(start,end??start)+1);
    }
    function copyAttrs(from,to) {
      for(const a of Array.from(from.attributes))if(a.name!=='class'&&a.name!=='contenteditable'&&a.name!=='role'&&a.name!=='aria-label')to.setAttribute(a.name,a.value);
      to.removeAttribute('value');
    }
    function convert(record,kind,tag='p') {
      const old=record.node;
      const wanted=kind==='check'?'DIV':kind==='plain'?tag.toUpperCase():'LI';
      if(old.tagName===wanted&&old.matches('.note-check')===(kind==='check')){record.kind=kind;return old;}
      const node=doc.createElement(wanted);copyAttrs(old,node);
      const content=doc.createDocumentFragment(),decorations=[];
      const source=old.matches('.note-check')?$('.task-label',old):old;
      if(source)for(const child of Array.from(source.childNodes)){
        if(child.nodeType===1&&child.matches(ANNOTATION)){decorations.push(child);continue;}
        if(child.nodeType===1&&child.matches('ul,ol'))continue;
        if(child.nodeType===1&&child.matches('input[type=checkbox]'))continue;
        content.appendChild(child);
      }
      if(old.matches('.note-check'))for(const child of Array.from(old.children))if(child.matches('.item-reply-actions,.item-thread'))decorations.push(child);
      if(kind==='check'){
        node.className='note-check';node.contentEditable='false';
        const input=doc.createElement('input');input.type='checkbox';input.checked=!!node.dataset.completedBy;input.toggleAttribute('checked',input.checked);input.setAttribute('aria-label','Mark task done');
        const label=doc.createElement('span');label.className='task-label';label.contentEditable='true';label.spellcheck=true;label.setAttribute('role','textbox');label.setAttribute('aria-label','Task text');label.appendChild(content);
        if(!label.childNodes.length)label.appendChild(doc.createElement('br'));
        node.append(input,label);
      }else{
        node.appendChild(content);if(!node.childNodes.length)node.appendChild(doc.createElement('br'));
      }
      decorations.forEach(el=>node.appendChild(el));
      if(old.isConnected)old.replaceWith(node);
      record.node=node;record.kind=kind;return node;
    }
    function marker(kind,level){return(kind==='bullet'?['disc','circle','square']:kind==='letter'?['lower-alpha','lower-roman','decimal']:['decimal','lower-alpha','lower-roman'])[level-1];}
    function rebuild(records) {
      const threads=new Map($$('.item-thread',editor).map(n=>[n.dataset.threadFor,n]));
      records.forEach(r=>Array.from(r.node.children).filter(n=>n.matches('ul,ol')).forEach(n=>n.remove()));
      const fragment=doc.createDocumentFragment();let stack=[];
      for(const record of records){
        const {node,kind}=record,level=Math.min(3,Math.max(1,record.level));
        node.dataset.listLevel=String(level);
        node.dataset.depth=String(level-1);
        if(kind==='plain'||kind==='check'){stack=[];fragment.appendChild(node);continue;}
        let entry=stack[level];
        if(!entry||entry.kind!==kind){
          const list=doc.createElement(kind==='bullet'?'ul':'ol');list.className='np-format-list';list.dataset.formatList=kind;list.style.listStyleType=marker(kind,level);
          const parent=stack[level-1]?.last;
          if(parent)parent.appendChild(list);
          else {list.dataset.baseLevel=String(level);list.style.marginInlineStart=((level-1)*24)+'px';fragment.appendChild(list);}
          entry={kind,list,last:null};stack[level]=entry;
        }
        stack.length=level+1;entry.list.appendChild(node);entry.last=node;
      }
      editor.replaceChildren(fragment);
      for(const [id,panel] of threads){
        const item=records.find(r=>r.node.dataset.itemId===id)?.node;if(!item)continue;
        if(item.tagName==='LI'){const nested=Array.from(item.children).find(n=>n.matches('ul,ol'));if(nested)item.insertBefore(panel,nested);else item.appendChild(panel);}
        else item.after(panel);
      }
    }
    function commit(mark=saved,target=null,at=0) {
      if(target)focusAt(target,at);else restore(mark);
      onChange();
      if(target)focusAt(target,at);else restore(mark);
      capture();refresh();
    }
    function listCommand(kind) {
      const range=currentRange();if(!range)return;
      const mark=bookmark(range),records=items(),chosen=selected(records,range);if(!chosen.length)return;
      const remove=chosen.every(r=>r.kind===kind);
      for(const record of chosen)convert(record,remove?'plain':kind);
      rebuild(records);commit(mark);
    }
    function indent(direction) {
      const range=currentRange();if(!range)return;
      const mark=bookmark(range),records=items(),chosen=selected(records,range),affected=new Set(chosen);
      for(const item of chosen){
        const start=records.indexOf(item);
        if(item.kind!=='plain')for(let i=start+1;i<records.length&&records[i].kind!=='plain'&&records[i].level>item.level;i++)affected.add(records[i]);
      }
      if(!affected.size||Array.from(affected).some(r=>r.level+direction<1||r.level+direction>3))return;
      affected.forEach(r=>r.level+=direction);rebuild(records);commit(mark);
    }
    function style(value) {
      const range=currentRange();if(!range)return;
      const mark=bookmark(range),records=items(),chosen=selected(records,range);
      for(const record of chosen){
        if(record.kind==='plain')convert(record,'plain',value);
        record.node.dataset.formatStyle=value;
      }
      rebuild(records);commit(mark);
    }
    function align(value) {
      const range=currentRange();if(!range)return;
      const mark=bookmark(range);
      for(const record of selected(items(),range)){
        record.node.style.textAlign=value;
        if(record.kind==='check')$('.task-label',record.node)?.style.removeProperty('text-align');
      }
      commit(mark);
    }
    function withoutAnnotations(action) {
      const priorTransaction=editor.dataset.formattingTransaction;
      editor.dataset.formattingTransaction='true';
      const held=$$(ANNOTATION,editor).filter(n=>!n.parentElement?.closest(ANNOTATION)).map(node=>{
        const owner=node.matches('.item-thread')
          ? $$('[data-item-id]',editor).find(item=>item.dataset.itemId===node.dataset.threadFor)
          : canonical(node.parentElement);
        const saved={node,owner,id:owner?.dataset.itemId,parent:node.parentNode,next:node.nextSibling};
        node.remove();return saved;
      });
      try{return action();}finally{
        held.forEach(({node,owner,id,parent,next})=>{
          const item=id?$$('[data-item-id]',editor).find(candidate=>candidate.dataset.itemId===id)
            :(owner&&editor.contains(owner)?owner:null);
          if(!item){
            if(parent&&editor.contains(parent))parent.insertBefore(node,next?.parentNode===parent?next:null);
            return;
          }
          const nested=Array.from(item.children).find(child=>child.matches('ul,ol'));
          if(node.matches('.item-reply-actions')){
            item.insertBefore(node,nested||null);
          }else if(node.matches('.task-completion,.task-stamp')){
            const label=$(':scope > .task-label',item);
            if(label)label.after(node);else item.insertBefore(node,nested||null);
          }else if(item.tagName==='LI'){
            item.insertBefore(node,nested||null);
          }else{
            item.after(node);
          }
        });
        if(priorTransaction===undefined)delete editor.dataset.formattingTransaction;
        else editor.dataset.formattingTransaction=priorTransaction;
      }
    }
    function inlineNative(command) {
      const range=currentRange();if(!range)return;
      const mark=bookmark(range);
      withoutAnnotations(()=>{restore(mark);doc.execCommand(command,false,null);});
      capture();commit(saved||mark);
    }
    function inlineStyle(property,value) {
      const range=currentRange();if(!range)return;
      if(range.collapsed){
        let carrier=element(range.startContainer)?.closest('[data-format-caret]');
        if(!carrier||!editor.contains(carrier)){
          carrier=doc.createElement('span');carrier.dataset.formatCaret='true';carrier.textContent='\u200b';
          if(doc.queryCommandState('bold'))carrier.style.fontWeight='bold';
          if(doc.queryCommandState('italic'))carrier.style.fontStyle='italic';
          if(doc.queryCommandState('underline'))carrier.style.textDecoration='underline';
          range.insertNode(carrier);
          const caret=doc.createRange();caret.setStart(carrier.firstChild,1);caret.collapse(true);
          const selection=win.getSelection();selection.removeAllRanges();selection.addRange(caret);
        }
        carrier.style[property]=value;capture();commit();return;
      }
      const mark=bookmark(range);
      const targets=textNodes(editor).filter(n=>range.intersectsNode(n)&&!element(n)?.closest('.mention,[contenteditable="false"]:not(.note-check)'));
      // task-label is an explicit editable island inside the noneditable checklist shell.
      const segments=targets.map(node=>({node,start:node===range.startContainer?range.startOffset:0,end:node===range.endContainer?range.endOffset:node.length})).filter(s=>s.end>s.start);
      for(const part of segments.reverse()){
        let node=part.node;if(part.end<node.length)node.splitText(part.end);if(part.start)node=node.splitText(part.start);
        const span=doc.createElement('span');span.style[property]=value;node.replaceWith(span);span.appendChild(node);
      }
      // Text splits change original offsets; use the stable per-item text positions.
      mark.start.node=null;mark.end.node=null;commit(mark);
    }
    function cleanupCarriers() {
      if(composing)return false;
      let changed=false;const s=win.getSelection(),range=s?.rangeCount?s.getRangeAt(0):null;
      for(const carrier of $$('[data-format-caret]',editor)){
        if(cleanText(carrier).length===0)continue;
        for(const node of textNodes(carrier)){
          const before=node.data;if(!before.includes('\u200b'))continue;
          const a=range?.startContainer===node?range.startOffset:null,b=range?.endContainer===node?range.endOffset:null;
          node.data=before.replace(/\u200b/g,'');changed=true;
          if(a!==null)range.setStart(node,a-before.slice(0,a).split('\u200b').length+1);
          if(b!==null)range.setEnd(node,b-before.slice(0,b).split('\u200b').length+1);
        }
        carrier.removeAttribute('data-format-caret');
      }
      return changed;
    }
    function splitItem(record,range,records) {
      const check=record.kind==='check',surface=check?$('.task-label',record.node):record.node;
      if(!surface.contains(range.startContainer)||!surface.contains(range.endContainer))return false;
      range.deleteContents();
      const contentNodes=Array.from(surface.childNodes).filter(n=>!(n.nodeType===1&&n.matches(ANNOTATION+',ul,ol')));
      const last=contentNodes.at(-1);
      const tail=doc.createRange();tail.setStart(range.startContainer,range.startOffset);
      if(last)tail.setEndAfter(last);else tail.collapse(true);
      const fragment=tail.extractContents();
      const next={node:doc.createElement('p'),kind:'plain',level:record.level};
      next.node.appendChild(fragment);
      const style=record.node.dataset.formatStyle;if(style)next.node.dataset.formatStyle=style;
      convert(next,record.kind);
      let at=records.indexOf(record)+1;
      if(!check)while(at<records.length&&records[at].kind!=='plain'&&records[at].level>record.level)at++;
      records.splice(at,0,next);rebuild(records);commit(null,next.node,0);return true;
    }
    function keydown(event) {
      if(destroyed||composing||event.isComposing||event.keyCode===229||annotation(event.target)||event.target.matches('textarea,input,button'))return;
      if(event.defaultPrevented)return;
      if(!['Tab','Backspace','Enter'].includes(event.key))return;
      if(editor.getAttribute('aria-activedescendant')&&['Enter','Tab','ArrowUp','ArrowDown'].includes(event.key))return;
      const selection=win.getSelection();
      if(!selection?.rangeCount)return;
      const range=selection.getRangeAt(0);
      if(!editor.contains(range.startContainer)||!editor.contains(range.endContainer)||annotation(range.startContainer)||annotation(range.endContainer))return;
      saved=bookmark(range);blocked=false;
      const records=items(),chosen=selected(records,range),record=chosen[0];if(!record)return;
      if(event.key==='Tab'&&record.kind!=='plain'){
        event.preventDefault();event.stopPropagation();indent(event.shiftKey?-1:1);return;
      }
      if(event.key==='Backspace'&&range.collapsed&&record.kind==='check'){
        const label=$('.task-label',record.node);
        if(label?.contains(range.startContainer)&&visibleLengthBefore(label,range.startContainer,range.startOffset)===0){
          event.preventDefault();event.stopPropagation();convert(record,'plain');rebuild(records);commit(null,record.node,0);
        }
        return;
      }
      if(event.key==='Enter'&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey&&record.kind!=='plain'&&chosen.length===1){
        event.preventDefault();event.stopPropagation();
        if(record.kind!=='check'&&!cleanText(record.node).trim()){
          convert(record,'plain');rebuild(records);commit(null,record.node,0);
        }else splitItem(record,range,records);
      }
    }
    function status(text){$('.fmt-status',toolbar).textContent=text;}
    function closeColors(restoreFocus=false) {
      colorMenu?.remove();colorMenu=null;
      colorTrigger.setAttribute('aria-expanded','false');colorTrigger.removeAttribute('aria-controls');
      if(restoreFocus&&!destroyed&&colorTrigger.isConnected)colorTrigger.focus({preventScroll:true});
    }
    function chooseColor(value) {
      if(destroyed||!COLORS.some(color=>color[1]===value))return;
      closeColors();run('color',value);
      if(titleActive&&titleInput){
        titleInput.focus({preventScroll:true});
        if(titleSelection)titleInput.setSelectionRange(titleSelection.start,titleSelection.end,titleSelection.direction||'none');
      }else if(!blocked){
        const range=restore(),surface=element(range?.startContainer)?.closest('.task-label')||editor;
        surface.focus({preventScroll:true});restore();capture();
      }else colorTrigger.focus({preventScroll:true});
      refresh();
    }
    function openColors() {
      if(destroyed||composing)return;
      if(doc.activeElement===titleInput||editor.contains(doc.activeElement))capture();
      if(colorMenu){closeColors(true);return;}
      const menu=doc.createElement('div');menu.className='notepad-color-popover';menu.id='notepad-colors-'+win.crypto.randomUUID();
      menu.setAttribute('role','listbox');menu.setAttribute('aria-label','Text colors');menu.setAttribute('aria-orientation','horizontal');
      menu.innerHTML=COLORS.map(([name,value])=>'<button type="button" role="option" data-format-color="'+value+'" aria-label="'+name+'" title="'+name+'" aria-selected="'+(selectedColor===value)+'" tabindex="-1"><span class="fmt-color-dot" aria-hidden="true" style="background:'+value+'"></span></button>').join('');
      colorMenu=menu;doc.body.appendChild(menu);colorTrigger.setAttribute('aria-expanded','true');colorTrigger.setAttribute('aria-controls',menu.id);
      const anchor=colorTrigger.getBoundingClientRect(),rect=menu.getBoundingClientRect();
      menu.style.left=Math.max(4,Math.min(win.innerWidth-rect.width-4,anchor.left))+'px';
      menu.style.top=Math.max(4,Math.min(win.innerHeight-rect.height-4,anchor.bottom+rect.height+6<=win.innerHeight?anchor.bottom+2:anchor.top-rect.height-2))+'px';
      const buttons=$$('button',menu),selected=buttons.find(button=>button.dataset.formatColor===selectedColor)||buttons[0];
      selected.tabIndex=0;selected.focus({preventScroll:true});
      menu.addEventListener('pointerdown',event=>{if(event.target.closest('button'))event.preventDefault();});
      menu.addEventListener('click',event=>{const option=event.target.closest('[data-format-color]');if(option)chooseColor(option.dataset.formatColor);});
      menu.addEventListener('keydown',event=>{
        const option=event.target.closest('[data-format-color]');if(!option)return;
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeColors(true);return;}
        if(event.key==='Enter'||event.key===' '){event.preventDefault();chooseColor(option.dataset.formatColor);return;}
        if(event.key==='Tab'){
          event.preventDefault();const controls=$$('button,select',toolbar),index=controls.indexOf(colorTrigger);
          closeColors();(controls[index+(event.shiftKey?-1:1)]||colorTrigger).focus({preventScroll:true});return;
        }
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();const index=buttons.indexOf(option),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
        buttons.forEach((button,i)=>button.tabIndex=i===next?0:-1);buttons[next].focus({preventScroll:true});
      });
    }
    async function installedFonts() {
      const request=++fontRequest;
      $('[data-format-select=font]',toolbar).value=selectedFamily;
      if(typeof global.queryLocalFonts!=='function'){status('Installed fonts are unavailable in this browser.');refresh();return;}
      status('Loading installed fonts…');
      try {
        // Deliberately called only by the explicit Installed fonts dropdown action.
        const fonts=await global.queryLocalFonts();
        if(destroyed||request!==fontRequest)return;
        const names=Array.from(new Set(fonts.map(f=>f.family).filter(Boolean))).sort((a,b)=>a.localeCompare(b));
        const select=$('[data-format-select=font]',toolbar);$('optgroup[data-installed-fonts]',select)?.remove();
        const group=doc.createElement('optgroup');group.label='Installed fonts';group.dataset.installedFonts='true';
        for(const name of names.filter(n=>!FONTS.includes(n))){const option=doc.createElement('option');option.value=name;option.textContent=name;group.appendChild(option);}
        select.insertBefore(group,$('option[value="__installed__"]',select));status(names.length+' installed font families available.');refresh();select.focus();
      } catch(error) {
        if(destroyed)return;
        status(error?.name==='NotAllowedError'?'Installed font access was not granted.':'Installed fonts are unavailable here.');refresh();
      }
    }
    function run(command,value) {
      if(destroyed||composing)return false;
      if(titleActive&&titleInput){
        if(command!=='font'){refresh();return false;}
        status('');
        if(value==='__installed__'){installedFonts();return true;}
        titleFontFamily=familyName(value,'Arial');
        titleInput.style.fontFamily=family(titleFontFamily);
        const selection=titleSelection;
        onTitleFontChange(titleFontFamily);
        titleInput.focus({preventScroll:true});
        if(selection&&selection.start!==null&&selection.end!==null)titleInput.setSelectionRange(selection.start,selection.end,selection.direction||'none');
        captureTitle();refresh();return true;
      }
      if(blocked)return false;
      status('');
      if(['bold','italic','underline'].includes(command))inlineNative(command);
      else if(['check','bullet','number','letter'].includes(command))listCommand(command);
      else if(command==='indent'||command==='outdent')indent(command==='indent'?1:-1);
      else if(command==='style'&&STYLES.some(s=>s[0]===value))style(value);
      else if(command==='align'&&['left','center','right','justify'].includes(value))align(value);
      else if(['align-left','align-center','align-right','align-justify'].includes(command))align(command.slice(6));
      else if(command==='font'){
        if(value==='__installed__'){installedFonts();return true;}
        inlineStyle('fontFamily',family(value));
      }
      else if(command==='size')inlineStyle('fontSize',Math.min(96,Math.max(6,Number(value)||16))+'px');
      else if(command==='color'&&COLORS.some(c=>c[1]===value))inlineStyle('color',value);
      else return false;
      refresh();return true;
    }
    function refresh() {
      if(destroyed||refreshing)return;refreshing=true;
      try{
        const selection=win.getSelection(),node=colorMenu?saved?.start.node:selection?.anchorNode;
        const current=titleActive?null:editor.contains(node)&&!annotation(node)?canonical(node):saved?.start.item;
        const sample=element(node);
        const computed=win.getComputedStyle(titleActive&&titleInput?titleInput:sample&&editor.contains(sample)&&!annotation(sample)?sample:editor);
        const primary=titleActive?titleFontFamily:computed.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g,'')||FONT_DEFAULT;
        selectedFamily=primary;
        const font=$('[data-format-select=font]',toolbar);
        if(!Array.from(font.options).some(o=>o.value===primary)){const option=doc.createElement('option');option.value=primary;option.textContent=primary;font.insertBefore(option,$('option[value="__installed__"]',font));}
        if(doc.activeElement!==font)font.value=primary;
        const size=$('[data-format-select=size]',toolbar),number=Math.round(parseFloat(computed.fontSize)||16);
        if(!Array.from(size.options).some(o=>o.value===String(number))){const option=doc.createElement('option');option.value=String(number);option.textContent=String(number);size.appendChild(option);}
        if(doc.activeElement!==size)size.value=String(number);
        const alignmentStyle=current?.isConnected&&editor.contains(current)?win.getComputedStyle(current):computed;
        const textAlign=alignmentStyle.textAlign;
        const alignment=textAlign==='start'?(alignmentStyle.direction==='rtl'?'right':'left'):textAlign==='end'?(alignmentStyle.direction==='rtl'?'left':'right'):['center','right','justify'].includes(textAlign)?textAlign:'left';
        for(const value of ['left','center','right','justify'])$('[data-format-command=align-'+value+']',toolbar).setAttribute('aria-pressed',String(alignment===value));
        for(const command of ['bold','italic','underline'])$('[data-format-command='+command+']',toolbar).setAttribute('aria-pressed',String(!titleActive&&doc.queryCommandState(command)));
        const record=items().find(r=>r.node===current);
        for(const kind of ['check','bullet','number','letter'])$('[data-format-command='+kind+']',toolbar).setAttribute('aria-pressed',String(record?.kind===kind));
        const color=computed.color.match(/\d+/g)?.slice(0,3).map(n=>Number(n).toString(16).padStart(2,'0')).join('');
        selectedColor=COLORS.some(c=>c[1]==='#'+color)?'#'+color:null;
        if(colorMenu)$$('[data-format-color]',colorMenu).forEach(option=>option.setAttribute('aria-selected',String(option.dataset.formatColor===selectedColor)));
        $('.fmt-color-line',toolbar).style.backgroundColor=computed.color;
      }finally{refreshing=false;}
    }
    function destroy(){if(destroyed)return;destroyed=true;fontRequest++;closeColors();removers.forEach(remove=>remove());}
    editor.spellcheck=true;
    const note=typeof getNote==='function'?getNote():null;
    editor.style.fontFamily=family(note?.fontFamily||FONT_DEFAULT);
    if(titleInput){
      titleFontFamily=familyName(note?.titleFontFamily,'Arial');
      titleInput.style.fontFamily=family(titleFontFamily);
      listen(titleInput,'select',()=>{if(doc.activeElement===titleInput){captureTitle();refresh();}});
      listen(titleInput,'compositionstart',()=>{composing=true;});
      listen(titleInput,'compositionend',()=>{composing=false;captureTitle();refresh();});
    }
    listen(doc,'focusin',event=>{
      if(colorMenu&&!colorMenu.contains(event.target)&&!colorTrigger.contains(event.target))closeColors();
      if(titleInput&&event.target===titleInput){captureTitle();refresh();}
      else if(editor.contains(event.target)){
        titleActive=false;blocked=annotation(event.target);capture();refresh();
      }
    });
    listen(toolbar,'pointerdown',event=>{
      if(event.target.closest('button,select'))capture();
      const button=event.target.closest('button');
      if(button){event.preventDefault();button.focus({preventScroll:true});}
    });
    listen(toolbar,'click',event=>{if(event.target.closest('[data-format-color-trigger]')){openColors();return;}const button=event.target.closest('[data-format-command]');if(button)run(button.dataset.formatCommand);});
    listen(toolbar,'change',event=>{const select=event.target.closest('[data-format-select]');if(select)run(select.dataset.formatSelect,select.value);});
    listen(colorTrigger,'keydown',event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();openColors();}});
    listen(doc,'pointerdown',event=>{if(colorMenu&&!colorMenu.contains(event.target)&&!colorTrigger.contains(event.target))closeColors();},true);
    listen(doc,'scroll',event=>{if(colorMenu&&!colorMenu.contains(event.target))closeColors();},true);
    listen(win,'resize',()=>closeColors());
    listen(editor,'keydown',keydown,true);
    listen(editor,'input',event=>{if(annotation(event.target))return;if(!event.isComposing)cleanupCarriers();capture();refresh();});
    listen(editor,'compositionstart',event=>{if(!annotation(event.target))composing=true;});
    listen(editor,'compositionend',event=>{
      if(annotation(event.target))return;composing=false;
      queueMicrotask(()=>{if(destroyed)return;if(cleanupCarriers())onChange();capture();refresh();});
    });
    listen(doc,'selectionchange',()=>{if(!composing){capture();refresh();}});
    refresh();
    return {destroy,refresh,run,isInteracting:()=>!!colorMenu};
  }
  global.NotepadFormatting=Object.freeze({html,attach});
})(window);
