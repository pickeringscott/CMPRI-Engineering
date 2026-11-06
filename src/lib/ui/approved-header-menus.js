/* Approved v23 appearance. Gestures only reorder these already-authorized DOM controls. */
export function mountApprovedMenus(root, groups, onLaunch, layout, onSave) {
 const PRESS_MS=320,SLIDE_MS=240;
 let observer,suppressClickUntil=0,cancelGesture;
 const ghosts=new Set(),cleanups=[];
 root.replaceChildren();
 const preview=document.createElement('div');preview.className='preview layout-b';
 const header=document.createElement('div');header.className='header chief-mobile';
 const bar=document.createElement('div');bar.className='groups';header.append(bar);preview.append(header);root.append(preview);
 const label=group=>group.querySelector('legend').textContent;
 const emit=()=>onSave({groups:[...bar.children].map(label),buttons:Object.fromEntries([...bar.children].map(g=>[label(g),[...g.querySelectorAll('.buttons>.action')].map(b=>b.dataset.layoutKey)])),widths:Object.fromEntries([...bar.children].map(g=>[label(g),parseFloat(g.classList.contains('collapsed')?g.expandedWidth:g.style.width)||g.offsetWidth])),collapsed:[...bar.children].filter(g=>g.classList.contains('collapsed')).map(label)});
 const listen=(name,fn,options)=>{document.addEventListener(name,fn,options);return()=>document.removeEventListener(name,fn,options)};
 const clearMotion=nodes=>nodes.forEach(n=>n.getAnimations().forEach(a=>a.cancel()));
 function slide(peers,change){
  const before=new Map(peers.map(n=>[n,n.getBoundingClientRect()]));change();clearMotion(peers);
  for(const n of peers){const a=before.get(n),b=n.getBoundingClientRect();if(a.x!==b.x||a.y!==b.y)n.animate([{transform:`translate(${a.x-b.x}px,${a.y-b.y}px)`},{transform:'none'}],{duration:SLIDE_MS,easing:'cubic-bezier(.2,.7,.3,1)'})}
 }
 function copy(item,x,y){
  const ghost=item.cloneNode(true);ghost.removeAttribute('id');ghost.querySelectorAll('[id]').forEach(n=>n.removeAttribute('id'));
  const originals=[item,...item.querySelectorAll('*')],copies=[ghost,...ghost.querySelectorAll('*')];
  originals.forEach((n,i)=>{const style=getComputedStyle(n);for(const property of style)copies[i].style.setProperty(property,style.getPropertyValue(property),'important');copies[i].style.outline='none';copies[i].style.animation='none';copies[i].style.transition='none'});
  // Root logical offsets and group margins must not shift the pointer-following copy.
  for(const property of ['inset-block-start','inset-block-end','inset-inline-start','inset-inline-end','margin-block-start','margin-block-end','margin-inline-start','margin-inline-end'])ghost.style.removeProperty(property);
  const r=item.getBoundingClientRect();ghost.classList.add('moving-copy');ghost.setAttribute('aria-hidden','true');ghost.setAttribute('inert','');
  Object.assign(ghost.style,{position:'fixed',left:x+'px',top:y+'px',width:r.width+'px',height:r.height+'px',minWidth:r.width+'px',maxWidth:r.width+'px',minHeight:r.height+'px',maxHeight:r.height+'px',margin:0,transform:'none',pointerEvents:'none'});
  for(const [key,value] of Object.entries({position:'fixed',left:x+'px',top:y+'px',right:'auto',bottom:'auto',margin:'0px',width:r.width+'px',height:r.height+'px','min-width':r.width+'px','max-width':r.width+'px','min-height':r.height+'px','max-height':r.height+'px',opacity:'.55','z-index':'10003','pointer-events':'none'}))ghost.style.setProperty(key,value,'important');
  document.body.append(ghost);
  originals.forEach((n,i)=>{copies[i].scrollLeft=n.scrollLeft;copies[i].scrollTop=n.scrollTop});
  ghosts.add(ghost);return ghost;
 }
 function startDrag(event,item,container,isButton){
  if(event.button!==0||event.isPrimary===false||cancelGesture)return;
  const captureTarget=event.currentTarget;captureTarget.setPointerCapture(event.pointerId);
  const initial=[...container.children],host=root.closest('.cmpri-desktop-topbar')||header;
  const start={x:event.clientX,y:event.clientY,scroll:container.scrollLeft,hostLeft:host.scrollLeft,hostTop:host.scrollTop};
  let last=event,active=false,moved=false,swipe=false,ghost,frame,slideUntil=0;
  const within=()=>{const r=isButton?container.closest('fieldset').getBoundingClientRect():container.getBoundingClientRect(),h=host.getBoundingClientRect();return last.clientX>=r.left&&last.clientX<=r.right&&last.clientY>=Math.max(r.top-(isButton?0:24),h.top)&&last.clientY<=Math.min(r.bottom+(isButton?0:24),h.bottom)};
  const arrange=()=>{
   const valid=within();document.body.classList.toggle('drag-invalid',!valid);
   if(isButton){ghost.style.setProperty('visibility',valid?'visible':'hidden','important');item.style.visibility=valid?'visible':'hidden'}
   if(!moved||!valid||performance.now()<slideUntil)return;
   const peers=[...container.children].filter(n=>n!==item);
   const target=peers.find(n=>{
    const r=n.getBoundingClientRect();
    const top=isButton?r.top:Math.min(r.top,n.querySelector('legend').getBoundingClientRect().top);
    return isButton?last.clientX<r.left+r.width/2:last.clientY<top||(last.clientY<=r.bottom&&last.clientX<r.left+r.width/2);
   });
   if(target?item.nextElementSibling===target:container.lastElementChild===item)return;
   slide(peers,()=>target?target.before(item):container.append(item));captureTarget.setPointerCapture(event.pointerId);slideUntil=performance.now()+SLIDE_MS;
  };
  const edgeScroll=()=>{
   if(!active)return;
   if(moved&&within()){
    const box=isButton?container:host,r=box.getBoundingClientRect();
    if(isButton){if(last.clientX>r.right-18)box.scrollLeft+=8;else if(last.clientX<r.left+18)box.scrollLeft-=8}
    else{if(last.clientY>r.bottom-35)box.scrollTop+=10;else if(last.clientY<r.top+35)box.scrollTop-=10}
    // Re-evaluate after peer animation even when edge scrolling has just hit its limit.
    arrange();
   }
   frame=requestAnimationFrame(edgeScroll);
  };
  const startedAt=performance.now();
  const activate=()=>{
   active=true;document.body.classList.add('drag-active');window.getSelection()?.removeAllRanges();
   ghost=copy(item,last.clientX+8,last.clientY+8);item.classList.add('landing-copy');arrange();frame=requestAnimationFrame(edgeScroll);
  };
  const timer=event.pointerType==='mouse'?undefined:window.setTimeout(activate,PRESS_MS);
  const move=e=>{
   if(e.pointerId!==event.pointerId)return;last=e;
   const dx=e.clientX-start.x,dy=e.clientY-start.y;if(Math.hypot(dx,dy)>8)moved=true;
   if(!active){
    if(event.pointerType==='mouse'){if(!moved)return;activate()}
    else{
     if(moved){window.clearTimeout(timer);swipe=true}
     if(isButton&&swipe&&Math.abs(dx)>Math.abs(dy)){e.preventDefault();container.scrollLeft=start.scroll-dx}return;
    }
   }
   e.preventDefault();ghost.style.setProperty('left',(e.clientX+8)+'px','important');ghost.style.setProperty('top',(e.clientY+8)+'px','important');arrange();
  };
  const finish=(e,cancel=false)=>{
   if(e.pointerId!==event.pointerId)return;last=e;window.clearTimeout(timer);cancelAnimationFrame(frame);
   if(active){
    suppressClickUntil=performance.now()+400;
    if(cancel||!within()){clearMotion(initial);initial.forEach(n=>container.append(n));container.scrollLeft=start.scroll;host.scrollLeft=start.hostLeft;host.scrollTop=start.hostTop}else emit();
    ghost.remove();ghosts.delete(ghost);item.style.visibility='';item.classList.remove('landing-copy');
   }else if(moved||performance.now()-startedAt>=PRESS_MS)suppressClickUntil=performance.now()+400;
   if(captureTarget.hasPointerCapture(event.pointerId))captureTarget.releasePointerCapture(event.pointerId);
   document.body.classList.remove('drag-active','drag-invalid');off.forEach(fn=>fn());cancelGesture=undefined;
  };
  const off=[listen('pointermove',move,{passive:false}),listen('pointerup',e=>finish(e)),listen('pointercancel',e=>finish(e,true)),listen('keydown',e=>{if(e.key==='Escape'){e.preventDefault();finish(last,true)}})];
  cancelGesture=()=>finish(last,true);
 }
 for(const group of groups){
  const field=document.createElement('fieldset');field.className='group';
  const title=document.createElement('legend');title.className='group-title';title.textContent=group.label;title.tabIndex=0;title.setAttribute('role','button');title.setAttribute('aria-expanded','true');title.title='Click or tap to collapse; drag to reorder (touch: long press)';title.setAttribute('aria-label',group.label+'; click or tap to collapse, drag to reorder (touch: long press), or Alt + Left/Right');
  const buttons=document.createElement('div');buttons.className='buttons';
  for(const action of group.items){
   const b=document.createElement('button');b.type='button';b.className='action';b.dataset.key=action.key;b.dataset.layoutKey=action.key+'::'+action.label.replace(/ \(\d+\)$/,'');b.dataset.control=action.label;b.textContent=action.label;
   for(const [key,value]of Object.entries(action.style||{}))b.style.setProperty(key,value);
   b.title='Drag to reorder within '+group.label+' (touch: long press)';b.oncontextmenu=e=>e.preventDefault();b.onpointerdown=e=>startDrag(e,b,buttons,true);
   b.onclick=()=>{if(performance.now()>=suppressClickUntil)onLaunch(action,Date.now())};
   b.onkeydown=e=>{if(e.altKey&&['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const other=e.key==='ArrowLeft'?b.previousElementSibling:b.nextElementSibling;if(other){if(e.key==='ArrowLeft')other.before(b);else other.after(b);emit();b.focus()}}};buttons.append(b);
  }
  const saved=layout.buttons[group.label]||[],rank=b=>{const specific=saved.indexOf(b.dataset.layoutKey),n=specific<0?saved.indexOf(b.dataset.key):specific;return n<0?999:n};[...buttons.children].sort((a,b)=>rank(a)-rank(b)).forEach(n=>buttons.append(n));
  field.append(title,buttons);bar.append(field);title.style.maxWidth='none';title.style.width='max-content';
  const fit=()=>Math.max(title.offsetWidth+26,Math.ceil([...buttons.children].reduce((sum,b)=>sum+b.getBoundingClientRect().width,0)+Math.max(0,buttons.children.length-1)*(parseFloat(getComputedStyle(buttons).columnGap)||0)+14));
  const min=()=>Math.min(title.offsetWidth+26,root.clientWidth-4);
  field.style.minWidth=min()+'px';field.style.width=Math.min(Math.max(min(),Math.min(layout.widths[group.label]||fit(),fit())),root.clientWidth-4)+'px';
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('group-outline');svg.setAttribute('aria-hidden','true');field.append(svg);
  const scroll=document.createElement('input');scroll.type='range';scroll.min=0;scroll.step=1;scroll.value=0;scroll.className='group-scroll';scroll.setAttribute('aria-label','Scroll '+group.label+' buttons');field.append(scroll);
  field.drawOutline=()=>{
   if(!field.classList.contains('collapsed')){field.style.minWidth=min()+'px';if(parseFloat(field.style.width)<min())field.style.width=min()+'px'}
   const w=field.clientWidth+2,h=field.clientHeight+16,l=11,r=l+title.offsetWidth+6;
   svg.innerHTML=`<path d="M 6 15 H ${l-3} Q ${l} 15 ${l} 12 V 6 Q ${l} 1 ${l+5} 1 H ${r-5} Q ${r} 1 ${r} 6 V 12 Q ${r} 15 ${r+3} 15 H ${w-6} Q ${w-1} 15 ${w-1} 20 V ${h-6} Q ${w-1} ${h-1} ${w-6} ${h-1} H 6 Q 1 ${h-1} 1 ${h-6} V 20 Q 1 15 6 15 Z" fill="none" stroke="#334155aa"/>`;
   scroll.max=Math.max(0,buttons.scrollWidth-buttons.clientWidth);scroll.hidden=Number(scroll.max)<1;scroll.value=buttons.scrollLeft;
  };
  scroll.oninput=()=>buttons.scrollLeft=Number(scroll.value);buttons.onscroll=()=>scroll.value=buttons.scrollLeft;
  const toggle=()=>{if(performance.now()<suppressClickUntil)return;const closed=field.classList.toggle('collapsed');if(closed){field.expandedWidth=field.style.width;field.style.width=(title.offsetWidth+2)+'px'}else field.style.width=field.expandedWidth;title.setAttribute('aria-expanded',String(!closed));field.drawOutline();emit()};
  title.onclick=toggle;title.onpointerdown=e=>startDrag(e,field,bar,false);title.oncontextmenu=e=>e.preventDefault();
  title.onkeydown=e=>{if(e.altKey&&['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const other=e.key==='ArrowLeft'?field.previousElementSibling:field.nextElementSibling;if(other){if(e.key==='ArrowLeft')other.before(field);else other.after(field);emit();title.focus()}}else if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle()}};
  const edge=document.createElement('span');edge.className='resize-edge';edge.tabIndex=0;edge.setAttribute('role','separator');edge.setAttribute('aria-orientation','vertical');edge.setAttribute('aria-label','Resize '+group.label);edge.title='Drag horizontally to resize';field.append(edge);
  const resize=w=>{field.style.width=Math.max(min(),Math.min(w,root.clientWidth-4,fit()))+'px';field.expandedWidth=field.style.width;field.drawOutline()};
  edge.onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();resize(field.offsetWidth+(e.key==='ArrowRight'?10:-10));emit()}};
  edge.oncontextmenu=e=>e.preventDefault();edge.onpointerdown=e=>{
   if(e.button!==0||e.isPrimary===false||cancelGesture)return;e.preventDefault();const width=field.style.width,x=e.clientX,w=field.offsetWidth;document.body.classList.add('drag-active');window.getSelection()?.removeAllRanges();edge.setPointerCapture(e.pointerId);
   const move=m=>{if(m.pointerId===e.pointerId){m.preventDefault();resize(w+m.clientX-x)}};
   const finish=(m,cancel=false)=>{if(m.pointerId!==e.pointerId)return;if(cancel)resize(parseFloat(width));else emit();if(edge.hasPointerCapture(e.pointerId))edge.releasePointerCapture(e.pointerId);off.forEach(fn=>fn());document.body.classList.remove('drag-active');cancelGesture=undefined};
   const off=[listen('pointermove',move,{passive:false}),listen('pointerup',m=>finish(m)),listen('pointercancel',m=>finish(m,true))];cancelGesture=()=>finish(e,true);
  };
  if(layout.collapsed.includes(group.label)){field.expandedWidth=field.style.width;field.classList.add('collapsed');field.style.width='max-content';title.setAttribute('aria-expanded','false')}
 }
 const rank=g=>{const i=layout.groups.indexOf(label(g));return i<0?999:i};[...bar.children].sort((a,b)=>rank(a)-rank(b)).forEach(g=>bar.append(g));
 observer=new ResizeObserver(()=>[...bar.children].forEach(g=>g.drawOutline()));for(const field of bar.children){observer.observe(field);observer.observe(field.querySelector('legend'));field.drawOutline()}
 const blur=()=>cancelGesture?.();window.addEventListener('blur',blur);cleanups.push(()=>window.removeEventListener('blur',blur));
 return()=>{cancelGesture?.();observer.disconnect();cleanups.forEach(fn=>fn());for(const ghost of ghosts)ghost.remove();document.body.classList.remove('drag-active','drag-invalid');root.replaceChildren()};
}
