(function(){
'use strict';

const labels={
  title:'Title',content:'Note text',priority:'Priority',audience:'Shared with',fontFamily:'Default body font',
  fontSize:'Default body font size',titleFontFamily:'Title font',itemThreads:'Replies',attachments:'Attachments',drawing:'Drawing',
};
const kinds={created:'Created note',updated:'Edited note',registered:'Started recording history'};
const formatTags={B:'bold',STRONG:'bold',I:'italic',EM:'italic',U:'underline',S:'strikethrough',STRIKE:'strikethrough',BLOCKQUOTE:'quote'};
const formatStyles={
  'font-family':'font','font-size':'size','font-weight':'weight','font-style':'style',
  'text-decoration':'decoration','text-align':'alignment','color':'color','background-color':'highlight',
};

function create(tag,className,text) {
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined)node.textContent=text;
  return node;
}

function bodyLines(html,describeFormatting=false) {
  const template=document.createElement('template');
  template.innerHTML=typeof html==='string'?html:'';
  const lines=[];
  const decorate=(node,text)=>{
    if(!describeFormatting||!text.trim())return text;
    const heading=/^h[1-6]$/.test(node.dataset.formatStyle)?node.dataset.formatStyle:node.tagName.toLowerCase();
    const annotations=[formatTags[node.tagName],/^h[1-6]$/.test(heading)?'heading '+heading.slice(1):null];
    for(const [property,label] of Object.entries(formatStyles)){
      const value=node.style.getPropertyValue(property);
      if(value)annotations.push(label+' '+value);
    }
    const formats=annotations.filter(Boolean);
    return formats.length?text+' ['+formats.join(', ')+']':text;
  };
  const plain=node=>{
    if(node.nodeType===Node.TEXT_NODE)return node.data.replace(/\u200b/g,'');
    if(node.nodeType!==Node.ELEMENT_NODE||node.matches('ul,ol,input,script,style'))return '';
    if(node.tagName==='BR')return '\n';
    if(node.matches('.mention[data-mention-kind="location"]'))return node.textContent.replace(/^@/,'');
    return decorate(node,Array.from(node.childNodes,plain).join(''));
  };
  const add=(text,prefix)=>{
    text.trimEnd().split('\n').forEach((line,index)=>lines.push((index?' '.repeat(prefix.length):prefix)+line));
  };
  const walk=(parent,depth=0)=>{
    const indent='  '.repeat(depth);
    let itemNumber=Number(parent.getAttribute?.('start'))||1;
    for(const node of parent.childNodes) {
      if(node.nodeType===Node.TEXT_NODE){if(node.data.trim())add(node.data,indent);continue;}
      if(node.nodeType!==Node.ELEMENT_NODE)continue;
      if(node.matches('ul,ol')){walk(node,depth+(parent.matches?.('li,.note-check')?1:0));continue;}
      const childLists=Array.from(node.children).filter(child=>child.matches('ul,ol'));
      const level=Number(node.dataset.listLevel)||1;
      const localIndent=indent+'  '.repeat(Math.max(0,Math.min(10,level-depth-1)));
      const checked=node.querySelector(':scope > input:checked');
      let marker='';
      if(node.matches('.note-check'))marker=checked?'[x] ':'[ ] ';
      if(node.matches('li')){
        if(node.hasAttribute('value'))itemNumber=Number(node.getAttribute('value'))||itemNumber;
        marker=parent.tagName==='UL'?'• ':orderedMarker(parent,itemNumber);
        itemNumber++;
      }
      const text=decorate(node,Array.from(node.childNodes,plain).join(''));
      if(node.tagName==='HR')add('—',localIndent);
      else if(text.trim()||marker)add(text,localIndent+marker);
      for(const list of childLists)walk(list,depth+1);
    }
  };
  walk(template.content);
  return lines;
}

function orderedMarker(list,index) {
  if(list.dataset.formatList!=='letters'&&!['a','A'].includes(list.type))return index+'. ';
  let letters='';
  for(let value=index;value>0;value=Math.floor((value-1)/26))letters=String.fromCharCode(97+(value-1)%26)+letters;
  return (list.type==='A'?letters.toUpperCase():letters)+'. ';
}

function replyLines(threads,personName) {
  const lines=[];
  const append=(replies,depth)=>{
    for(const reply of replies){
      const indent='  '.repeat(depth);
      lines.push(...String(reply.text??'').split('\n').map((line,i)=>indent+(i?'  ':(reply.authorName||personName(reply.authorId))+': ')+line));
      append(reply.replies||[],depth+1);
    }
  };
  for(const replies of Object.values(threads||{}))append(replies,0);
  return lines;
}

function diffLines(before,after) {
  const same=text=>({change:'same',text}), removed=text=>({change:'removed',text}), added=text=>({change:'added',text});
  let start=0,bEnd=before.length,aEnd=after.length;
  while(start<bEnd&&start<aEnd&&before[start]===after[start])start++;
  while(bEnd>start&&aEnd>start&&before[bEnd-1]===after[aEnd-1]){bEnd--;aEnd--;}
  const rows=before.slice(0,start).map(same);
  const bCount=bEnd-start,aCount=aEnd-start,width=aCount+1;
  // Bound the LCS allocation for wholesale replacements in very long notes.
  if(!bCount||!aCount||bCount*aCount>250000){
    for(let line=start;line<bEnd;line++)rows.push(removed(before[line]));
    for(let line=start;line<aEnd;line++)rows.push(added(after[line]));
  }else{
    const lcs=new Uint32Array((bCount+1)*width);
    for(let b=bCount-1;b>=0;b--){
      for(let a=aCount-1;a>=0;a--){
        const at=b*width+a;
        lcs[at]=before[start+b]===after[start+a]?lcs[at+width+1]+1:Math.max(lcs[at+width],lcs[at+1]);
      }
    }
    let b=0,a=0;
    while(b<bCount||a<aCount){
      if(b<bCount&&a<aCount&&before[start+b]===after[start+a]){rows.push(same(before[start+b]));b++;a++;}
      else if(b<bCount&&(a===aCount||lcs[(b+1)*width+a]>=lcs[b*width+a+1]))rows.push(removed(before[start+b++]));
      else rows.push(added(after[start+a++]));
    }
  }
  return rows.concat(before.slice(bEnd).map(same));
}

function context(rows) {
  if(!rows.some(row=>row.change!=='same'))return [];
  const visible=new Set();
  rows.forEach((row,index)=>{
    if(row.change==='same')return;
    for(let i=Math.max(0,index-2);i<=Math.min(rows.length-1,index+2);i++)visible.add(i);
  });
  const compact=[];
  rows.forEach((row,index)=>{
    if(visible.has(index))compact.push(row);
    else if(!index||visible.has(index-1))compact.push({change:'skip',text:'…'});
  });
  return compact;
}

function attach({panel,trigger,load,personName,audienceName,formatDate,onClose}) {
  const heading=create('h2','', 'Edit History');
  heading.tabIndex=-1;
  const close=create('button','history-button','Back to note');
  close.type='button';
  close.addEventListener('click',onClose);
  const bar=create('header','history-toolbar');
  bar.append(heading,close);
  const status=create('p','history-status');
  status.setAttribute('role','status');
  const versions=create('div','history-versions');
  const more=create('button','history-button','Load earlier edits');
  more.type='button';
  more.hidden=true;
  let cursor=null,count=0;

  function lines(key,value) {
    if(value==null)return [];
    switch(key){
      case 'content':return bodyLines(value);
      case 'itemThreads':return replyLines(value,personName);
      case 'audience':return [audienceName(value)];
      case 'attachments':return value.map(String);
      case 'drawing':return [value.strokes+' drawing '+(value.strokes===1?'stroke':'strokes')];
      case 'fontSize':return [String(value)+' px'];
      default:return String(value).split('\n');
    }
  }
  function renderChanges(version,into) {
    for(const [key,label] of Object.entries(labels)){
      const before=version.before?.[key],after=version.after?.[key];
      if(before===undefined&&after===undefined)continue;
      let rows=context(diffLines(lines(key,before),lines(key,after)));
      if(!rows.length&&before===undefined&&!after?.length&&key!=='drawing')continue;
      if(!rows.length&&key==='content'){
        rows=context(diffLines(bodyLines(before,true),bodyLines(after,true)));
        if(!rows.length)rows.push({change:'same',text:'Text formatting changed.'});
      }
      if(!rows.length&&key==='drawing')rows.push({change:'same',text:'Drawing strokes changed.'});
      if(!rows.length&&key==='itemThreads')rows.push({change:'same',text:'Reply placement changed.'});
      if(!rows.length)continue;
      const field=create('section','history-field');
      const code=create('div','history-diff');
      code.setAttribute('role','list');
      for(const {change,text} of rows){
        const row=create('div','history-line');
        row.dataset.change=change;
        row.setAttribute('role','listitem');
        const marker=create('span','history-marker',change==='added'?'+':change==='removed'?'−':' ');
        if(change==='added'||change==='removed')marker.setAttribute('aria-label',change==='added'?'Added':'Removed');
        row.append(marker,create('code','',text));
        code.append(row);
      }
      field.append(create('h3','',label),code);
      into.append(field);
    }
  }
  function renderVersion(version) {
    const detail=create('details','history-version');
    const summary=create('summary','history-version-meta');
    const date=create('time','',formatDate(version.at));
    date.dateTime=version.at;
    summary.append(create('span','history-editor-name',version.actorName||personName(version.actorId)),create('span','history-kind',kinds[version.kind]||kinds.updated),date);
    const changes=create('div','history-changes');
    detail.append(summary,changes);
    if(!count++){
      detail.open=true;
      renderChanges(version,changes);
    }else{
      detail.addEventListener('toggle',function expanded(){
        if(!detail.open)return;
        renderChanges(version,changes);
        detail.removeEventListener('toggle',expanded);
      });
    }
    versions.append(detail);
  }
  async function page() {
    more.disabled=true;
    status.textContent='Loading edits…';
    try {
      const result=await load(cursor);
      if(!panel.isConnected||panel.hidden)return;
      result.entries.forEach(renderVersion);
      cursor=result.next;
      status.textContent=count?'':'No edits have been recorded for this note yet.';
      more.textContent='Load earlier edits';
      more.hidden=cursor==null;
    }catch(error){
      if(!panel.isConnected||panel.hidden)return;
      status.textContent=error instanceof Error?error.message:'Edit history could not be loaded.';
      more.textContent='Try again';
      more.hidden=false;
    }finally {more.disabled=false;}
  }

  more.addEventListener('click',page);
  panel.replaceChildren(bar,status,versions,more);
  panel.hidden=false;
  trigger.setAttribute('aria-expanded','true');
  heading.focus({preventScroll:true});
  void page();
  return {close(){
    panel.hidden=true;
    panel.replaceChildren();
    trigger.setAttribute('aria-expanded','false');
    trigger.focus({preventScroll:true});
  }};
}

window.NotepadHistory={attach};
}());
