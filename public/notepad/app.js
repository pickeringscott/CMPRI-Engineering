(function(){
'use strict';
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const iconPaths={
 play:'<path d="m8 5 12 7-12 7z"/>',
 text:'<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M5 9h1m3 0h1m3 0h1m3 0h1M5 12h1m3 0h1m3 0h1m3 0h1M7 16h10"/>',
 pen:'<path d="m4 16 11-11 4 4L8 20l-5 1zM13 7l4 4M4 16l4 4"/>',
 eraser:'<path d="m4 12 9-9 8 8-9 10H8l-6-6zM8 8l8 8M12 21h9"/>',
 check:'<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m7 12 3 3 7-7"/>',
 bullet:'<circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/><path d="M9 6h12M9 12h12M9 18h12"/>',
 undo:'<path d="M9 5 3 11l6 6M3 11h11a6 6 0 0 1 6 6"/>',redo:'<path d="m15 5 6 6-6 6M21 11H10a6 6 0 0 0-6 6"/>',
 close:'<path d="m6 6 12 12M6 18 18 6"/>',trash:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',chevron:'<path d="m7 10 5 5 5-5"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
 group:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5.7"/>',
 lock:'<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
 book:'<path d="M5 3h14v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM6 3v18M10 8h5M10 12h5"/>',
 reply:'<path d="M8 8 3 12l5 4M3 12h10a7 7 0 0 1 7 7V9a5 5 0 0 0-5-5"/>',
 post:'<path d="m5 12 4 4L19 6"/>',all:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c4 4 4 14 0 18M12 3c-4 4-4 14 0 18"/>'
};
const icon=n=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(iconPaths[n]||iconPaths.book)+'</svg>';
const mediaSymbol='<svg viewBox="0 0 80 64" class="staff-media-symbol" aria-hidden="true" fill="currentColor"><path fill-rule="evenodd" d="M2 18H18V21H9V34H28V32H37V54H2V18ZM4 21H7V24H4V21ZM4 27H7V30H4V27ZM4 33H7V36H4V33ZM4 39H7V42H4V39ZM4 45H7V48H4V45ZM4 50H7V52H4V50ZM10 38H28V51H10V38ZM30 35H34V38H30V35ZM30 41H34V44H30V41ZM30 47H34V50H30V47Z"/><path d="M20 3H59V20H56V6H23V27H44L41 30H20V3Z"/><circle cx="31" cy="12" r="3.5"/><path d="M27 24L34 17L39 20L44 12L50 23L47 25H27Z"/><path fill-rule="evenodd" d="M78 43a20 20 0 1 1-40 0a20 20 0 1 1 40 0ZM51 32V48C49 46 44 47 44 51C44 55 52 56 54 51V37L66 35V45C63 43 58 45 59 49C60 53 68 52 69 48V29L51 32Z"/></svg>';
const colors=[['Black','#000000'],['Red','#ff0000'],['Green','#008000'],['Blue','#0000ff'],['Orange','#ffa500'],['Yellow','#ffff00'],['Purple','#800080'],['White','#ffffff']];
let roles = [], people = [];
const excludedTagEmails = new Set(['assmgr@test.com','chief@test.com','frontmgr@test.com','gm@test.com','gpt@test.com','frontdesk@test.com']);
function isTaggableAccount(account) {
  const email=String(account.email||'').trim().toLowerCase();
  const status=String(account.status||'').trim().toLowerCase();
  return account.taggable!==false && account.active!==false && account.is_active!==false && account.isActive!==false && !account.deactivated && !account.deactivated_at && !account.deactivatedAt && !['inactive','deactivated','disabled'].includes(status) && !excludedTagEmails.has(email);
}
const isSelectableRecipient=account=>isTaggableAccount(account)&&account.recipientSelectable!==false;
const clone = value => JSON.parse(JSON.stringify(value));
const personById = id => people.find(p => p.id === id) || {id,name:'Former user',short:'Former user',roles:[]};
const priorityNames = ['Low','Normal','High','Urgent'];
const priorityLabel = value => value==='Urgent'?'Urgent!':value;
function titleFontFamily(n) {
  const name=String(n.titleFontFamily||'Comic Sans MS').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,120);
  return '"'+name.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'", "Comic Sans MS", cursive';
}
const urgentMark = n => '<span class="note-urgent" aria-hidden="true"'+(n.priority==='Urgent'?'':' hidden')+'><span class="note-urgent-crop"><img src="/notepad/urgent-button.jpg" width="2048" height="1143" alt="" draggable="false"></span></span>';
const privateAudience = () => ({all:false,roles:[],people:[]});
const engineeringRoles = ['engineer','technician'];
let VIEW_STORE = '';
const bridgeToken = new URLSearchParams(location.search).get('bridge');
let initialized=false, suppressSave=false, accountGeneration=0;
const sentDocuments=new Map(), dirtyNotes=new Set(), sequences=new Map(), requests=new Map(), deferredNotes=new Map(), baseRevisions=new Map(), baseLegacyVersions=new Map(), confirmedDeletions=new Map();
let lastOrder='', legacyAliases={}, bridgeScope='';
function sendHost(type,payload){if(bridgeToken&&parent!==window)parent.postMessage({channel:'cmpri-notepad',token:bridgeToken,scope:bridgeScope,type,payload},location.origin);}
function hostRequest(action,payload){return new Promise((resolve,reject)=>{const requestId=crypto.randomUUID();requests.set(requestId,{resolve,reject});parent.postMessage({channel:'cmpri-notepad',token:bridgeToken,scope:bridgeScope,type:'request',requestId,action,payload},location.origin);});}
const TIME_ZONE = 'America/Chicago';
const uid = () => crypto.randomUUID();
let timeFormat='12h';
const dateFormatters=Object.fromEntries(['12h','24h'].map(format=>{
  const options={timeZone:TIME_ZONE,month:'short',day:'numeric',hour:format==='24h'?'2-digit':'numeric',minute:'2-digit',hourCycle:format==='24h'?'h23':'h12'};
  return [format,{
    sidebar:new Intl.DateTimeFormat('en-US',options),
    full:new Intl.DateTimeFormat('en-US',{...options,year:'numeric',timeZoneName:'short'}),
    compact:new Intl.DateTimeFormat('en-US',{...options,month:'2-digit',day:'2-digit'}),
  }];
}));
function shortTime(iso,sidebar=false) {
  const date=new Date(iso);
  if(!Number.isFinite(date.getTime()))return '';
  const p=Object.fromEntries(dateFormatters[timeFormat][sidebar?'sidebar':'compact'].formatToParts(date).map(({type,value})=>[type,value]));
  return (sidebar?p.day+' '+p.month:p.month+'/'+p.day)+' '+p.hour+':'+p.minute+(p.dayPeriod?' '+p.dayPeriod:'');
}
function fullTime(iso) {
  const date=new Date(iso);
  return Number.isFinite(date.getTime())?dateFormatters[timeFormat].full.format(date):'';
}
const timestamp=(iso,className='')=>'<time class="'+className+'" datetime="'+escape(iso)+'" title="'+escape(fullTime(iso))+'">'+shortTime(iso,className==='sidebar-creation')+'</time>';
function updateTimeFormat(format) {
  const active=personById(currentPerson);
  timeFormat=format==='12h'||format==='24h'?format:(active.displayRole||active.role||'').toLowerCase().replace(/[\s_-]/g,'')==='chiefengineer'?'24h':'12h';
  $$('time[datetime]').forEach(el=>{el.textContent=el.closest('.note-history')?fullTime(el.dateTime):shortTime(el.dateTime,el.matches('.sidebar-creation'));el.title=fullTime(el.dateTime);});
}
function taskHtml(text,id=uid('task'),completedBy='',completedAt='') {
  return '<div class="note-check" contenteditable="false" data-item-id="'+id+'" data-task-id="'+id+'"'+(completedBy?' data-completed-by="'+completedBy+'" data-completed-at="'+completedAt+'"':'')+'><input type="checkbox" aria-label="Mark task done"'+(completedBy?' checked':'')+'><span class="task-label" contenteditable="true" role="textbox" aria-label="Task text" spellcheck="true">'+text+'</span></div>';
}
const baseNote = (id,title,audience,content,extra={}) => ({id,title,audience,content,authorId:currentPerson,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),priority:'Normal',fontSize:16,fontFamily:'Comic Sans MS',titleFontFamily:'Comic Sans MS',itemThreads:{},openThreads:[],ink:[],inkUndo:[],inkRedo:[],attachments:[],replies:[],completionEvents:[],...extra});
let notes=[], orders={}, currentPerson='', activeNote='', query='', mode='text', device=innerWidth<650?'mobile':'desktop';
let inkColor='#ffffff',penWidth=4,textColor='#f6ebff',textSize=16;
let inkController=null, popoverAnchor=null, selectionRange=null, toastTimer, mentionSession=null, draggedNote=null, pointerDrag=null, suppressNoteClick=false;
let recipientDraft=null, recipientSession=null, deleteSession=null, deleteGesture=null, titleEdit=null, isComposing=false;
let formattingController=null, attachmentController=null, historyController=null, titleResizeObserver=null, paperResizeObserver=null, resizeGesture=null, paneWidths={desktop:220,mobile:110}, noteTransition=0, activeNoteTransition=0;
let mobileSidebarCollapsed=false, mobileFormattingExpanded=false;
const replyTargets={};
const storedTagSelector='.mention[data-mention-kind]';
function firstTagText(chip) {
  return document.createTreeWalker(chip,NodeFilter.SHOW_TEXT).nextNode();
}
function sanitizeContent(html) {
  const template=document.createElement('template');template.innerHTML=String(html||'');
  template.content.querySelectorAll('script,style,iframe,object,embed,link,meta,img,video,audio,form').forEach(el=>el.remove());
  template.content.querySelectorAll('*').forEach(el=>Array.from(el.attributes).forEach(a=>{if(/^on/i.test(a.name)||['src','srcdoc','href'].includes(a.name))el.removeAttribute(a.name);}));
  template.content.querySelectorAll('.mention[data-mention-kind="location"]').forEach(chip=>{
    const text=firstTagText(chip);
    if(text?.data.startsWith('@'))text.deleteData(0,1);
  });
  canonicalAttachmentMarkers(template.content);
  return template.innerHTML;
}
// Keep the saved HTML format and remove the prefix only in the writing view.
function displayTagLabels(root) {
  for(const chip of $$(storedTagSelector,root)){
    const text=firstTagText(chip);
    if(text?.data.startsWith('@')){
      text.deleteData(0,1);
      chip.dataset.npTagPrefix='';
    }
  }
}
function restoreTagPrefixes(root) {
  for(const chip of $$('[data-np-tag-prefix]',root)){
    const text=firstTagText(chip);
    if(text)text.insertData(0,'@');
    else chip.prepend('@');
    delete chip.dataset.npTagPrefix;
  }
}

const actor=()=>personById(currentPerson);
const note=()=>notes.find(n=>n.id===activeNote);
const canEditTitle=n=>!!n&&n.authorId===currentPerson;
function canView(n) {const a=n.audience;return n.authorId===currentPerson || a.all || a.people.includes(currentPerson) || actor().roles.some(r=>a.roles.includes(r)||(r==='system_admin'&&a.roles.includes('engineer')));}
function orderedNotes() {
  const order=orders[currentPerson]||[];
  return notes.filter(canView).sort((a,b)=>{const ai=order.indexOf(a.id),bi=order.indexOf(b.id);return(ai<0?order.length+notes.indexOf(a):ai)-(bi<0?order.length+notes.indexOf(b):bi);});
}
function filteredNotes() {const term=query.trim().toLowerCase();return orderedNotes().filter(n=>(n.title+' '+plainContent(n)).toLowerCase().includes(term));}
function plainContent(n) {const el=document.createElement('div');el.innerHTML=n.content.replace(/<\/(p|div|li)>/gi,' </$1>');displayTagLabels(el);return(el.textContent||'').replace(/\s+/g,' ').trim();}
function audienceLabel(a) {
  if(!a.all&&!a.roles.length&&!a.people.length)return 'Just me';
  const roleNames=a.all?['All Roles']:a.roles.length===3&&['engineer','technician','system_admin'].every(role=>a.roles.includes(role))
    ? ['Engineering'] : a.roles.map(r=>roles.find(item=>item.id===r)?.label||r);
  return [...a.people.map(p=>personById(p).short),...roleNames].join(', ');
}
function documentFor(n) {
  return {title:n.title,audience:n.audience,content:n.content,priority:n.priority,fontSize:n.fontSize||16,fontFamily:n.fontFamily||'Comic Sans MS',titleFontFamily:n.titleFontFamily||'Comic Sans MS',ink:n.ink||[],itemThreads:n.itemThreads||{},attachments:(n.attachments||[]).map(({url,preview,original,uploaderId,...file})=>file),...(typeof n.untouchedDraft==='boolean'?{untouchedDraft:n.untouchedDraft}:{})};
}
function prepareNote(n) {return {...n,content:sanitizeContent(n.content),ink:n.ink||[],inkUndo:[],inkRedo:[],openThreads:[],itemThreads:n.itemThreads||{},attachments:n.attachments||[],completionEvents:[]};}
function markEdited(n=note()) {if(n)n.untouchedDraft=false;}
function isUntouchedDraft(n) {
  if(n.authorId!==currentPerson||n.legacySource||n.untouchedDraft===false)return false;
  if(n.untouchedDraft!==true&&n.revision!==1)return false;
  const body=document.createElement('div');body.innerHTML=n.content;
  return !body.textContent.replace(/[\s\u200b\u00a0]/g,'')&&!body.querySelector('input,ul,ol,li,table,hr,.mention')&&!(n.ink||[]).length&&!(n.attachments||[]).length&&!Object.values(n.itemThreads||{}).some(thread=>thread.length);
}
function save() {
  if(!initialized||suppressSave)return;
  sizeNotePaper();
  for(const n of notes){
    const document=documentFor(n),snapshot=JSON.stringify(document);
    if(sentDocuments.get(n.id)===snapshot)continue;
    const sequence=(sequences.get(n.id)||0)+1;sequences.set(n.id,sequence);dirtyNotes.add(n.id);sentDocuments.set(n.id,snapshot);
    baseRevisions.set(n.id,n.revision??null);baseLegacyVersions.set(n.id,n.legacyVersion||null);sendHost('save',{id:n.id,document,sequence,baseRevision:n.revision??null,baseLegacyVersion:n.legacyVersion||null});
  }
  for(const id of sentDocuments.keys())if(!notes.some(n=>n.id===id)&&sentDocuments.get(id)!=='null'){
    const sequence=(sequences.get(id)||0)+1;sequences.set(id,sequence);dirtyNotes.add(id);sentDocuments.set(id,'null');sendHost('save',{id,document:null,sequence,baseRevision:baseRevisions.get(id)??null,baseLegacyVersion:baseLegacyVersions.get(id)||null});
  }
  const order=orders[currentPerson]||orderedNotes().map(n=>n.id),serialized=JSON.stringify(order);
  if(lastOrder!==serialized){lastOrder=serialized;sendHost('order',{order});}
  if(VIEW_STORE)try{localStorage.setItem(VIEW_STORE,JSON.stringify({activeNote,paneWidths,mobileSidebarCollapsed}));}catch{}
}
function toast(message) {const el=$('#preview-toast');el.textContent=message;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),2200);}
function syncEditor() {
  const n=note(),el=$('.note-content');if(!n||!el)return;
  $$('.note-check input[type=checkbox]',el).forEach(box=>box.toggleAttribute('checked',box.checked));
  const clean=el.cloneNode(true);
  $$('.item-reply-actions,.item-thread,.task-completion,.task-stamp',clean).forEach(node=>node.remove());
  restoreTagPrefixes(clean);
  for(const chip of $$(storedTagSelector,clean))for(const name of ['title','tabindex','role'])chip.removeAttribute(name);
  canonicalAttachmentMarkers(clean);
  n.content=clean.innerHTML;n.fontSize=parseInt(el.style.fontSize)||n.fontSize||16;
  save();
  refreshAttachmentViews();
}
function startTitleEdit(input) {
  const n=note();
  if(!input||!canEditTitle(n)||input!==$('#note-title'))return false;
  if(titleEdit?.input!==input)titleEdit={input,id:n.id,original:n.title,fontFamily:n.titleFontFamily||'Comic Sans MS',changed:false};
  return true;
}
function stageTitleFont(family) {
  if(!startTitleEdit($('#note-title')))return;
  titleEdit.fontFamily=family;
  sizeNoteTitle();
}
function finishTitleEdit(cancel=false) {
  const edit=titleEdit,n=note();
  titleEdit=null;
  if(!edit||n?.id!==edit.id||!canEditTitle(n))return;
  if(cancel){
    edit.input.value=edit.original;
    formattingController?.setTitleFont(n.titleFontFamily);
    sizeNoteTitle();
    return;
  }
  const title=edit.changed?edit.input.value:n.title;
  const fontChanged=edit.fontFamily!==(n.titleFontFamily||'Comic Sans MS');
  if(title===n.title&&!fontChanged&&(!edit.changed||n.untouchedDraft===false))return;
  markEdited(n);
  n.title=title;
  if(fontChanged)n.titleFontFamily=edit.fontFamily;
  n.updatedAt=new Date().toISOString();
  save();
  refreshSidebar();
}
function inTitleEditor(element) {
  return element===titleEdit?.input||!!element?.closest?.('.notepad-formatting,.notepad-color-popover');
}
const inlineAttachmentSelector='[data-notepad-attachment-id]';
const pendingInlineUploads=new Map();
const attachmentUUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const writingDecoration='.item-reply-actions,.item-thread,.task-completion,.task-stamp';
function attachmentMarker(id) {
  const marker=document.createElement('span');
  marker.dataset.notepadAttachmentId=id;marker.setAttribute('contenteditable','false');
  return marker;
}
function canonicalAttachmentMarkers(root) {
  $$('[data-upload-pending]',root).forEach(marker=>marker.remove());
  for(const block of $$('[data-upload-block]',root)){
    block.removeAttribute('data-upload-block');
    if(!block.hasChildNodes())block.remove();
  }
  for(const marker of $$(inlineAttachmentSelector,root)){
    const id=marker.dataset.notepadAttachmentId;
    if(marker.tagName==='SPAN'&&attachmentUUID.test(id))marker.replaceWith(attachmentMarker(id));
    else marker.removeAttribute('data-notepad-attachment-id');
  }
}
function attachmentTextBlock(item) {
  return item?.matches('.note-check')?$('.task-label',item)||item:item;
}
function lastAttachmentPosition(root,block=attachmentTextBlock(itemNodes(root).at(-1))||root) {
  const range=document.createRange(),tail=Array.from(block.children).find(child=>child.matches('ul,ol,'+writingDecoration));
  if(tail)range.setStartBefore(tail);else{range.selectNodeContents(block);range.collapse(false);}
  range.collapse(true);return range;
}
function safeAttachmentPosition(root,range) {
  const {startContainer}=range;
  if(!root.contains(startContainer))return null;
  const element=startContainer.nodeType===Node.ELEMENT_NODE?startContainer:startContainer.parentElement;
  if(element?.closest(writingDecoration))return null;
  const island=element?.closest('[contenteditable]');
  if(island&&island!==root&&root.contains(island)&&island.getAttribute('contenteditable')==='false')range.setStartAfter(island);
  range.collapse(true);return range;
}
function captureAttachmentPosition(target) {
  if(!target||target.id!==activeNote)return null;
  const editor=$('.note-content');if(!editor)return null;
  rememberSelection();
  const selection=selectionRange?.cloneRange();
  if(selection)selection.collapse(false);
  const range=(selection&&safeAttachmentPosition(editor,selection))||lastAttachmentPosition(editor);
  const container=range.startContainer.nodeType===Node.ELEMENT_NODE?range.startContainer:range.startContainer.parentElement;
  const item=container?.closest('[data-item-id]'),preferred=attachmentTextBlock(item);
  const block=preferred?.contains(range.startContainer)?preferred:item||editor;
  const prefix=document.createRange();prefix.selectNodeContents(block);
  prefix.setEnd(range.startContainer,range.startOffset);
  const text=prefix.cloneContents();
  $$(writingDecoration+','+inlineAttachmentSelector,text).forEach(node=>node.remove());
  return {editor,range,itemId:item?.dataset.itemId,offset:text.textContent.length,afterId:''};
}
function findAttachmentPosition(root,placement) {
  const previous=placement.afterId&&$$(inlineAttachmentSelector,root).find(marker=>marker.dataset.notepadAttachmentId===placement.afterId);
  if(previous){const range=document.createRange();range.setStartAfter(previous);range.collapse(true);return range;}
  if(root===placement.editor){const live=safeAttachmentPosition(root,placement.range.cloneRange());if(live)return live;}
  const item=placement.itemId&&itemNodes(root).find(node=>node.dataset.itemId===placement.itemId);
  const block=attachmentTextBlock(item)||root,walker=document.createTreeWalker(block,NodeFilter.SHOW_TEXT);
  let offset=placement.offset,node;
  while((node=walker.nextNode())){
    if(node.parentElement?.closest(writingDecoration+','+inlineAttachmentSelector))continue;
    if(offset>node.length){offset-=node.length;continue;}
    const range=document.createRange();range.setStart(node,offset);range.collapse(true);
    return safeAttachmentPosition(root,range)||lastAttachmentPosition(root,block);
  }
  return lastAttachmentPosition(root,item?block:undefined);
}
function insertAttachmentMarker(root,placement,marker){
  const range=findAttachmentPosition(root,placement);
  if(range.startContainer===root){
    const paragraph=document.createElement('p');paragraph.dataset.itemId=uid('item');
    if(marker.hasAttribute('data-upload-pending'))paragraph.setAttribute('data-upload-block','');
    range.insertNode(paragraph);paragraph.append(marker);
  }else range.insertNode(marker);
  placement.afterId=marker.dataset.notepadAttachmentId;
}
function paintPendingUploads(root,batch){
  const placement={...batch.placement};
  let last;
  for(const file of batch.files){
    const existing=$$(inlineAttachmentSelector,root).find(marker=>marker.dataset.notepadAttachmentId===file.id);
    if(existing){placement.afterId=file.id;last=existing;continue;}
    const marker=attachmentMarker(file.id);marker.setAttribute('data-upload-pending','');
    marker.setAttribute('role','status');marker.textContent='Uploading '+file.name+'…';
    insertAttachmentMarker(root,placement,marker);last=marker;
  }
  return last;
}
function insertInlineAttachment(change) {
  const {note:target,placement,additions}=change;
  if(!placement)return false;
  const editor=target.id===activeNote?$('.note-content'):null;
  const root=editor||document.createElement('div');
  if(!editor){root.innerHTML=target.content;displayTagLabels(root);}
  for(const attachment of additions){
    const pending=$$('[data-upload-pending]',root).find(marker=>marker.dataset.notepadAttachmentId===attachment.id);
    if(pending){
      pending.removeAttribute('data-upload-pending');pending.removeAttribute('role');
      pending.parentElement?.removeAttribute('data-upload-block');pending.replaceChildren();
      placement.afterId=attachment.id;
    }else insertAttachmentMarker(root,placement,attachmentMarker(attachment.id));
  }
  if(!editor){restoreTagPrefixes(root);target.content=root.innerHTML;}
  return Boolean(editor);
}
function inlineThumbnail(attachment) {
  const {video,image,url}=window.NotepadAttachments.inlineMedia(attachment);
  const thumbnail=attachment.kind==='gif'||video||image;
  const button=document.createElement(thumbnail?'button':'a');
  const name=attachment.name||'Attachment';
  button.dataset.openInlineAttachment=attachment.id;
  button.title=name;button.setAttribute('aria-label','Open '+name);
  if(thumbnail){
    button.type='button';button.className='inline-attachment-open';
    button.dataset.thumbnailLabel=attachment.kind==='gif'?'GIF':video?'VIDEO':'PHOTO';
    button.innerHTML=icon(video?'play':'book');
    if(url)showThumbnailMedia(button,url,video);
  }else{
    button.className='inline-attachment-link';
    button.href=url||'#';button.target='_blank';button.rel='noopener noreferrer';button.textContent=name;
  }
  const remove=document.createElement('button');remove.type='button';remove.className='inline-attachment-remove';
  remove.dataset.removeInlineAttachment=attachment.id;remove.setAttribute('aria-label','Remove '+name);remove.innerHTML=icon('close');
  return attachment.uploaderId===currentPerson?[button,remove]:[button];
}
function showThumbnailMedia(button,url,video=false) {
  const media=document.createElement(video?'video':'img');
  media.setAttribute('aria-hidden','true');
  if(video){
    media.muted=true;media.playsInline=true;media.preload='metadata';media.hidden=true;
    media.addEventListener('loadeddata',()=>{media.hidden=false;},{once:true});
  }else {media.alt='';media.loading='lazy';}
  media.src=url;media.addEventListener('error',()=>media.remove(),{once:true});
  button.append(media);
}
function closeAttachmentPreview(){ $('.inline-attachment-preview')?.remove(); }
function showAttachmentPreview(opener){
  closeAttachmentPreview();
  const preview=document.createElement('div');
  preview.className='inline-attachment-preview';preview.setAttribute('aria-hidden','true');
  const source=$('img,video',opener);
  if(source?.src){
    const media=source.cloneNode(false);
    media.hidden=false;media.removeAttribute('loading');
    if(media.tagName==='VIDEO'){media.muted=true;media.preload='auto';}
    preview.append(media);
    media.addEventListener('load',()=>positionPopover(preview,opener),{once:true});
    media.addEventListener('loadedmetadata',()=>positionPopover(preview,opener),{once:true});
  }
  const caption=document.createElement('span');caption.textContent=opener.title;
  preview.append(caption);document.body.append(preview);positionPopover(preview,opener);
}
document.addEventListener('pointerover',event=>{
  const opener=event.target.closest('[data-open-inline-attachment]');
  if(device==='desktop'&&event.pointerType==='mouse'&&opener&&!opener.contains(event.relatedTarget))showAttachmentPreview(opener);
});
document.addEventListener('pointerout',event=>{
  const opener=event.target.closest('[data-open-inline-attachment]');
  if(opener&&!opener.contains(event.relatedTarget))closeAttachmentPreview();
});
document.addEventListener('scroll',closeAttachmentPreview,true);
function refreshAttachmentViews() {
  const root=$('.note-content'),target=note(),dock=$('.editor-attachments');if(!root||!target||!dock)return;
  const inlineIds=new Set(),gifs=[],attachments=new Map(target.attachments.map(file=>[file.id,file]));
  for(const marker of $$(inlineAttachmentSelector,root)){
    if(marker.hasAttribute('data-upload-pending'))continue;
    const file=attachments.get(marker.dataset.notepadAttachmentId);
    if(!file||inlineIds.has(file.id)){marker.replaceChildren();continue;}
    inlineIds.add(file.id);marker.contentEditable='false';
    if(!marker.firstChild)marker.append(...inlineThumbnail(file));
    const button=$('[data-open-inline-attachment]',marker);
    if(button&&file.kind==='gif'&&!button.hasAttribute('data-gif-preview')&&attachmentController){
      button.setAttribute('data-gif-preview','');gifs.push({button,id:file.gifId});
    }
  }
  const markup=attachmentMarkup(target,inlineIds);
  if(dock.innerHTML!==markup)dock.innerHTML=markup;
  if(gifs.length)void attachmentController.gifPreviews(gifs.map(({id})=>id)).then(previews=>{
    for(const {button,id} of gifs)if(button.isConnected&&previews.has(id))showThumbnailMedia(button,previews.get(id));
  });
}
function noteAttachmentsChanged(change) {
  const editor=change.note.id===activeNote?$('.note-content'):null;
  if(change.kind==='upload-pending'){
    if(!change.placement)return;
    const batch={noteId:change.note.id,placement:change.placement,files:change.pendingFiles};
    pendingInlineUploads.set(batch.files[0].id,batch);
    if(editor){
      const last=paintPendingUploads(editor,batch);
      if(last&&[document.body,change.opener].includes(document.activeElement)){
        (last.parentElement.closest('[contenteditable="true"]')||editor).focus({preventScroll:true});
        const range=document.createRange();range.setStartAfter(last);range.collapse(true);
        const selection=getSelection();selection.removeAllRanges();selection.addRange(range);rememberSelection();
      }
    }
    return;
  }
  if(change.kind==='upload-finished'){
    const entry=[...pendingInlineUploads].find(([,batch])=>batch.files.some(file=>file.id===change.id));
    if(!entry)return;
    const [key,batch]=entry;
    batch.files=batch.files.filter(file=>file.id!==change.id);
    if(!batch.files.length)pendingInlineUploads.delete(key);
    const pending=editor&&$$('[data-upload-pending]',editor).find(marker=>marker.dataset.notepadAttachmentId===change.id);
    if(pending){
      const block=pending.parentElement;pending.remove();
      if(block.hasAttribute('data-upload-block')&&!block.hasChildNodes())block.remove();
    }
    return;
  }
  for(const file of change.additions)file.uploaderId=currentPerson;
  markEdited(change.note);
  if(insertInlineAttachment(change))syncEditor();
  else {save();if(change.noteId===activeNote)refreshAttachmentViews();}
}
function removeNoteAttachment(id) {
  closeAttachmentPreview();
  const target=note();if(!target?.attachments.some(file=>file.id===id&&file.uploaderId===currentPerson))return;
  target.attachments=target.attachments.filter(file=>file.id!==id);
  for(const marker of $$(inlineAttachmentSelector,$('.note-content')))if(marker.dataset.notepadAttachmentId===id)marker.remove();
  markEdited(target);syncEditor();
}
function attachmentMarkup(n,inlineIds=new Set()) {
  return (n.attachments||[]).map((a,i)=>{
    if(inlineIds.has(a.id))return '';
    const photo=window.NotepadAttachments.photoPreview(a),name=escape(a.name);
    const preview=photo?'<img src="'+escape(photo)+'" loading="lazy" alt="">':name;
    return '<div class="attachment-chip'+(photo?' is-photo':'')+'">'+(photo?'':icon(a.kind==='gif'?'book':'check'))+'<button type="button" class="attachment-open" data-open-attachment="'+i+'" aria-label="Open '+name+'" title="'+name+'">'+preview+'</button>'+(a.uploaderId===currentPerson?'<button type="button" data-remove-attachment="'+i+'" aria-label="Remove '+name+'">×</button>':'')+'</div>';
  }).join('');
}
function renderNotes() {
  const list=filteredNotes();
  return '<div class="notes-list" role="list" aria-label="Notes in your order">'+(list.map(n=>{
    const audience=escape(audienceLabel(n.audience));
    return '<div class="note-row" role="listitem" draggable="true" data-row="'+n.id+'" data-current="'+(n.id===activeNote)+'"><button class="note-item" data-note="'+n.id+'" data-drag-note="'+n.id+'" aria-current="'+(n.id===activeNote)+'" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" title="'+escape(n.title||'Untitled')+'"><strong style="font-family:'+escape(titleFontFamily(n))+'">'+urgentMark(n)+escape(n.title||'Untitled')+'</strong><span class="note-meta"><span class="priority-meta" data-priority="'+n.priority.toLowerCase()+'">'+priorityLabel(n.priority)+'</span><span class="audience-meta" title="'+audience+'">'+audience+'</span>'+timestamp(n.createdAt,'sidebar-creation')+'</span></button></div>';
  }).join('')||'<p class="empty-list">'+(query?'No matching titles or text.':'No notes yet.')+'</p>')+'</div>';
}
function refreshSidebar() {const slot=$('.np-notes-slot');if(slot)slot.innerHTML=renderNotes();const count=$('.note-count');if(count)count.textContent=orderedNotes().length+' notes';}
function tools() {
  return '<div class="general-notes-tools"><div class="general-notes-dock" role="toolbar" aria-label="Notepad controls">'+[['text','Text and keyboard handwriting'],['pen','Handwritten ink'],['eraser','Erase ink stroke']].map(([id,label])=>'<button data-mode="'+id+'" aria-label="'+label+'" title="'+label+'" aria-pressed="'+(mode===id)+'">'+icon(id)+'</button>').join('')+'<button data-action="undo" aria-label="Undo ink" title="Undo ink">'+icon('undo')+'</button><button data-action="redo" aria-label="Redo ink" title="Redo ink">'+icon('redo')+'</button><span class="general-notes-dock-spacer"></span>'+window.NotepadAttachments.html()+'</div></div>';
}
function editor() {
  const n=note();if(!n)return '<div class="editor-empty"><strong>Your Notepad</strong><p>Use + in the search bar to create a note.</p></div>';
  const person=personById(n.authorId),authorName=n.authorName||person.name;
  const creator=authorName===person.name?person.short:authorName.trim().split(/\s+/)[0];
  return '<article class="general-notes-editor">'+
    '<div class="title-row">'+
      '<div class="note-heading">'+urgentMark(n)+'<textarea id="note-title" rows="1" wrap="soft" aria-label="Note title" title="'+(canEditTitle(n)?'Edit title · Choose its font in the toolbar':'Only the note’s creator can edit its title.')+'"'+(canEditTitle(n)?'':' readonly')+' placeholder="Untitled" maxlength="120" style="font-family:'+escape(titleFontFamily(n))+'">'+escape(n.title)+'</textarea></div>'+
      '<div class="title-actions"><button class="scope-button" data-action="share" aria-label="Shared with…" title="Shared with…">'+icon('group')+'<span>Shared with…</span></button><button class="title-tool" data-action="delete" aria-label="Delete note" title="'+(n.authorId===currentPerson?'Delete note':'Only the note’s creator can delete it.')+'" aria-disabled="'+(n.authorId!==currentPerson)+'">'+icon('trash')+'</button></div>'+
      '<div class="note-metadata">'+
        '<div class="priority-row note-details"><label for="note-priority">Priority</label><select id="note-priority" aria-label="Priority">'+priorityNames.map(p=>'<option value="'+p+'" '+(n.priority===p?'selected':'')+'>'+priorityLabel(p)+'</option>').join('')+'</select></div>'+
        '<div class="note-attribution"><span class="note-creator" data-full-name="'+escape(authorName)+'" data-short-name="'+escape(creator)+'" title="Created by '+escape(authorName)+'">'+escape(device==='desktop'?creator:authorName)+'</span>'+timestamp(n.createdAt)+'<button type="button" class="note-history-link" data-action="open-history" aria-controls="note-history" aria-expanded="false">Edit History</button></div>'+
      '</div></div>'+
    window.NotepadFormatting.html(mobileFormattingExpanded)+
    '<div class="general-notes-workspace"><div class="general-notes-body"><div class="general-notes-scroll"><div class="general-notes-paper '+(mode!=='text'?'is-drawing':'')+'"><div class="note-content" style="font-size:'+(n.fontSize||16)+'px;font-family:&quot;'+escape(n.fontFamily||'Comic Sans MS')+'&quot;,&quot;Comic Sans MS&quot;,cursive" role="textbox" aria-label="Notepad writing area" aria-multiline="true" contenteditable="'+(mode==='text')+'" spellcheck="true" data-placeholder="Write a note, add a checklist, or type @…">'+n.content+'</div><svg class="note-ink" xmlns="http://www.w3.org/2000/svg" aria-label="Handwriting canvas"></svg></div></div></div>'+
    '<div class="editor-attachments">'+attachmentMarkup(n)+'</div>'+tools()+'</div><section id="note-history" class="note-history" aria-label="Edit History" hidden></section></article>';
}
function render() {
  finishTitleEdit();
  noteTransition++;activeNoteTransition=0;
  closeAttachmentPreview();closePopover();closeMentions();selectionRange=null;resizeGesture=null;
  formattingController?.destroy();formattingController=null;attachmentController?.destroy();attachmentController=null;
  historyController=null;
  titleResizeObserver?.disconnect();titleResizeObserver=null;
  paperResizeObserver?.disconnect();paperResizeObserver=null;
  inkController?.destroy();inkController=null;
  if(!note()||!canView(note()))activeNote=orderedNotes()[0]?.id||'';
  $('#layout-body').innerHTML='<section class="np-layout layout-1" aria-label="Familiar Sidebar"><aside id="notepad-sidebar" class="np-sidebar" aria-label="Saved notes"><div class="search-box"><button class="search-new" data-action="new" aria-label="New Note" title="New Note">'+icon('plus')+'</button><input type="search" aria-label="Search notes" placeholder="Search notes" value="'+escape(query)+'"></div><div class="np-notes-slot">'+renderNotes()+'</div><div class="np-sidebar-summary"><span class="note-count">'+orderedNotes().length+' notes</span></div></aside><div class="pane-divider" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" aria-controls="notepad-sidebar" tabindex="0"><span class="pane-divider-grip" aria-hidden="true"></span></div><main class="np-main" aria-label="Selected note">'+editor()+'</main></section>';
  $('#window-wrap').classList.toggle('is-mobile',device==='mobile');
  $$('[data-device]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.device===device)));
  const n=note();
  if(n) {
    textSize=n.fontSize||16;
    displayTagLabels($('.note-content'));
    decorateTags($('.note-content'));
    $$('.task-label').forEach(el=>el.contentEditable=String(mode==='text'));
    inkController=window.NotepadInk.attach({paper:$('.general-notes-paper'),textLayer:$('.note-content'),svg:$('.note-ink'),getNote:note,getMode:()=>mode,getColor:()=>inkColor,getWidth:()=>penWidth,onSave:changed=>{markEdited(changed);save();},onModeChange:next=>setMode(next)});
    normalizeSharedItems();
    formattingController=window.NotepadFormatting.attach({editor:$('.note-content'),toolbar:$('.notepad-formatting'),titleInput:$('#note-title'),getNote:note,onTitleFontChange:stageTitleFont,onChange:()=>{markEdited();normalizeSharedItems();syncEditor();}});
    if(typeof ResizeObserver==='function'){
      let titleWidth=-1;
      titleResizeObserver=new ResizeObserver(entries=>{const width=entries[0]?.contentRect.width;if(width!==undefined&&width!==titleWidth){titleWidth=width;sizeNoteTitle();}});
      titleResizeObserver.observe($('#note-title'));
      paperResizeObserver=new ResizeObserver(()=>sizeNotePaper());
      paperResizeObserver.observe($('.general-notes-scroll'));
    }
    const generation=accountGeneration;
    const onAttachmentChange=change=>{if(generation===accountGeneration)noteAttachmentsChanged(change);};
    attachmentController=window.NotepadAttachments.attach({container:$('.general-notes-dock'),pickerRoot:$('.general-notes-body'),getNote:note,getNoteById:id=>notes.find(n=>n.id===id),badge:'/Poweredby_100px_Badge.gif',request:hostRequest,onError:toast,isNoteAvailable:id=>initialized&&generation===accountGeneration&&notes.some(n=>n.id===id),getInlinePlacement:captureAttachmentPosition,onChange:onAttachmentChange,onUploadState:onAttachmentChange});
    refreshAttachmentViews();
    for(const batch of pendingInlineUploads.values())if(batch.noteId===n.id)paintPendingUploads($('.note-content'),batch);
    $$('.note-check').forEach(updateTaskAccessibleLabel);
  }
  applyPaneWidth();save();
}
async function selectNote(id) {
  finishTitleEdit();
  if(id===activeNote){
    noteTransition++;activeNoteTransition=0;
    const current=$('.general-notes-editor');current?.getAnimations().forEach(a=>a.cancel());if(current)current.style.pointerEvents='';
    const incoming=deferredNotes.get(id);if(incoming&&!dirtyNotes.has(id))installRemote(incoming);
    return;
  }
  // Keep acknowledgements from replacing the closing editor and invalidating
  // this selection. The old note stays active until all input has finished.
  const token=++noteTransition;activeNoteTransition=token;
  syncEditor();closeMentions();closePopover();
  const old=$('.general-notes-editor'),reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  old?.getAnimations().forEach(a=>a.cancel());
  if(old)old.style.pointerEvents='none';
  const attachmentsClosing=attachmentController?.close({restoreFocus:false});
  const closing=old&&!reduced?old.animate([{transform:'scaleX(1)',opacity:1},{transform:'scaleX(0.015)',opacity:0}],{duration:130,easing:'ease-in',fill:'forwards'}).finished.catch(()=>{}):Promise.resolve();
  await Promise.all([closing,attachmentsClosing]);
  if(token!==noteTransition)return;
  inkController?.destroy();inkController=null;
  for(const [deferredId,incoming]of deferredNotes)if(!dirtyNotes.has(deferredId))installRemote(incoming,false);
  activeNote=id;mode='text';render();sendHost('refresh');
  const opened=$('.general-notes-editor');
  if(opened&&!reduced)opened.animate([{transform:'scaleX(0.015)',opacity:0},{transform:'scaleX(1)',opacity:1}],{duration:160,easing:'ease-out'});
}
function applyPaneWidth(value,remember=true) {
  const layout=$('.layout-1'),divider=$('.pane-divider');if(!layout||!divider)return;
  const available=layout.clientWidth,mobile=device==='mobile',min=available<650?80:140,max=Math.max(min,Math.min(460,available-(mobile?150:195)));
  const collapsed=mobile&&mobileSidebarCollapsed,sidebar=$('#notepad-sidebar');
  const width=Math.round(Math.max(min,Math.min(max,value??paneWidths[device]??(mobile?110:220))));
  if(remember&&(!mobile||value!==undefined))paneWidths[device]=width;
  layout.style.setProperty('--sidebar-width',(collapsed?0:width)+'px');
  layout.toggleAttribute('data-sidebar-collapsed',collapsed);
  sidebar.inert=collapsed;
  divider.setAttribute('aria-valuemin',String(mobile?0:min));divider.setAttribute('aria-valuemax',String(max));divider.setAttribute('aria-valuenow',String(collapsed?0:width));
  if(mobile)divider.setAttribute('aria-valuetext',collapsed?'Sidebar collapsed':width+' pixels wide');
  else divider.removeAttribute('aria-valuetext');
  $$('.reply-input').forEach(sizeReplyInput);
  sizeNoteTitle();
  sizeNotePaper();
}

function previewPaneResize(drag,x) {
  if(drag.device!==device)return;
  drag.x=x;
  const requested=drag.startWidth+x-drag.startX;
  if(device==='mobile')mobileSidebarCollapsed=requested<=4;
  drag.width=drag.collapsed&&requested>4?Math.max(drag.savedWidth,requested):requested;
  // Commit only on release so collapsing never overwrites the open width.
  applyPaneWidth(drag.width,false);
}

function setMobileFormatting(expanded) {
  if(device!=='mobile')return;
  mobileFormattingExpanded=expanded;
  $('[data-toggle-formatting]')?.setAttribute('aria-expanded',String(expanded));
}

function sizeNotePaper() {
  const paper=$('.general-notes-paper'),n=note();if(!paper||!n)return;
  const scroller=$('.general-notes-scroll'),styles=getComputedStyle(scroller);
  // Use the width before a scrollbar takes space so ink near the bottom cannot
  // repeatedly add/remove that scrollbar as the drawing width changes.
  const width=scroller.offsetWidth-(parseFloat(styles.borderLeftWidth)||0)-(parseFloat(styles.borderRightWidth)||0);
  const scale=width/800;
  let bottom=0;
  for(const stroke of n.ink||[])for(const point of stroke.points||[])bottom=Math.max(bottom,point.y+stroke.size*(.5+point.p)/2);
  const height=Math.ceil(bottom*scale)+'px';
  if(paper.style.getPropertyValue('--ink-content-height')!==height)paper.style.setProperty('--ink-content-height',height);
}

function sizeNoteTitle() {
  const title=$('#note-title');if(!title)return;
  title.style.height='auto';
  title.style.height=Math.max(30,title.scrollHeight)+'px';
}

function setMode(next) {
  mode=next;
  $('.general-notes-paper')?.classList.toggle('is-drawing',mode!=='text');
  $('.note-content')?.setAttribute('contenteditable',String(mode==='text'));
  $$('.task-label').forEach(el=>el.contentEditable=String(mode==='text'));
  $$('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===mode)));
  inkController?.setMode(next);
}
function rememberSelection() {
  const selection=getSelection(),content=$('.note-content');
  if(selection?.rangeCount&&content?.contains(selection.anchorNode))selectionRange=selection.getRangeAt(0).cloneRange();
}
function restoreSelection() {
  const content=$('.note-content');if(!content)return;
  setMode('text');content.focus();
  const selection=getSelection();
  if(selectionRange&&content.contains(selectionRange.startContainer)) {try{selection.removeAllRanges();selection.addRange(selectionRange);return;}catch{}}
  const range=document.createRange();range.selectNodeContents(content);range.collapse(false);selection.removeAllRanges();selection.addRange(range);selectionRange=range.cloneRange();
}
function closePopover() {$('#popover-layer').innerHTML='';popoverAnchor?.setAttribute('aria-expanded','false');popoverAnchor=null;}
function positionPopover(el,anchor,above=false) {
  const r=anchor.getBoundingClientRect(),rect=el.getBoundingClientRect();
  el.style.left=Math.max(5,Math.min(innerWidth-rect.width-5,r.left))+'px';
  el.style.top=Math.max(5,Math.min(innerHeight-rect.height-5,above?r.top-rect.height-3:r.bottom+3))+'px';
}
function showPopover(content,anchor,cls='') {
  closePopover();closeMentions();popoverAnchor=anchor;
  $('#popover-layer').innerHTML='<section class="preview-popover '+cls+'">'+content+'</section>';
  const el=$('.preview-popover');positionPopover(el,anchor,cls==='tool-bubble');anchor.setAttribute('aria-expanded','true');return el;
}
function recipientForm(a,purpose) {
  const isPrivate=!a.all&&!a.roles.length&&!a.people.length;
  const pill=(kind,label,value='',checked=false)=>'<label class="recipient-pill"><input type="checkbox" data-recipient="'+kind+'"'+(value?' value="'+escape(value)+'"':'')+(checked?' checked':'')+'><span>'+escape(label)+'</span></label>';
  const roleLabel=p=>p.displayRole||roles.find(r=>r.id===p.role)?.label||roles.find(r=>p.roles?.includes(r.id))?.label||String(p.role||'').replace(/_/g,' ');
  const create=purpose==='new'?'<button class="recipient-submit recipient-create" type="submit">Create Note</button>':'';
  return '<div class="recipient-private-choice">'+pill('private','Just Me','',isPrivate)+create+'</div>'+
    '<section class="recipient-section" aria-labelledby="recipient-people-heading"><h3 id="recipient-people-heading">Individual Names</h3><div class="recipient-options">'+people.filter(isSelectableRecipient).map(p=>pill('person',p.name+' ('+roleLabel(p)+')',p.id)).join('')+'</div></section>'+
    '<section class="recipient-section" aria-labelledby="recipient-roles-heading"><h3 id="recipient-roles-heading">Roles and Departments</h3><div class="recipient-options">'+pill('all','All Roles','',a.all)+pill('engineering','Engineering')+roles.filter(r=>r.id!=='system_admin').map(r=>pill('role',r.label,r.id)).join('')+'</div></section>'+
    (purpose==='share'?'<div class="recipient-footer"><button class="recipient-submit" type="submit">Save recipients</button></div>':'');
}
function animateRecipientDialog(session,opening,done=()=>{}) {
  const dialog=session.dialog;
  session.animation?.cancel();session.animation=null;
  if(!dialog.isConnected||matchMedia('(prefers-reduced-motion: reduce)').matches||typeof dialog.animate!=='function'){done();return;}
  const from=session.origin?.isConnected?session.origin.getBoundingClientRect():session.originRect,to=dialog.getBoundingClientRect();
  const x=from.left+from.width/2-to.left-to.width/2,y=from.top+from.height/2-to.top-to.height/2;
  const collapsed={transform:'translate('+x+'px,'+y+'px) scale('+Math.max(.015,from.width/Math.max(1,to.width))+','+Math.max(.015,from.height/Math.max(1,to.height))+')',opacity:0};
  const expanded={transform:'translate(0,0) scale(1)',opacity:1};
  const animation=dialog.animate(opening?[collapsed,expanded]:[expanded,collapsed],{duration:opening?220:180,easing:opening?'ease-out':'ease-in',fill:'both'});
  session.animation=animation;
  animation.finished.then(()=>{if(session.animation!==animation)return;session.animation=null;animation.cancel();done();},()=>{});
}
function reopenUntouchedDraft() {
  const draft=orderedNotes().find(isUntouchedDraft);if(!draft)return false;
  draft.untouchedDraft=true;query='';
  const generation=accountGeneration;
  const focus=()=>{if(initialized&&generation===accountGeneration&&activeNote===draft.id)$('#note-title')?.focus({preventScroll:true});};
  if(draft.id===activeNote){refreshSidebar();$('.search-box input').value='';save();focus();}
  else void selectNote(draft.id).then(focus);
  return true;
}
function openRecipients(purpose='new',origin) {
  if(!initialized)return;
  finishTitleEdit();
  syncEditor();closePopover();closeMentions();
  if(purpose==='new'&&reopenUntouchedDraft())return;
  if(purpose==='share'&&!note())return;
  closeRecipients({immediate:true,restoreFocus:false});
  recipientDraft=purpose==='new'?privateAudience():clone(note().audience);
  origin ||= $('[data-action="'+(purpose==='new'?'new':'share')+'"]');
  const dialog=document.createElement('dialog');dialog.className='recipient-dialog';dialog.setAttribute('aria-labelledby','recipient-heading');
  dialog.innerHTML='<form id="recipient-form" method="dialog"><div class="recipient-heading"><h2 id="recipient-heading">Who’s it for?</h2><button type="button" data-action="cancel-recipients" aria-label="Close recipients">×</button></div>'+recipientForm(recipientDraft,purpose)+'</form>';
  recipientSession={dialog,origin,originRect:origin.getBoundingClientRect(),purpose,noteId:purpose==='share'?activeNote:null,generation:accountGeneration,closing:false,animation:null};
  dialog.addEventListener('cancel',e=>{e.preventDefault();closeRecipients();});
  const onBackdrop=e=>{
    if(e.target!==dialog)return false;
    const bounds=dialog.getBoundingClientRect();
    return e.clientX<bounds.left||e.clientX>bounds.right||e.clientY<bounds.top||e.clientY>bounds.bottom;
  };
  let pressedBackdrop=false;
  dialog.addEventListener('pointerdown',e=>{pressedBackdrop=e.button===0&&onBackdrop(e);});
  dialog.addEventListener('pointercancel',()=>{pressedBackdrop=false;});
  dialog.addEventListener('click',e=>{
    const dismiss=pressedBackdrop&&onBackdrop(e);
    pressedBackdrop=false;
    if(!dismiss)return;
    if(purpose==='share'&&note()?.authorId===currentPerson)finishRecipients();
    else if(purpose==='new'&&(recipientDraft.all||recipientDraft.roles.length||recipientDraft.people.length))finishRecipients();
    else closeRecipients();
  });
  document.body.append(dialog);updateRecipientChecks();if(purpose==='share'&&note().authorId!==currentPerson){$$('input,button[type=submit]',dialog).forEach(control=>control.disabled=true);}dialog.showModal();$('[data-recipient=private]',dialog).focus();animateRecipientDialog(recipientSession,true);
}
function closeRecipients({immediate=false,restoreFocus=true,onClose}={}) {
  const session=recipientSession;if(!session)return;
  if(session.closing&&!immediate)return;
  session.closing=true;
  if(onClose)session.onClose=onClose;
  const finish=()=>{
    if(recipientSession!==session)return;
    session.animation?.cancel();session.animation=null;
    session.dialog.close();session.dialog.remove();recipientSession=null;recipientDraft=null;
    if(restoreFocus&&session.generation===accountGeneration&&session.origin?.isConnected)session.origin.focus({preventScroll:true});
    if(initialized&&session.generation===accountGeneration)session.onClose?.();
  };
  if(immediate){finish();return;}
  session.dialog.inert=true;
  animateRecipientDialog(session,false,finish);
}
function updateRecipientChecks() {
  const dialog=$('.recipient-dialog'),a=recipientDraft;if(!dialog||!a)return;
  $('[data-recipient=private]',dialog).checked=!a.all&&!a.roles.length&&!a.people.length;
  $('[data-recipient=all]',dialog).checked=a.all;
  const eng=$('[data-recipient=engineering]',dialog),n=engineeringRoles.filter(r=>a.roles.includes(r)).length;
  eng.checked=n===engineeringRoles.length;eng.indeterminate=n>0&&!eng.checked;
  $$('[data-recipient=role]',dialog).forEach(el=>el.checked=a.roles.includes(el.value));
  $$('[data-recipient=person]',dialog).forEach(el=>el.checked=a.people.includes(el.value));
}
function changeRecipient(box) {
  const kind=box.dataset.recipient,a=recipientDraft;if(!a)return;
  if(kind==='private') {recipientDraft=privateAudience();}
  else if(kind==='all') {recipientDraft={all:box.checked,roles:[],people:a.people};}
  else {
    if(a.all&&kind!=='person') {a.all=false;a.roles=[];}
    const set=(array,value,checked)=>checked?(array.includes(value)?array:array.concat(value)):array.filter(v=>v!==value);
    if(kind==='engineering')for(const id of engineeringRoles)a.roles=set(a.roles,id,box.checked);
    if(kind==='role')a.roles=set(a.roles,box.value,box.checked);
    if(kind==='person')a.people=set(a.people,box.value,box.checked);
  }
  updateRecipientChecks();
}
function finishRecipients() {
  const session=recipientSession;
  if(!initialized||!recipientDraft||!session||session.closing)return;
  const audience=clone(recipientDraft),target=notes.find(n=>n.id===session.noteId);
  if(session.purpose==='share'&&(!target||target.authorId!==currentPerson))return;
  closeRecipients({restoreFocus:false,onClose:()=>{
    if(session.purpose==='new') {
      const now=new Date().toISOString(),id=uid('note');
      notes.unshift(baseNote(id,'',audience,'',{authorId:currentPerson,createdAt:now,updatedAt:now,untouchedDraft:true}));
      const order=orders[currentPerson]||orderedNotes().filter(n=>n.id!==id).map(n=>n.id);orders[currentPerson]=[id,...order.filter(item=>item!==id)];
      activeNote=id;query='';mode='text';render();
      const opened=$('.general-notes-editor');
      if(opened&&typeof opened.animate==='function'&&!matchMedia('(prefers-reduced-motion: reduce)').matches)opened.animate([{transformOrigin:'center center',transform:'scale(.015)',opacity:0},{transformOrigin:'center center',transform:'scale(1)',opacity:1}],{duration:220,easing:'ease-out'});
      $('#note-title').focus({preventScroll:true});
    } else {
      const current=notes.find(n=>n.id===session.noteId);if(!current||current.authorId!==currentPerson)return;
      if(JSON.stringify(current.audience)!==JSON.stringify(audience)){markEdited(current);current.audience=audience;current.updatedAt=new Date().toISOString();}
      if(activeNote===current.id){render();$('[data-action=share]')?.focus({preventScroll:true});}else{save();refreshSidebar();}
    }
  }});
}
function isShared(n=note()) {return !!(n&&(n.audience.all||n.audience.roles.length||n.audience.people.length));}
function includeTaggedPeople(audience,ids) {
  if(!ids.some(id=>!audience.people.includes(id)))return audience;
  return {...audience,people:[...new Set([...audience.people,...ids])].sort()};
}
function confirmTaggedPeople(note,ids) {
  const wasShared=isShared(note);
  note.audience=includeTaggedPeople(note.audience,ids);
  const sent=sentDocuments.get(note.id);
  if(sent&&sent!=='null'){
    const document=JSON.parse(sent);
    document.audience=includeTaggedPeople(document.audience,ids);
    sentDocuments.set(note.id,JSON.stringify(document));
  }
  if(recipientDraft&&recipientSession?.purpose==='share'&&recipientSession.noteId===note.id){
    recipientDraft=includeTaggedPeople(recipientDraft,ids);
    updateRecipientChecks();
  }
  if(note.id===activeNote&&!wasShared&&isShared(note))normalizeSharedItems();
  refreshSidebar();
}
function itemNodes(editor=$('.note-content'),wrapText=false) {
  if(!editor)return [];
  const result=[];
  function walk(parent) {
    for(const node of Array.from(parent.childNodes)) {
      if(node.nodeType===Node.TEXT_NODE) {
        if(wrapText&&parent===editor&&node.textContent.trim()) {const p=document.createElement('p');parent.insertBefore(p,node);p.appendChild(node);result.push(p);}
        continue;
      }
      if(node.nodeType!==Node.ELEMENT_NODE||node.matches('.item-thread,.item-reply-actions,.task-completion,.task-stamp'))continue;
      if(node.matches('ul,ol')){walk(node);continue;}
      if(node.matches('.note-check')){result.push(node);continue;}
      if(node.tagName==='LI') {result.push(node);for(const list of Array.from(node.children).filter(el=>el.matches('ul,ol')))walk(list);continue;}
      if(node.matches('p,h1,h2,h3,h4,h5,h6,blockquote')){result.push(node);continue;}
      if(node.tagName==='DIV') {
        if(Array.from(node.children).some(el=>el.matches('p,div,ul,ol,h1,h2,h3,h4,blockquote')&&!el.matches('.item-thread')))walk(node);
        else result.push(node);
      }
    }
  }
  walk(editor);return result;
}
function itemText(item) {
  const copy=item.cloneNode(true);$$('.item-reply-actions,.item-thread,.task-completion,.task-stamp,ul,ol,input',copy).forEach(el=>el.remove());
  return (copy.textContent||'').replace(/\u200b/g,'').replace(/\s+/g,' ').trim();
}
function itemCaption(item) {return itemText(item).slice(0,90)||'this item';}
function countReplies(replies=[]) {return replies.reduce((count,r)=>count+1+countReplies(r.replies||[]),0);}
function findReply(replies,id) {for(const r of replies||[]){if(r.id===id)return r;const nested=findReply(r.replies,id);if(nested)return nested;}return null;}
function linkedItem(id) {return itemNodes().find(el=>el.dataset.itemId===id);}
function threadPanel(id) {return $$('.item-thread').find(el=>el.dataset.threadFor===id);}
function placeThread(item,panel) {
  if(item.tagName==='LI') {const children=Array.from(item.children),list=children.find(el=>el.matches('ul,ol'));if(list){if(panel.nextElementSibling!==list)item.insertBefore(panel,list);}else if(panel.parentElement!==item||item.lastElementChild!==panel)item.appendChild(panel);}
  else if(item.nextElementSibling!==panel)item.after(panel);
}
function threadEntries(replies,itemId) {
  return replies.map(r=>{const p=r.authorName?{short:r.authorName}:personById(r.authorId);return '<article class="item-reply" data-reply-id="'+r.id+'"><div class="reply-meta"><strong>'+escape(p.short)+'</strong><time datetime="'+r.at+'" title="'+escape(fullTime(r.at))+'">'+shortTime(r.at)+'</time><button class="reply-nested" data-parent-reply="'+r.id+'" data-reply-item="'+itemId+'" aria-label="Reply to '+escape(p.short)+'">'+icon('reply')+'</button></div><p class="reply-text">'+replyText(r)+'</p>'+(r.replies?.length?'<div class="reply-children">'+threadEntries(r.replies,itemId)+'</div>':'')+'</article>';}).join('');
}
const replyDraftTags=new WeakMap();
function shiftReplyTags(tags,start,end,delta) {
  return tags.flatMap(tag=>{
    if(tag.end<=start)return [tag];
    if(tag.start>=end)return [{...tag,start:tag.start+delta,end:tag.end+delta}];
    return [];
  });
}
function updateReplyDraftTags(input) {
  const draft=replyDraftTags.get(input);
  if(!draft)return [];
  const before=draft.value,after=input.value;
  if(before===after)return draft.tags;
  let start=0,end=before.length,afterEnd=after.length;
  while(start<end&&start<afterEnd&&before[start]===after[start])start++;
  while(end>start&&afterEnd>start&&before[end-1]===after[afterEnd-1]){end--;afterEnd--;}
  const tags=shiftReplyTags(draft.tags,start,end,after.length-before.length);
  replyDraftTags.set(input,{value:after,tags});
  return tags;
}
function sizeReplyInput(input) {
  if(!input||!input.isConnected)return;
  input.style.height='auto';
  const styles=getComputedStyle(input),borders=(parseFloat(styles.borderTopWidth)||0)+(parseFloat(styles.borderBottomWidth)||0);
  input.style.height=Math.max(31,input.scrollHeight+borders)+'px';
}
function renderItemThread(id,force=false) {
  const item=linkedItem(id),n=note();if(!item||!n||!isShared(n))return;
  let panel=threadPanel(id);if(panel&&!force){placeThread(item,panel);sizeReplyInput($('.reply-input',panel));return panel;}
  let draft='',tags=[],focused=false,start=0,end=0;
  if(panel){const input=$('.reply-input',panel);draft=input?.value||'';tags=input?updateReplyDraftTags(input):[];focused=input===document.activeElement;start=input?.selectionStart||0;end=input?.selectionEnd||0;}
  else {panel=document.createElement('div');panel.className='item-thread';panel.contentEditable='false';panel.dataset.threadFor=id;}
  const targetId=replyTargets[n.id+':'+id],target=targetId?findReply(n.itemThreads[id],targetId):null;
  panel.innerHTML='<div class="thread-entries">'+threadEntries(n.itemThreads[id]||[],id)+'</div>'+(target?'<div class="reply-target">Replying to '+escape(target.authorName||personById(target.authorId).short)+'<button class="clear-reply-target" data-clear-target="'+id+'" aria-label="Cancel nested reply">×</button></div>':'')+'<form class="item-reply-form" data-thread-item="'+id+'"><textarea class="reply-input" aria-label="Reply to '+escape(itemCaption(item))+'" placeholder="Reply · @mention" spellcheck="true" maxlength="2000" rows="1" wrap="soft">'+escape(draft)+'</textarea><button class="submit-reply" aria-label="Add reply" title="Add reply">'+icon('post')+'</button></form>';
  placeThread(item,panel);
  decorateTags(panel);
  const input=$('.reply-input',panel);
  if(tags.length)replyDraftTags.set(input,{value:draft,tags});
  sizeReplyInput(input);
  if(focused){input.focus({preventScroll:true});input.setSelectionRange(start,end);}
  return panel;
}
function normalizeSharedItems() {
  const editor=$('.note-content'),n=note();if(!editor||!n)return;
  if(editor.dataset.formattingTransaction==='true')return;
  const sel=getSelection(),anchor=sel?.anchorNode,focus=sel?.focusNode,anchorOffset=sel?.anchorOffset,focusOffset=sel?.focusOffset;
  const keepSelection=anchor&&focus&&editor.contains(anchor)&&editor.contains(focus)&&!anchor.parentElement?.closest('.item-thread')&&!document.activeElement?.closest('.item-thread');
  const items=itemNodes(editor,true),ids=new Set();n.itemThreads ||= {};n.openThreads ||= [];
  for(const item of items) {
    let id=item.dataset.itemId||item.dataset.taskId;
    if(!id||ids.has(id))id=uid('item');item.dataset.itemId=id;ids.add(id);
    const hasText=!!itemText(item);
    // Native deletion may leave an empty paragraph with its old id. Clearing
    // the item must still delete the thread before that paragraph is reused.
    if(!hasText){delete n.itemThreads[id];delete replyTargets[n.id+':'+id];n.openThreads=n.openThreads.filter(x=>x!==id);}
    const owned=selector=>$$(selector,item).filter(el=>el.closest('[data-item-id]')===item);
    if(item.matches('.note-check')) {
      item.dataset.taskId ||= id;
      owned('.task-stamp').forEach(el=>el.remove());
      const completions=owned('.task-completion');completions.slice(1).forEach(el=>el.remove());
      let completion=completions[0],box=$(':scope > input[type=checkbox]',item),label=$(':scope > .task-label',item);
      if(label)label.setAttribute('spellcheck','true');
      if(box?.checked&&item.dataset.completedBy&&item.dataset.completedAt) {
        if(!completion){completion=document.createElement('span');completion.className='task-completion';completion.contentEditable='false';}
        if(label&&label.nextSibling!==completion)label.after(completion);
        const who=personById(item.dataset.completedBy),at=item.dataset.completedAt;
        completion.textContent=' — '+who.short+' · '+shortTime(at);completion.title='Completed by '+who.name+' · '+fullTime(at);
      } else completion?.remove();
      updateTaskAccessibleLabel(item);
    } else owned('.task-completion,.task-stamp').forEach(el=>el.remove());
    const actionNodes=owned('.item-reply-actions');actionNodes.slice(1).forEach(el=>el.remove());
    let actions=actionNodes[0];
    if(isShared(n)&&hasText) {
      if(!actions){actions=document.createElement('span');actions.className='item-reply-actions';actions.contentEditable='false';actions.innerHTML='<button class="item-reply-button" type="button">'+icon('reply')+'<span class="item-reply-count"></span></button>';}
      const list=Array.from(item.children).find(el=>el.matches('ol,ul'));
      if(list){if(actions.parentElement!==item||actions.nextElementSibling!==list)item.insertBefore(actions,list);}
      else if(actions.parentElement!==item||item.lastElementChild!==actions)item.appendChild(actions);
      const button=$('button',actions),count=countReplies(n.itemThreads[id]);button.dataset.itemReply=id;button.setAttribute('aria-label','Reply to '+itemCaption(item));button.setAttribute('aria-expanded',String(n.openThreads.includes(id)));button.title=count?count+' repl'+(count===1?'y':'ies'):'Reply to this item';$('.item-reply-count',actions).textContent=count||'';
    } else actions?.remove();
  }
  // The stable item id owns its whole reply tree. Removed items lose every descendant reply.
  for(const id of Object.keys(n.itemThreads))if(!ids.has(id)){delete n.itemThreads[id];delete replyTargets[n.id+':'+id];}
  n.openThreads=n.openThreads.filter(id=>ids.has(id));
  $$('.item-thread',editor).forEach(panel=>{if(!ids.has(panel.dataset.threadFor)||!isShared(n)||!n.openThreads.includes(panel.dataset.threadFor))panel.remove();});
  if(isShared(n))for(const id of n.openThreads)renderItemThread(id);
  if(keepSelection&&anchor.isConnected&&focus.isConnected)try{sel.setBaseAndExtent(anchor,Math.min(anchorOffset,anchor.nodeType===Node.TEXT_NODE?anchor.length:anchor.childNodes.length),focus,Math.min(focusOffset,focus.nodeType===Node.TEXT_NODE?focus.length:focus.childNodes.length));}catch{}
}
function toggleItemThread(id) {
  const n=note();if(!n||!linkedItem(id))return;
  syncEditor();closeMentions();
  if(n.openThreads.includes(id)){n.openThreads=n.openThreads.filter(x=>x!==id);threadPanel(id)?.remove();}
  else {n.openThreads.push(id);renderItemThread(id);$('.reply-input',threadPanel(id))?.focus();}
  normalizeSharedItems();save();
}
function submitItemReply(form) {
  const id=form.dataset.threadItem,n=note(),input=$('.reply-input',form),visibleText=input.value.trim();
  if(!n||!linkedItem(id)||!isShared(n)||!visibleText)return;
  const leading=input.value.length-input.value.trimStart().length;
  let text='',offset=0;
  const mentions=updateReplyDraftTags(input).map(tag=>{
    const start=tag.start-leading,end=tag.end-leading;
    text+=visibleText.slice(offset,start);
    const savedStart=text.length;
    text+='@'+visibleText.slice(start,end);
    offset=end;
    return {...tag,start:savedStart,end:text.length};
  });
  const reply={id:uid('reply'),authorId:currentPerson,at:new Date().toISOString(),text:text+visibleText.slice(offset),mentions,replies:[]};
  markEdited(n);
  n.itemThreads[id] ||= [];
  const targetId=replyTargets[n.id+':'+id],target=targetId?findReply(n.itemThreads[id],targetId):null;
  if(target){target.replies ||= [];target.replies.push(reply);}else n.itemThreads[id].push(reply);
  input.value='';replyDraftTags.delete(input);delete replyTargets[n.id+':'+id];closeMentions();renderItemThread(id,true);normalizeSharedItems();syncEditor();$('.reply-input',threadPanel(id))?.focus();
}

function updateTaskAccessibleLabel(row) {const input=$('input[type=checkbox]',row),label=$('.task-label',row);if(input&&label)input.setAttribute('aria-label',(input.checked?'Mark incomplete: ':'Mark done: ')+(label.textContent||'Checklist item').trim());}
function completeTask(box) {
  const row=box.closest('.note-check'),n=note();if(!row||!n)return;
  const at=new Date().toISOString(),who=actor();
  markEdited(n);
  row.dataset.taskId ||= row.dataset.itemId||uid('task');
  box.toggleAttribute('checked',box.checked);
  if(box.checked){row.dataset.completedBy=who.id;row.dataset.completedAt=at;}
  else {delete row.dataset.completedBy;delete row.dataset.completedAt;}
  n.completionEvents.push({taskId:row.dataset.taskId,completed:box.checked,by:who.id,at});n.updatedAt=at;
  normalizeSharedItems();updateTaskAccessibleLabel(row);syncEditor();
}

let mentionChoices=[], tagDirectory=[], mentionTimer;
const workOrderTags=new Map();
const workOrderTagLabel=value=>{
  const match=String(value).trim().match(/^(?:workorder_|WO\s*[#-]?\s*)?(\d+)$/i);
  return match?'WO#'+match[1]:'';
};
function refreshMentionChoices() {
  mentionChoices=[
    ...people.filter(isSelectableRecipient).map(p=>({id:p.id,label:p.name,kind:'person',detail:p.displayRole||p.role})),
    {id:'engineering',label:'Engineering',kind:'department',detail:'Chief Engineer + technician'},
    {id:'all',label:'All Roles',kind:'role',detail:'Everyone'},
    ...roles.map(r=>({id:r.id,label:r.label,kind:'role',detail:'Role'})),
    ...tagDirectory,
  ];
}
function loadTagDirectory() {
  const generation=accountGeneration;
  void hostRequest('tag-directory',{}).then(targets=>{
    if(generation!==accountGeneration)return;
    tagDirectory=targets.map(target=>({...target,detail:target.kind==='location'
      ? target.description||'Location' : 'Front Desk name'}));
    refreshMentionChoices();
    decorateTags($('.note-content'));
    const input=mentionSession?.input;
    if(mentionSession){closeMentions();if(input)detectReplyMention(input);else detectMention();}
  }).catch(()=>{});
}
function ticketTag(row) {
  const label=workOrderTagLabel(row.display_id);
  return label?{id:row.id,kind:'work_order',label,detail:row.issue||'Work order'}:null;
}
function resolveWorkOrderTag(id) {
  if(workOrderTags.has(id))return workOrderTags.get(id);
  const generation=accountGeneration;
  const pending=hostRequest('tag-work-orders',{id}).then(rows=>{
    const row=rows.find(row=>row.id===id);
    return generation===accountGeneration&&row?ticketTag(row):null;
  }).catch(()=>null);
  workOrderTags.set(id,pending);
  return pending;
}
function tagRecord(chip) {
  const {mentionKind:kind,mentionId:id}=chip.dataset;
  return mentionChoices.find(choice=>choice.kind===kind&&choice.id===id);
}
function setTagTitle(chip,record) {
  const kind={person:'Person',role:'Role',department:'Engineering department',front_desk_name:'Front Desk name',location:'Location',work_order:'Work order'}[record.kind];
  chip.title=kind+' · '+(record.kind==='person'||record.kind==='front_desk_name'?record.label:record.detail==='Role'?record.label:record.detail);
  chip.tabIndex=0;
  chip.setAttribute('role','button');
}
function decorateTags(root) {
  if(!root)return;
  for(const chip of $$(storedTagSelector,root)){
    const record=tagRecord(chip);
    if(record)setTagTitle(chip,record);
    else if(chip.dataset.mentionKind==='work_order'&&attachmentUUID.test(chip.dataset.mentionId)){
      void resolveWorkOrderTag(chip.dataset.mentionId).then(target=>{if(chip.isConnected&&target)setTagTitle(chip,target);});
    }
  }
}
function openTag(chip) {
  if(chip.dataset.mentionKind==='work_order'){sendHost('openWorkOrder',{id:chip.dataset.mentionId});return;}
  const record=tagRecord(chip);
  if(!record)return;
  const group=record.kind==='role'||record.kind==='department';
  const recipients=group?people.filter(person=>person.active&&(record.id==='all'
    || (record.kind==='department'?person.roles.some(role=>role==='engineer'||role==='technician'):person.roles.includes(record.id)))):[];
  const dialog=document.createElement('dialog');
  dialog.className='tag-details';dialog.setAttribute('aria-label',record.label);
  const title=document.createElement('h2');title.textContent=record.label;
  const description=document.createElement('p');description.textContent=record.detail;
  const close=document.createElement('button');close.type='button';close.textContent='Close';
  close.addEventListener('click',()=>dialog.close());
  dialog.append(title,description,close);
  if(group){
    const list=document.createElement('ul');list.setAttribute('aria-label','Recipients');
    for(const person of recipients){const item=document.createElement('li');item.textContent=person.name;list.append(item);}
    if(!recipients.length){const item=document.createElement('li');item.textContent='No recipients to display.';list.append(item);}
    dialog.insertBefore(list,close);
  }
  dialog.addEventListener('close',()=>{dialog.remove();if(chip.isConnected)chip.focus();},{once:true});
  document.body.append(dialog);dialog.showModal();
}
function closeMentions(){clearTimeout(mentionTimer);mentionSession=null;$('#mention-layer').innerHTML='';$('.note-content')?.removeAttribute('aria-activedescendant');}
function matchTagQuery(before) {
  const at=before.match(/(?:^|[\s\u00a0])@([^@\n]{0,200})$/);
  if(at)return {term:at[1],length:at[1].length+1,explicit:false};
  const explicit=before.match(/(?:^|\s)(WO#\d{1,30})$/i);
  return explicit?{term:explicit[1],length:explicit[1].length,explicit:true}:null;
}
function startMention(session,query) {
  const current=mentionSession;
  if(current?.term===query.term&&current.explicit===query.explicit&&current.input===session.input
    &&(session.input?current.start===session.start:current.range.startContainer===session.range.startContainer&&current.range.startOffset===session.range.startOffset))return;
  closeMentions();
  const term=query.term.toLowerCase();
  const choices=query.explicit?[]:mentionChoices.filter(c=>(c.label+' '+c.detail).toLowerCase().includes(term)).slice(0,8);
  const active={...session,...query,choices,index:0};
  mentionSession=active;
  if(choices.length)renderMentions();
  if(!term.trim())return;
  mentionTimer=setTimeout(()=>{
    void hostRequest('tag-work-orders',{query:query.term,exact:query.explicit}).then(rows=>{
      if(mentionSession!==active)return;
      const tickets=rows.map(ticketTag).filter(Boolean);
      if(query.explicit) {
        const number=query.term.toUpperCase();
        active.choices=tickets.filter(ticket=>ticket.label===number).slice(0,8);
      } else {
        active.choices=[...choices.slice(0,tickets.length?5:8),...tickets].slice(0,8);
      }
      for(const ticket of active.choices)if(ticket.kind==='work_order')workOrderTags.set(ticket.id,Promise.resolve(ticket));
      if(active.choices.length)renderMentions();
    }).catch(()=>{});
  },120);
}
function detectMention() {
  if(isComposing)return;
  const sel=getSelection(),content=$('.note-content');
  if(mode!=='text'||!sel?.rangeCount||!sel.isCollapsed||!content?.contains(sel.anchorNode)||sel.anchorNode.nodeType!==Node.TEXT_NODE){closeMentions();return;}
  const query=matchTagQuery(sel.anchorNode.textContent.slice(0,sel.anchorOffset));
  if(!query){closeMentions();return;}
  const range=sel.getRangeAt(0).cloneRange();range.setStart(sel.anchorNode,sel.anchorOffset-query.length);
  startMention({range},query);
}
function renderMentions() {
  const s=mentionSession;if(!s)return;
  $('#mention-layer').innerHTML='<div class="mention-popover" role="listbox" aria-label="Tag a person, group, location, or work order">'+s.choices.map((c,i)=>'<button class="mention-option" id="mention-option-'+i+'" data-mention-choice="'+i+'" role="option" aria-selected="'+(i===s.index)+'"><strong>'+escape(c.label)+'</strong><small>'+escape(c.detail)+'</small></button>').join('')+'</div>';
  const el=$('.mention-popover'),rect=s.input?s.input.getBoundingClientRect():s.range.getBoundingClientRect(),area=$('.note-content').getBoundingClientRect();
  const left=rect.width||rect.height?rect.left:area.left+4,top=rect.height?rect.bottom:area.top+22;
  el.style.left=Math.max(5,Math.min(innerWidth-el.offsetWidth-5,left))+'px';el.style.top=Math.max(5,Math.min(innerHeight-el.offsetHeight-5,top+2))+'px';
  $('.note-content').setAttribute('aria-activedescendant','mention-option-'+s.index);
}
function insertMention(index) {
  const s=mentionSession,c=s?.choices[index];if(!c)return;
  if(s.input) {
    const input=s.input,value=c.label+' ';
    const tags=shiftReplyTags(updateReplyDraftTags(input),s.start,s.end,value.length-(s.end-s.start));
    input.value=input.value.slice(0,s.start)+value+input.value.slice(s.end);
    tags.push({id:c.id,kind:c.kind,start:s.start,end:s.start+value.length-1});
    tags.sort((a,b)=>a.start-b.start);
    replyDraftTags.set(input,{value:input.value,tags});
    input.focus();input.setSelectionRange(s.start+value.length,s.start+value.length);sizeReplyInput(input);closeMentions();return;
  }
  markEdited();
  const range=s.range;range.deleteContents();const chip=document.createElement('span');chip.className='mention';chip.setAttribute('contenteditable','false');chip.dataset.mentionId=c.id;chip.dataset.mentionKind=c.kind;if(c.kind!=='location')chip.dataset.npTagPrefix='';chip.textContent=c.label;setTagTitle(chip,c);range.insertNode(chip);
  const space=document.createTextNode('\u00a0');chip.after(space);range.setStartAfter(space);range.collapse(true);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);selectionRange=range.cloneRange();closeMentions();normalizeSharedItems();syncEditor();
}
function moveNote(id,targetId,after=false) {
  if(!targetId||id===targetId)return;
  const visible=orderedNotes().map(n=>n.id),order=visible.filter(n=>n!==id),at=order.indexOf(targetId);if(at<0)return;
  order.splice(at+(after?1:0),0,id);orders[currentPerson]=order;save();refreshSidebar();
  $('#reorder-status').textContent='Moved '+(notes.find(n=>n.id===id)?.title||'Untitled')+' to position '+(order.indexOf(id)+1)+'.';
}
function clearDragMarks() {$$('.note-row').forEach(r=>{r.classList.remove('is-dragging');r.removeAttribute('data-drop-position');});}
function markDrop(row,y) {$$('.note-row[data-drop-position]').forEach(r=>r.removeAttribute('data-drop-position'));if(!row)return;const r=row.getBoundingClientRect();row.dataset.dropPosition=y>r.top+r.height/2?'after':'before';}
function toolBubble(anchor,tool) {
  if(tool!=='pen')return;
  const swatches='<div class="color-swatches" aria-label="Ink color">'+colors.map(([name,color])=>'<button type="button" data-color="'+color+'" data-color-mode="pen" aria-label="'+name+' ink" title="'+name+'" aria-pressed="'+(inkColor===color)+'" style="background:'+color+';--swatch-check:'+(['Orange','Yellow','White'].includes(name)?'#000000':'#ffffff')+'"></button>').join('')+'</div>';
  showPopover('<label class="width-control"><span>Stroke</span><input type="range" aria-label="Pen width" min="1" max="12" step="1" value="'+penWidth+'" style="--pen-size:'+penWidth+'px"><output>'+penWidth+'</output></label>'+swatches,anchor,'tool-bubble');
}
function changeMode(next,anchor) {
  rememberSelection();closeMentions();
  const same=mode===next&&!!$('.tool-bubble');closePopover();setMode(next);
  if(next==='text')$('.note-content')?.focus();
  if(next==='pen'&&!same)toolBubble(anchor,next);
}
function replyText({text,mentions}) {
  if(Array.isArray(mentions)){
    let start=0,result='';
    for(const tag of mentions){
      result+=escape(text.slice(start,tag.start))+'<span class="mention" data-mention-kind="'+escape(tag.kind)+'" data-mention-id="'+escape(tag.id)+'">'+escape(text.slice(tag.start,tag.end).replace(/^@/,''))+'</span>';
      start=tag.end;
    }
    return result+escape(text.slice(start));
  }
  return escape(text);
}

function detectReplyMention(input) {
  const query=matchTagQuery(input.value.slice(0,input.selectionStart));
  if(!query){closeMentions();return;}
  startMention({input,start:input.selectionStart-query.length,end:input.selectionStart},query);
}
function closeDelete({restoreFocus=true}={}) {
  const session=deleteSession;if(!session)return;
  deleteGesture=null;deleteSession=null;session.dialog.close();session.dialog.remove();
  if(restoreFocus&&session.generation===accountGeneration&&session.origin?.isConnected)session.origin.focus({preventScroll:true});
}
function openDelete(origin) {
  const n=note();if(!initialized||!n)return;
  if(n.authorId!==currentPerson){toast('Only the note’s creator can delete it.');return;}
  finishTitleEdit();syncEditor();closePopover();closeMentions();closeDelete({restoreFocus:false});
  const dialog=document.createElement('dialog');dialog.className='delete-dialog';dialog.setAttribute('aria-labelledby','delete-heading');dialog.setAttribute('aria-describedby','delete-message');
  dialog.innerHTML='<h2 id="delete-heading">Delete this note</h2><p id="delete-message">Remove <strong>'+escape(n.title||'Untitled')+'</strong> from Notepad</p><div class="delete-actions"><button type="button" data-action="cancel-delete">Cancel</button><button type="button" data-action="confirm-delete">Delete</button></div>';
  deleteSession={dialog,origin,noteId:n.id,generation:accountGeneration};
  dialog.addEventListener('cancel',e=>{e.preventDefault();closeDelete();});
  dialog.addEventListener('pointerdown',e=>{
    if(e.button!==0||e.target.closest('button,input,textarea,select,a'))return;
    e.preventDefault();const rect=dialog.getBoundingClientRect();
    deleteGesture={dialog,pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,left:rect.left,top:rect.top,width:rect.width,height:rect.height};
    dialog.setPointerCapture(e.pointerId);
  });
  document.body.append(dialog);dialog.showModal();$('[data-action=cancel-delete]',dialog).focus();
}
function confirmDelete() {
  const session=deleteSession;if(!session||!initialized||session.generation!==accountGeneration)return;
  const n=notes.find(item=>item.id===session.noteId);if(!n||n.authorId!==currentPerson)return;
  closeDelete({restoreFocus:false});
  if(activeNote===n.id){inkController?.destroy();inkController=null;activeNote='';}
  notes=notes.filter(item=>item.id!==n.id);Object.keys(orders).forEach(key=>orders[key]=orders[key].filter(id=>id!==n.id));render();
}
function closeHistory() {
  historyController?.close();
  historyController=null;
}
function openHistory(button) {
  if(!note()||!window.NotepadHistory)return;
  if(historyController){closeHistory();return;}
  closeMentions();
  closePopover();
  void attachmentController?.close({restoreFocus:false});
  const id=activeNote;
  historyController=window.NotepadHistory.attach({
    panel:$('#note-history'),trigger:button,onClose:closeHistory,
    load:before=>hostRequest('history',{id,before}),
    personName:id=>personById(id).name,audienceName:audienceLabel,formatDate:fullTime,
  });
}
function handleAction(action,button) {
  switch(action) {
    case 'new':openRecipients('new',button);break;
    case 'share':openRecipients('share',button);break;
    case 'open-history':openHistory(button);break;
    case 'cancel-recipients':closeRecipients();break;
    case 'close-popover':closePopover();break;
    case 'delete':openDelete(button);break;
    case 'cancel-delete':closeDelete();break;
    case 'confirm-delete':confirmDelete();break;
    case 'undo':inkController?.undo();break;
    case 'redo':inkController?.redo();break;
    case 'minimize':syncEditor();$('#notepad-modal').classList.toggle('is-minimized');break;
    case 'maximize':$('.stage').classList.toggle('is-expanded');button.setAttribute('aria-label',$('.stage').classList.contains('is-expanded')?'Restore Notepad size':'Expand Notepad');break;
    case 'close-window':syncEditor();$('#notepad-modal').hidden=true;$('#reopen-window').hidden=false;$('.stage').classList.remove('is-expanded');break;
    case 'reopen-window':$('#notepad-modal').hidden=false;$('#reopen-window').hidden=true;break;
  }
}
let blankLineGesture=null;
function lastWritingPosition(editor) {
  const range=document.createRange();
  function endOf(node) {
    if(node.nodeType===Node.TEXT_NODE){
      if(!node.length||(!node.textContent.trim()&&node.parentElement?.matches('.note-content,ul,ol')))return false;
      range.setStart(node,node.length);return true;
    }
    if(node.nodeType!==Node.ELEMENT_NODE||node.matches('.item-thread,.item-reply-actions,.task-completion,.task-stamp,input,button'))return false;
    if(node.matches('.note-check')){const label=$(':scope > .task-label',node);return label?endOf(label):false;}
    if(node.matches('.mention')){range.setStartAfter(node);return true;}
    if(node.getAttribute('contenteditable')==='false')return false;
    if(node.tagName==='BR'){range.setStartBefore(node);return true;}
    for(let child=node.lastChild;child;child=child.previousSibling)if(endOf(child))return true;
    if(node===editor||node.matches('p,div,li,h1,h2,h3,h4,h5,h6,blockquote,.task-label')){range.setStart(node,0);return true;}
    return false;
  }
  if(!endOf(editor))range.setStart(editor,0);
  range.collapse(true);
  const point=range.getBoundingClientRect();
  if(point.height)return {range,bottom:point.bottom};
  if(range.startContainer.nodeType===Node.ELEMENT_NODE){
    const next=range.startContainer.childNodes[range.startOffset];
    if(next?.nodeType===Node.ELEMENT_NODE&&next.tagName==='BR'){
      const rect=next.getBoundingClientRect();if(rect.height)return {range,bottom:rect.bottom};
    }
  }
  const element=range.startContainer.nodeType===Node.ELEMENT_NODE?range.startContainer:range.startContainer.parentElement;
  const line=element?.closest('.task-label,p,li,h1,h2,h3,h4,h5,h6,blockquote,div');
  if(line&&line!==editor&&editor.contains(line)){const rect=line.getBoundingClientRect();if(rect.height)return {range,bottom:rect.bottom};}
  const style=getComputedStyle(editor),rect=editor.getBoundingClientRect();
  const height=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.5||24;
  return {range,bottom:rect.top+(parseFloat(style.paddingTop)||0)+height};
}
function rememberBlankLineClick(event) {
  blankLineGesture=null;
  const editor=$('.note-content');
  if(mode!=='text'||!editor||event.defaultPrevented||event.button!==0||event.isPrimary===false||event.shiftKey||event.ctrlKey||event.metaKey||event.altKey)return;
  if(!editor.contains(event.target)||event.target.closest('.item-thread,.item-reply-actions,.task-completion,input,button,a'))return;
  if(event.clientY<=lastWritingPosition(editor).bottom+1)return;
  // Let the browser start normal selection. Only a completed click below the
  // text moves to the last existing line; dragging must remain native.
  blankLineGesture={editor,id:activeNote,pointerId:event.pointerId,x:event.clientX,y:event.clientY,moved:false};
}
document.addEventListener('pointermove',event=>{
  const click=blankLineGesture;if(click&&click.pointerId===event.pointerId&&Math.hypot(event.clientX-click.x,event.clientY-click.y)>4)click.moved=true;
});
document.addEventListener('pointerup',event=>{
  const click=blankLineGesture;if(!click||click.pointerId!==event.pointerId)return;
  blankLineGesture=null;
  if(click.moved||Math.hypot(event.clientX-click.x,event.clientY-click.y)>4||mode!=='text'||activeNote!==click.id||!click.editor.isConnected)return;
  const {range}=lastWritingPosition(click.editor),element=range.startContainer.nodeType===Node.ELEMENT_NODE?range.startContainer:range.startContainer.parentElement;
  (element?.closest('[contenteditable="true"]')||click.editor).focus({preventScroll:true});
  const selection=getSelection();selection.removeAllRanges();selection.addRange(range);rememberSelection();
});
document.addEventListener('pointercancel',()=>{blankLineGesture=null;});
document.addEventListener('pointerdown',e=>{
  const target=e.target;
  if(target.closest('.mention-option')){e.preventDefault();return;}
  if($('#popover-layer').children.length&&!target.closest('#popover-layer')&&!popoverAnchor?.contains(target))closePopover();
  if(!target.closest('.mention-popover'))closeMentions();
  const divider=target.closest('.pane-divider');
  if(divider&&e.button===0&&e.isPrimary!==false&&!resizeGesture){
    e.preventDefault();divider.setPointerCapture(e.pointerId);
    resizeGesture={pointerId:e.pointerId,device,x:e.clientX,startX:e.clientX,startWidth:$('.np-sidebar').getBoundingClientRect().width,savedWidth:paneWidths[device],collapsed:device==='mobile'&&mobileSidebarCollapsed,divider};
    return;
  }
  const drag=target.closest('[data-drag-note]');
  if(drag&&e.button===0) {
    suppressNoteClick=false;
    e.preventDefault();drag.setPointerCapture(e.pointerId);pointerDrag={id:drag.dataset.dragNote,startY:e.clientY,pointerId:e.pointerId,handle:drag,moved:false,target:null,after:false};
  }
  if(target.closest('.note-content')){rememberBlankLineClick(e);return;}
  rememberSelection();
  if(target.closest('.tool-bubble')&&target.closest('button'))e.preventDefault();
});
document.addEventListener('pointermove',e=>{
  if(deleteGesture?.pointerId===e.pointerId){
    e.preventDefault();const drag=deleteGesture;
    const left=Math.max(3,Math.min(innerWidth-drag.width-3,drag.left+e.clientX-drag.startX)),top=Math.max(3,Math.min(innerHeight-drag.height-3,drag.top+e.clientY-drag.startY));
    Object.assign(drag.dialog.style,{inset:'auto',margin:'0',left:left+'px',top:top+'px'});return;
  }
  if(resizeGesture?.pointerId===e.pointerId){
    e.preventDefault();previewPaneResize(resizeGesture,e.clientX);return;
  }
  const drag=pointerDrag;if(!drag||drag.pointerId!==e.pointerId)return;
  if(!drag.moved&&Math.abs(e.clientY-drag.startY)<4)return;
  e.preventDefault();drag.moved=true;
  const source=$('[data-row="'+drag.id+'"]');source?.classList.add('is-dragging');
  const list=$('.np-notes-slot'),rect=list.getBoundingClientRect();if(e.clientY<rect.top+16)list.scrollTop-=14;else if(e.clientY>rect.bottom-16)list.scrollTop+=14;
  const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('.note-row');
  if(target&&target.dataset.row!==drag.id){markDrop(target,e.clientY);drag.target=target.dataset.row;drag.after=target.dataset.dropPosition==='after';}
  else {drag.target=null;$$('.note-row[data-drop-position]').forEach(row=>row.removeAttribute('data-drop-position'));}
});
function finishPointerDrag(e) {
  if(deleteGesture?.pointerId===e.pointerId){const dialog=deleteGesture.dialog;deleteGesture=null;if(dialog.hasPointerCapture(e.pointerId))dialog.releasePointerCapture(e.pointerId);return;}
  if(resizeGesture?.pointerId===e.pointerId){
    const drag=resizeGesture;resizeGesture=null;
    if(drag.x!==e.clientX)previewPaneResize(drag,e.clientX);
    if(drag.device!==device&&drag.device==='mobile')mobileSidebarCollapsed=drag.collapsed;
    const keepWidth=drag.device!==device||device==='mobile'&&mobileSidebarCollapsed;
    applyPaneWidth(keepWidth?undefined:drag.width);
    if(drag.divider.hasPointerCapture(e.pointerId))drag.divider.releasePointerCapture(e.pointerId);
    save();return;
  }
  const drag=pointerDrag;if(!drag||drag.pointerId!==e.pointerId)return;pointerDrag=null;
  if(drag.handle.hasPointerCapture(e.pointerId))drag.handle.releasePointerCapture(e.pointerId);
  // Pointer capture can retarget the browser's follow-up click. Complete this
  // gesture here and consume that click so opening a note is reliable once.
  suppressNoteClick=true;
  clearDragMarks();
  if(drag.moved&&drag.target){moveNote(drag.id,drag.target,drag.after);$('[data-drag-note="'+drag.id+'"]')?.focus();}
  else if(!drag.moved&&drag.handle.isConnected){
    const bounds=drag.handle.getBoundingClientRect();
    if(e.clientX>=bounds.left&&e.clientX<=bounds.right&&e.clientY>=bounds.top&&e.clientY<=bounds.bottom){drag.handle.focus({preventScroll:true});void selectNote(drag.id);}
  }
}
document.addEventListener('pointerup',finishPointerDrag);
document.addEventListener('pointercancel',e=>{
  if(deleteGesture?.pointerId===e.pointerId)deleteGesture=null;
  if(pointerDrag?.pointerId===e.pointerId){pointerDrag=null;clearDragMarks();}
  if(resizeGesture?.pointerId===e.pointerId){
    const drag=resizeGesture;resizeGesture=null;
    if(drag.device==='mobile')mobileSidebarCollapsed=drag.collapsed;
    applyPaneWidth();save();
  }
});
document.addEventListener('dblclick',e=>{if(e.target.closest('.pane-divider')){if(device==='mobile')mobileSidebarCollapsed=false;applyPaneWidth(device==='mobile'?110:220);save();}});
document.addEventListener('focusin',e=>{
  if(e.target.matches('#note-title'))startTitleEdit(e.target);
  if(e.target.closest('.notepad-formatting')&&mode!=='text')setMode('text');
});
document.addEventListener('dragstart',e=>{
  const row=e.target.closest('.note-row');if(!row||pointerDrag){e.preventDefault();return;}
  draggedNote=row.dataset.row;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',draggedNote);row.classList.add('is-dragging');
});
document.addEventListener('dragover',e=>{if(!draggedNote)return;const row=e.target.closest('.note-row');if(row){e.preventDefault();e.dataTransfer.dropEffect='move';markDrop(row,e.clientY);}});
document.addEventListener('drop',e=>{if(!draggedNote)return;const row=e.target.closest('.note-row');if(row){e.preventDefault();moveNote(draggedNote,row.dataset.row,row.dataset.dropPosition==='after');}draggedNote=null;clearDragMarks();});
document.addEventListener('dragend',()=>{draggedNote=null;clearDragMarks();});
document.addEventListener('click',e=>{
  const tag=e.target.closest('.note-content '+storedTagSelector+'[role="button"]');
  if(tag){e.preventDefault();openTag(tag);return;}
  const attachment=e.target.closest('[data-open-inline-attachment]');
  if(attachment){
    e.preventDefault();closeAttachmentPreview();
    const file=note()?.attachments.find(item=>item.id===attachment.dataset.openInlineAttachment);
    if(file)void attachmentController?.openAttachment(file,attachment);
    return;
  }
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.mentionChoice!==undefined){insertMention(Number(b.dataset.mentionChoice));return;}
  if(b.hasAttribute('data-toggle-formatting')){setMobileFormatting(!mobileFormattingExpanded);return;}
  if(b.dataset.itemReply){toggleItemThread(b.dataset.itemReply);return;}
  if(b.dataset.parentReply){const id=b.dataset.replyItem;replyTargets[note().id+':'+id]=b.dataset.parentReply;renderItemThread(id,true);$('.reply-input',threadPanel(id))?.focus();return;}
  if(b.dataset.clearTarget){const id=b.dataset.clearTarget;delete replyTargets[note().id+':'+id];renderItemThread(id,true);$('.reply-input',threadPanel(id))?.focus();return;}
  if(b.dataset.note){const suppress=suppressNoteClick&&e.detail>0;suppressNoteClick=false;if(suppress){e.preventDefault();return;}selectNote(b.dataset.note);return;}
  if(b.dataset.mode){changeMode(b.dataset.mode,b);return;}
  if(b.dataset.color) {
    if(b.dataset.colorMode==='pen'){inkColor=b.dataset.color;}
    else{textColor=b.dataset.color;markEdited();restoreSelection();document.execCommand('foreColor',false,textColor);syncEditor();}
    $$('.color-swatches button').forEach(el=>el.setAttribute('aria-pressed',String(el===b)));return;
  }
  if(b.dataset.removeInlineAttachment!==undefined){removeNoteAttachment(b.dataset.removeInlineAttachment);return;}
  if(b.dataset.openAttachment!==undefined){const file=note()?.attachments[Number(b.dataset.openAttachment)];if(file)void attachmentController?.openAttachment(file,b);return;}
  if(b.dataset.removeAttachment!==undefined){const file=note()?.attachments[Number(b.dataset.removeAttachment)];if(file)removeNoteAttachment(file.id);return;}
  if(b.dataset.action)handleAction(b.dataset.action,b);
});
document.addEventListener('input',e=>{
  const t=e.target;
  if(t.matches('#note-title')){
    if(startTitleEdit(t))titleEdit.changed||=t.value!==titleEdit.original;
    else if(note())t.value=note().title;
    sizeNoteTitle();
    return;
  }
  if(t.closest('.note-content')&&!t.closest('.item-thread')){markEdited();if(!e.isComposing&&!isComposing)normalizeSharedItems();note().updatedAt=new Date().toISOString();if(t.closest('.note-check'))updateTaskAccessibleLabel(t.closest('.note-check'));syncEditor();if(!e.isComposing)detectMention();}
  if(t.matches('.search-box input')){query=t.value;refreshSidebar();}
  if(t.matches('.width-control input')){penWidth=Number(t.value);t.style.setProperty('--pen-size',penWidth+'px');const out=t.parentElement.querySelector('output');if(out)out.value=penWidth;}
  if(t.matches('.reply-input')){updateReplyDraftTags(t);sizeReplyInput(t);if(!e.isComposing&&!isComposing)detectReplyMention(t);}
});
document.addEventListener('change',e=>{
  const t=e.target;
  if(t.matches('[data-recipient]'))changeRecipient(t);
  if(t.matches('.note-check input[type=checkbox]'))completeTask(t);
  if(t.matches('#note-priority')){markEdited();note().priority=t.value;$('.note-heading .note-urgent').hidden=t.value!=='Urgent';sizeNoteTitle();save();refreshSidebar();}
  if(t.matches('.obsolete-text-settings select')){
    textSize=Number(t.value);restoreSelection();const sel=getSelection();
    if(sel?.rangeCount&&!sel.isCollapsed){document.execCommand('fontSize',false,'7');$$('.note-content font[size="7"]').forEach(f=>{f.removeAttribute('size');f.style.fontSize=textSize+'px';});}
    else $('.note-content').style.fontSize=textSize+'px';syncEditor();
  }
});
document.addEventListener('submit',e=>{
  if(e.target.id==='recipient-form'){e.preventDefault();finishRecipients();return;}
  if(!e.target.matches('.item-reply-form'))return;
  e.preventDefault();submitItemReply(e.target);
});
document.addEventListener('paste',e=>{
  if(!e.target.closest('.note-content')||e.target.closest('.item-thread'))return;e.preventDefault();markEdited();document.execCommand('insertText',false,e.clipboardData.getData('text/plain'));syncEditor();
});

document.addEventListener('keydown',e=>{
  if(e.defaultPrevented||e.isComposing||isComposing||e.keyCode===229)return;
  if(titleEdit){
    const cancel=e.key==='Escape'&&inTitleEditor(e.target);
    const accept=e.key==='Enter'&&!e.shiftKey&&e.target===titleEdit.input;
    if(cancel||accept){
      if(cancel&&window.CSS?.supports?.('selector(:open)')&&e.target.closest('select:open'))return;
      e.preventDefault();finishTitleEdit(cancel);restoreSelection();return;
    }
  }
  if(e.target.matches('.pane-divider')&&(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)||device==='mobile'&&e.key==='Enter')){
    e.preventDefault();const current=Number(e.target.getAttribute('aria-valuenow'));
    if(device==='mobile'&&(e.key==='Enter'||e.key==='Home'||mobileSidebarCollapsed&&e.key==='ArrowRight')){
      mobileSidebarCollapsed=e.key==='Enter'?!mobileSidebarCollapsed:e.key==='Home';applyPaneWidth();
    }else if(device!=='mobile'||!mobileSidebarCollapsed||e.key==='End'){
      if(device==='mobile')mobileSidebarCollapsed=false;
      applyPaneWidth(e.key==='Home'?Number(e.target.getAttribute('aria-valuemin')):e.key==='End'?Number(e.target.getAttribute('aria-valuemax')):current+(e.key==='ArrowRight'?8:-8));
    }
    save();return;
  }
  const tag=e.target.closest('.note-content '+storedTagSelector+'[role="button"]');
  if(tag&&['Enter',' '].includes(e.key)){e.preventDefault();openTag(tag);return;}
  if(mentionSession?.choices.length&&['ArrowDown','ArrowUp','Enter','Tab','Escape'].includes(e.key)) {
    e.preventDefault();if(e.key==='Escape'){closeMentions();return;}
    if(e.key==='Enter'||e.key==='Tab'){insertMention(mentionSession.index);return;}
    const s=mentionSession;s.index=(s.index+(e.key==='ArrowDown'?1:-1)+s.choices.length)%s.choices.length;renderMentions();return;
  }
  const handle=e.target.closest('[data-drag-note]');
  if(handle&&e.altKey&&['ArrowUp','ArrowDown'].includes(e.key)) {
    e.preventDefault();const id=handle.dataset.dragNote,list=filteredNotes(),at=list.findIndex(n=>n.id===id),other=list[at+(e.key==='ArrowDown'?1:-1)];
    if(other){moveNote(id,other.id,e.key==='ArrowDown');$('[data-drag-note="'+id+'"]')?.focus();}return;
  }
  if(e.key==='Escape') {
    if($('.recipient-dialog')||$('.delete-dialog')||$('.staff-giphy-picker'))return;
    if(historyController){e.preventDefault();closeHistory();return;}
    if($('#popover-layer').children.length){const anchor=popoverAnchor;closePopover();anchor?.focus();return;}
    if(device==='mobile'&&mobileFormattingExpanded&&e.target.closest('.notepad-formatting')){
      e.preventDefault();setMobileFormatting(false);$('[data-toggle-formatting]')?.focus({preventScroll:true});return;
    }
    $('.stage').classList.remove('is-expanded');
  }
});
document.addEventListener('compositionstart',()=>{isComposing=true;closeMentions();});
document.addEventListener('compositionend',e=>{isComposing=false;if(e.target.matches('.reply-input'))detectReplyMention(e.target);else if(e.target.closest('.note-content')){normalizeSharedItems();syncEditor();detectMention();}});
document.addEventListener('selectionchange',()=>{rememberSelection();if(mentionSession?.range&&$('.note-content')?.contains(document.activeElement))detectMention();});
window.addEventListener('resize',()=>{
  const previousDevice=device;
  device=innerWidth<650?'mobile':'desktop';$('#window-wrap').classList.toggle('is-mobile',device==='mobile');
  if(device!==previousDevice){
    const creator=$('.note-creator');
    if(creator)creator.textContent=device==='desktop'?creator.dataset.shortName:creator.dataset.fullName;
    refreshAttachmentViews();
  }
  closeAttachmentPreview();closePopover();closeMentions();applyPaneWidth();
});
window.addEventListener('beforeunload',()=>{finishTitleEdit();if(recipientSession?.closing&&recipientSession.onClose)closeRecipients({immediate:true,restoreFocus:false});inkController?.destroy();syncEditor();sendHost('flush');});
function applyPalette(values) {
  if(!values||typeof values!=='object')return;
  for(const key of ['--cmpri-action-rgb','--cmpri-modal-base','--cmpri-modal-surface','--cmpri-modal-text','--cmpri-outline','--cmpri-modal-muted','--accent'])if(typeof values[key]==='string')document.documentElement.style.setProperty(key,values[key]);
  if(values['--cmpri-action-rgb']&&!values['--accent'])document.documentElement.style.setProperty('--accent','rgb('+values['--cmpri-action-rgb']+')');
}
function editingCurrent() {
  const element=document.activeElement;
  return activeNoteTransition!==0||!!titleEdit||isComposing||!!historyController||!!resizeGesture||mode!=='text'||attachmentController?.isInteracting?.()||formattingController?.isInteracting?.()||!!(element&&element.closest('.note-heading,.title-actions,.note-content,.notepad-formatting,.general-notes-dock,.recipient-dialog,.delete-dialog,.notepad-color-popover,.pane-divider'));
}
function installRemote(incoming,renderCurrent=true) {
  // A refresh started before deletion may arrive after the save acknowledgement.
  // Keep its older document from making the deleted note reappear.
  if((confirmedDeletions.get(incoming.id)??-1)>=Number(incoming.revision))return;
  const index=notes.findIndex(n=>n.id===incoming.id),previous=notes[index];
  if(previous&&Number(previous.revision)>Number(incoming.revision))return;
  const next={...prepareNote(incoming),openThreads:previous?.openThreads||[],inkUndo:previous?.inkUndo||[],inkRedo:previous?.inkRedo||[]};
  if(index<0)notes.push(next);else notes[index]=next;
  deferredNotes.delete(next.id);baseRevisions.set(next.id,next.revision);baseLegacyVersions.set(next.id,next.legacyVersion||null);
  sentDocuments.set(next.id,JSON.stringify(documentFor(next)));
  if(next.id===activeNote&&renderCurrent){suppressSave=true;render();suppressSave=false;}else refreshSidebar();
}
window.addEventListener('message',event=>{
  const data=event.data;
  if(event.source!==parent||event.origin!==location.origin||!data)return;
  if(data.type==='cmpri-time-format-updated'){
    if(initialized&&data.userId===currentPerson&&(data.timeFormat==='12h'||data.timeFormat==='24h'))updateTimeFormat(data.timeFormat);
    return;
  }
  if(data.channel!=='cmpri-notepad'||data.token!==bridgeToken)return;
  const payload=data.payload||{};
  if(data.type==='hello'){sendHost('ready');return;}
  if(data.type==='result'){
    const pending=requests.get(payload.requestId);if(!pending)return;requests.delete(payload.requestId);
    if(payload.error)pending.reject(Error(payload.error));else pending.resolve(payload.result);return;
  }
  if(data.type==='tag-unavailable'){toast(payload.message);return;}
  if(data.type==='palette'){applyPalette(payload);return;}
  if(data.type==='clear'){
    titleEdit=null;
    initialized=false;accountGeneration++;noteTransition++;activeNoteTransition=0;closeRecipients({immediate:true,restoreFocus:false});closeDelete({restoreFocus:false});closePopover();closeMentions();
    inkController?.destroy();formattingController?.destroy();attachmentController?.destroy();inkController=null;formattingController=null;attachmentController=null;
    titleResizeObserver?.disconnect();titleResizeObserver=null;
    paperResizeObserver?.disconnect();paperResizeObserver=null;
    notes=[];people=[];roles=[];mentionChoices=[];tagDirectory=[];workOrderTags.clear();$$('.tag-details').forEach(dialog=>dialog.remove());historyController=null;currentPerson='';activeNote='';query='';mode='text';orders={};VIEW_STORE='';lastOrder='';legacyAliases={};bridgeScope='';timeFormat='12h';
    mobileSidebarCollapsed=false;mobileFormattingExpanded=false;
    selectionRange=null;draggedNote=null;pointerDrag=null;resizeGesture=null;blankLineGesture=null;recipientDraft=null;isComposing=false;suppressNoteClick=false;
    Object.keys(replyTargets).forEach(key=>delete replyTargets[key]);pendingInlineUploads.clear();dirtyNotes.clear();sentDocuments.clear();sequences.clear();deferredNotes.clear();baseRevisions.clear();baseLegacyVersions.clear();confirmedDeletions.clear();
    clearTimeout(toastTimer);$('#preview-toast').textContent='';$('#preview-toast').classList.remove('visible');$('#reorder-status').textContent='';
    for(const pending of requests.values())pending.reject(Error('Your CMPRI session changed.'));requests.clear();
    $('#layout-body').innerHTML='<p class="editor-empty">Sign in to open Notepad.</p>';return;
  }
  if(data.type==='unavailable'){titleEdit=null;$('#layout-body').innerHTML='<p class="editor-empty">'+escape(payload.message)+'</p>';return;}
  if(data.type==='initialize'){
    if(initialized)return;
    bridgeScope=payload.hotelId+':'+payload.userId;currentPerson=payload.userId;people=payload.people||[];roles=payload.roles||[];notes=(payload.notes||[]).map(prepareNote);
    orders={[currentPerson]:payload.order||[]};lastOrder=JSON.stringify(orders[currentPerson]);
    VIEW_STORE='cmpri:notepad:view:'+payload.hotelId+':'+currentPerson;
    let view={};try{view=JSON.parse(localStorage.getItem(VIEW_STORE)||'{}');}catch{}
    paneWidths={desktop:220,mobile:110,...view.paneWidths};mobileSidebarCollapsed=view.mobileSidebarCollapsed===true;
    legacyAliases=payload.legacyAliases||{};const requested=payload.targetNoteId||view.activeNote;activeNote=legacyAliases[requested]||requested||notes[0]?.id||'';
    for(const n of notes){sentDocuments.set(n.id,JSON.stringify(documentFor(n)));baseRevisions.set(n.id,n.revision??null);baseLegacyVersions.set(n.id,n.legacyVersion||null);}
    for(const [id,sequence]of Object.entries(payload.sequences||{})){sequences.set(id,sequence);dirtyNotes.add(id);if(!sentDocuments.has(id))sentDocuments.set(id,'null');}
    refreshMentionChoices();loadTagDirectory();updateTimeFormat(payload.timeFormat);
    applyPalette(payload.palette);initialized=true;suppressSave=true;render();suppressSave=false;return;
  }
  if(!initialized)return;
  if(data.type==='status')return;
  if(data.type==='saved'){
    const current=notes.find(n=>n.id===payload.id);if(current)current.revision=payload.revision;baseRevisions.set(payload.id,payload.revision);if(payload.revision>0){baseLegacyVersions.delete(payload.id);if(current)delete current.legacyVersion;}
    if(current&&payload.taggedPeople?.length)confirmTaggedPeople(current,payload.taggedPeople);
    if(sequences.get(payload.id)!==payload.sequence)return;
    dirtyNotes.delete(payload.id);
    if(payload.note){
      if(payload.id===activeNote&&editingCurrent()){
        if(!deferredNotes.has(payload.id)||Number(deferredNotes.get(payload.id).revision)<=Number(payload.note.revision))deferredNotes.set(payload.id,payload.note);
        if(current){current.authorId=payload.note.authorId;current.createdAt=payload.note.createdAt;current.updatedAt=payload.note.updatedAt;}
      }else installRemote(payload.note);
    }else{confirmedDeletions.set(payload.id,Math.max(confirmedDeletions.get(payload.id)||0,Number(payload.revision)));sentDocuments.delete(payload.id);deferredNotes.delete(payload.id);}
    return;
  }
  if(data.type==='discard'){
    for(const id of payload.ids||[]){dirtyNotes.delete(id);sentDocuments.delete(id);deferredNotes.delete(id);}
    return;
  }
  if(data.type==='remote'){
    people=payload.people||people;roles=payload.roles||roles;legacyAliases=payload.legacyAliases||legacyAliases;
    refreshMentionChoices();updateTimeFormat(payload.timeFormat);
    const visible=new Set(payload.notes.map(n=>n.id));let updateCurrent=false;
    if(historyController&&!visible.has(activeNote)&&note()?.authorId!==currentPerson)closeHistory();
    notes=notes.filter(n=>{if(visible.has(n.id)||dirtyNotes.has(n.id))return true;sentDocuments.delete(n.id);if(n.id===activeNote)updateCurrent=true;return false;});
    for(const incoming of payload.notes){
      if(dirtyNotes.has(incoming.id))continue;
      const current=notes.find(n=>n.id===incoming.id);
      if(current&&current.revision===incoming.revision&&JSON.stringify(documentFor(current))===JSON.stringify(documentFor(incoming)))continue;
      if((current&&current.revision>incoming.revision)||Number(deferredNotes.get(incoming.id)?.revision)>Number(incoming.revision))continue;
      if(incoming.id===activeNote&&editingCurrent())deferredNotes.set(incoming.id,incoming);
      else{installRemote(incoming,false);if(incoming.id===activeNote)updateCurrent=true;}
    }
    if(updateCurrent){suppressSave=true;render();suppressSave=false;}else refreshSidebar();return;
  }
  if(data.type==='select'&&payload.id){const id=legacyAliases[payload.id]||payload.id;if(notes.some(n=>n.id===id))void selectNote(id);return;}
  if(data.type==='flush'){
    finishTitleEdit();
    if(recipientSession?.closing&&recipientSession.onClose)closeRecipients({immediate:true,restoreFocus:false});
    document.dispatchEvent(new Event('cmpri-notes-finish-input'));syncEditor();sendHost('flushed',{requestId:payload.requestId});
  }
});
document.addEventListener('focusout',event=>{
  if(!initialized)return;
  if(titleEdit&&inTitleEditor(event.target)&&!inTitleEditor(event.relatedTarget))finishTitleEdit();
  const generation=accountGeneration,id=activeNote;
  // Native blur can run microtasks while activeElement is still the body.
  // Wait until the next task so focus and the pending dock click can settle.
  setTimeout(()=>{
    if(!initialized||generation!==accountGeneration||id!==activeNote||editingCurrent())return;
    const incoming=deferredNotes.get(id);if(!incoming||dirtyNotes.has(id))return;
    deferredNotes.delete(id);installRemote(incoming);
  },0);
});
sendHost('ready');
})();
