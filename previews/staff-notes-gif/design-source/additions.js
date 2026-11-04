// Browser-only attachments. Only GIPHY IDs are persisted; responses and URLs stay transient.
const GIF_KEY="__RUNTIME_KEY__";
const gifSession=new WeakMap();
let storageReady=false,saving=false;
const dbPromise=new Promise((resolve,reject)=>{
 const req=indexedDB.open('cmpri-staff-notes-preview',1);
 req.onupgradeneeded=()=>req.result.createObjectStore('notes',{keyPath:'id'});
 req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
});
function storedNote(note){return {...note,attachments:(note.attachments||[]).map(f=>f.giphyId?{giphyId:f.giphyId,name:'GIPHY GIF',type:'image/gif'}:f)}}
async function persistNote(note){const db=await dbPromise;await new Promise((resolve,reject)=>{const tx=db.transaction('notes','readwrite');tx.objectStore('notes').put(storedNote(note));tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})}
async function giphyRequest(path,params={}){const client=await import('/giphy-client.mjs');return client.requestGiphy({key:GIF_KEY,path,params})}
function gifFile(gif){const file={giphyId:gif.id,name:gif.title||'GIPHY GIF',type:'image/gif'};gifSession.set(file,gif);return file}
function gifCredit(){const a=make('a',{href:'https://giphy.com/',target:'_blank',rel:'noopener noreferrer',textContent:'Powered By GIPHY'});a.className='giphy-credit';return a}
const originalMediaURL=mediaURL;mediaURL=function(file){if(file.giphyId)return gifSession.get(file)?.images?.original?.url||null;return originalMediaURL(file)};
const originalAttachmentPreview=attachmentPreview;attachmentPreview=function(file){const wrap=originalAttachmentPreview(file);if(file.giphyId){wrap.dataset.giphyId=file.giphyId;wrap.append(gifCredit());if(!mediaURL(file)){const b=wrap.querySelector('button');b.textContent='GIF unavailable · Retry';b.onclick=async()=>{try{const r=await giphyRequest('/'+encodeURIComponent(file.giphyId));if(!r.data?.id)throw Error('GIF is no longer available.');gifSession.set(file,r.data);wrap.replaceWith(attachmentPreview(file))}catch(e){announce(e.message)}}}}return wrap};
const originalShowAttachment=showAttachment;showAttachment=function(file){originalShowAttachment(file);if(file.giphyId&&mediaDialog.open)mediaDialog.append(gifCredit())};
const upload=document.getElementById('upload');upload.setAttribute('aria-label','Media');upload.title='Add GIF or media';upload.setAttribute('aria-haspopup','true');upload.setAttribute('aria-expanded','false');
const pop=make('div',{id:'media-popover'});pop.hidden=true;pop.setAttribute('role','group');pop.setAttribute('aria-label','GIF or Media');
const gifButton=make('button',{type:'button',textContent:'GIF'}),localButton=make('button',{type:'button',textContent:'Media'});pop.append(gifButton,localButton);document.body.append(pop);
function closePop(){pop.hidden=true;upload.setAttribute('aria-expanded','false')}
function alignPop(){const r=upload.getBoundingClientRect(),w=pop.offsetWidth,h=pop.offsetHeight;const left=Math.max(6,Math.min(innerWidth-w-6,r.left+r.width/2-w/2));pop.style.left=left+'px';pop.style.top=Math.max(6,r.top-h-9)+'px';pop.style.setProperty('--pointer-x',Math.max(9,Math.min(w-9,r.left+r.width/2-left))+'px')}
upload.onclick=()=>{if(!pop.hidden){closePop();return}pop.hidden=false;upload.setAttribute('aria-expanded','true');alignPop();gifButton.focus()};
localButton.onclick=()=>{closePop();mediaFiles.click()};
document.addEventListener('pointerdown',e=>{if(!pop.contains(e.target)&&!upload.contains(e.target))closePop()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!pop.hidden){e.preventDefault();e.stopImmediatePropagation();closePop();upload.focus()}},true);
window.addEventListener('resize',()=>{if(!pop.hidden)alignPop()});new ResizeObserver(()=>{if(!pop.hidden)alignPop()}).observe(document.getElementById('composer'));
const picker=make('dialog',{id:'giphy-picker'});picker.setAttribute('aria-label','GIPHY picker');
const searchRow=make('div');searchRow.className='gif-search-row';const search=make('input',{type:'search',placeholder:'Search GIPHY',maxLength:50});search.setAttribute('aria-label','Search GIPHY');
const closePicker=make('button',{type:'button',textContent:'×'});closePicker.setAttribute('aria-label','Close GIF picker');closePicker.onclick=()=>picker.close();searchRow.append(search,closePicker);
const status=make('p');status.className='gif-status';status.setAttribute('role','status');const grid=make('div');grid.className='gif-grid';grid.setAttribute('aria-label','GIF results');
const footer=make('div');footer.className='gif-footer';const more=make('button',{type:'button',textContent:'More'});footer.append(more,gifCredit());picker.append(searchRow,status,grid,footer);document.body.append(picker);
let generation=0,offset=0,query='',debounce,total=0;
async function loadGIFs(append=false){const version=++generation;const q=search.value;if(!append){query=q;offset=0;grid.replaceChildren()}status.textContent=q?'Searching…':'Loading Trending…';more.disabled=true;
 try{const result=await giphyRequest(q?'/search':'/trending',{limit:24,offset,q,...(q?{lang:'en'}:{})});if(version!==generation||!picker.open)return;
 for(const gif of result.data){const button=make('button',{type:'button'});button.dataset.giphyId=gif.id;button.setAttribute('aria-label','Select '+(gif.title||'GIF'));const img=make('img',{src:gif.images.fixed_width.url,alt:gif.title||'GIF',loading:'lazy'});button.append(img);button.onclick=()=>{attachedFiles.push(gifFile(gif));showAttachments();sync();picker.close();body.focus()};grid.append(button)}
 offset+=result.data.length;total=result.pagination?.total_count||offset;status.textContent=result.data.length?(q?'Search results':'Trending'):'No GIFs found';more.disabled=offset>=total;more.hidden=offset>=total;
 }catch(e){if(version!==generation)return;status.textContent=e.message;more.textContent='Retry';more.hidden=false;more.disabled=false}
}
more.onclick=()=>{more.textContent='More';loadGIFs(grid.childElementCount>0)};
search.addEventListener('input',()=>{clearTimeout(debounce);generation++;debounce=setTimeout(()=>loadGIFs(),search.value?300:0)});
search.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();clearTimeout(debounce);loadGIFs()}});
gifButton.onclick=()=>{closePop();search.value='';picker.showModal();loadGIFs();search.focus()};
picker.addEventListener('close',()=>{generation++;clearTimeout(debounce);grid.replaceChildren();search.value='';upload.focus()});
async function restoreNotes(){try{const db=await dbPromise;const saved=await new Promise((resolve,reject)=>{const req=db.transaction('notes').objectStore('notes').getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});saved.sort((a,b)=>(a.createdOrder||a.at)-(b.createdOrder||b.at));for(const note of saved){if(rowMap.has(note.id))continue;notes.append(createRow(note));mentionNames.add(note.author);flagEvents.push({id:note.id,at:note.at})}storageReady=true;sync();notify();refreshSeen();
 const gifs=saved.flatMap(n=>n.attachments||[]).filter(f=>f.giphyId);const ids=[...new Set(gifs.map(f=>f.giphyId))];for(let i=0;i<ids.length;i+=50){try{const result=await giphyRequest('',{ids:ids.slice(i,i+50).join(',')});for(const f of gifs){const gif=result.data.find(g=>g.id===f.giphyId);if(gif)gifSession.set(f,gif)}}catch(e){announce('Saved notes restored. '+e.message)}}
 for(const note of saved){const entry=rowMap.get(note.id);if(entry){const old=entry.row;old.replaceWith(createRow(note))}}notes.scrollTop=notes.scrollHeight;
 }catch(e){announce('Browser storage is unavailable. Posting is disabled to avoid losing attachments.');storageReady=false;sync()}}
restoreNotes();
