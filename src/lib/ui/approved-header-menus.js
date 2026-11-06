/* Drag, resize, outline and collapse mechanics adapted from approved standalone v23. */
export function mountApprovedMenus(root,groups,onLaunch,layout,onSave){
 let groupObserver,suppressDemoUntil=0;
 const emit=()=>onSave({groups:[...bar.children].map(g=>g.querySelector('legend').textContent),buttons:Object.fromEntries([...bar.children].map(g=>[g.querySelector('legend').textContent,[...g.querySelectorAll('.buttons>.action')].map(b=>b.dataset.key)])),widths:Object.fromEntries([...bar.children].map(g=>[g.querySelector('legend').textContent,parseFloat(g.expandedWidth||g.style.width)||g.offsetWidth])),collapsed:[...bar.children].filter(g=>g.classList.contains('collapsed')).map(g=>g.querySelector('legend').textContent)});
 const handlers=[],timeouts=new Set(),intervals=new Set();
 const setTimeout=(fn,ms)=>{const id=window.setTimeout(()=>{timeouts.delete(id);fn()},ms);timeouts.add(id);return id};
 const clearTimeout=id=>{window.clearTimeout(id);timeouts.delete(id)};
 const setInterval=(fn,ms)=>{const id=window.setInterval(fn,ms);intervals.add(id);return id};
 const clearInterval=id=>{window.clearInterval(id);intervals.delete(id)};
 const listen=(name,fn,options)=>{document.addEventListener(name,fn,options);handlers.push([name,fn,options])};
 const unlisten=(name,fn,options)=>{document.removeEventListener(name,fn,options);for(let i=handlers.length-1;i>=0;i--)if(handlers[i][0]===name&&handlers[i][1]===fn)handlers.splice(i,1)};
 const actions=new Map();root.replaceChildren();const preview=document.createElement('div');preview.className='preview layout-b';const header=document.createElement('div');header.className='header';const bar=document.createElement('div');bar.className='groups';header.append(bar);preview.append(header);root.append(preview);
 for(const group of groups){const field=document.createElement('fieldset');field.className='group';const legend=document.createElement('legend');legend.className='group-title';legend.textContent=group.label;const buttons=document.createElement('div');buttons.className='buttons';for(const action of group.items){const button=document.createElement('button');button.type='button';button.className='action';button.dataset.control=action.label;button.dataset.key=action.key;button.textContent=action.label;actions.set(action.key,action);const style=action.style||{};for(const [key,value] of Object.entries(style))button.style.setProperty(key,value);buttons.append(button)}field.append(legend,buttons);bar.append(field)}
 const launchButton=button=>{const action=actions.get(button.dataset.key);if(action)onLaunch(action,Date.now())};
function startPreviewDrag(e,item,bar,save,isButton){
 if(e.button!==0)return;
 const touch=e.pointerType==='touch',sx=e.clientX,sy=e.clientY,scroll=bar.scrollLeft,original=[...bar.children];
 let active=false,timer,swipe=false,ghost,valid=false,slideUntil=0;
 const inside=m=>{const r=(isButton?bar.closest('fieldset'):bar).getBoundingClientRect();return m.clientX>=r.left&&m.clientX<=r.right&&m.clientY>=r.top-(isButton?0:16)&&m.clientY<=r.bottom+(isButton?0:4)};
 const begin=()=>{active=true;document.body.classList.add('drag-active');window.getSelection()?.removeAllRanges();
  ghost=item.cloneNode(true);ghost.removeAttribute('id');ghost.querySelectorAll('[id]').forEach(n=>n.removeAttribute('id'));ghost.classList.add('moving-copy');ghost.setAttribute('aria-hidden','true');
  const originals=[item,...item.querySelectorAll('*')],copies=[ghost,...ghost.querySelectorAll('*')];originals.forEach((n,i)=>{const c=getComputedStyle(n);for(const property of c)copies[i].style.setProperty(property,c.getPropertyValue(property));copies[i].style.outline='none';copies[i].style.animation='none';copies[i].style.transition='none'});
  const r=item.getBoundingClientRect();Object.assign(ghost.style,{position:'fixed',width:r.width+'px',height:r.height+'px',minWidth:r.width+'px',maxWidth:r.width+'px',minHeight:r.height+'px',maxHeight:r.height+'px',margin:0,transform:'none',left:(sx+12)+'px',top:(sy-22)+'px'});if(isButton){const computed=getComputedStyle(item);['font','lineHeight','padding','borderWidth','borderStyle','borderColor','borderRadius','backgroundColor','color','letterSpacing','display','alignItems','justifyContent'].forEach(k=>ghost.style[k]=computed[k]);Object.assign(ghost.style,{boxSizing:'border-box',minWidth:r.width+'px',maxWidth:r.width+'px',minHeight:r.height+'px',maxHeight:r.height+'px',width:r.width+'px',height:r.height+'px',transform:'none'})}document.body.append(ghost);
  item.classList.add('landing-copy');if(isButton)item.classList.add('drag-pill-target');valid=true;
 };
 if(isButton)timer=setTimeout(begin,320);else{e.preventDefault();begin()}
 const move=m=>{if(m.pointerId!==e.pointerId)return;
  if(!active){const dx=m.clientX-sx,dy=m.clientY-sy;if(Math.abs(dx)>8||Math.abs(dy)>8){clearTimeout(timer);swipe=true}if(swipe&&Math.abs(dx)>Math.abs(dy)){m.preventDefault();bar.scrollLeft=scroll-dx}return}
  m.preventDefault();ghost.style.left=(m.clientX+12)+'px';ghost.style.top=(m.clientY-22)+'px';valid=inside(m);document.body.classList.toggle('drag-invalid',!valid);if(isButton){ghost.style.visibility=valid?'visible':'hidden';item.style.visibility=valid?'visible':'hidden'}if(!valid)return;
  const r=bar.getBoundingClientRect();if(isButton){if(m.clientX>r.right-18)bar.scrollLeft+=8;if(m.clientX<r.left+18)bar.scrollLeft-=8}
  if(performance.now()<slideUntil)return;
  const peers=[...bar.children].filter(n=>n!==item);
  const target=peers.find(n=>{const b=n.getBoundingClientRect();return isButton?m.clientX>=b.left&&m.clientX<=b.right:m.clientX>=b.left&&m.clientX<=b.right&&m.clientY>=b.top-15&&m.clientY<=b.bottom});
  if(target){const b=target.getBoundingClientRect(),before=m.clientX<b.x+b.width/2;if((before&&item.nextElementSibling===target)||(!before&&target.nextElementSibling===item))return;const rects=new Map(peers.map(n=>[n,n.getBoundingClientRect()]));if(before)target.before(item);else target.after(item);peers.forEach(n=>{const old=rects.get(n),now=n.getBoundingClientRect(),dx=old.x-now.x,dy=old.y-now.y;if(dx||dy)n.animate([{transform:`translate(${dx}px,${dy}px)`},{transform:'translate(0,0)'}],{duration:240,easing:'cubic-bezier(.2,.7,.3,1)'})});slideUntil=performance.now()+240}

 };
 const finish=(m,cancel=false)=>{if(m.pointerId!==e.pointerId)return;clearTimeout(timer);if(active){if(touch||Math.abs(m.clientX-sx)+Math.abs(m.clientY-sy)>5)suppressDemoUntil=performance.now()+350;valid=inside(m);if(cancel||!valid)original.forEach(n=>bar.append(n));else save();ghost.remove();item.style.visibility='';item.classList.remove('landing-copy','drag-pill-target');document.body.classList.remove('drag-active','drag-invalid')}unlisten('pointermove',move);unlisten('pointerup',up);unlisten('pointercancel',cancelled)};
 const up=m=>finish(m),cancelled=m=>finish(m,true);
 listen('pointermove',move,{passive:false});listen('pointerup',up);listen('pointercancel',cancelled);
}
function setupDesktopGroups(){
 if(groupObserver)groupObserver.disconnect();
 const desktop=true;

 root.querySelectorAll('fieldset.group').forEach(group=>{
  if(!desktop)return;
  const title=group.querySelector('legend');
  const buttons=group.querySelector('.buttons');
  const key=title.textContent;
  const saved=layout.buttons[key]||[];
  [...buttons.children].sort((a,b)=>(saved.indexOf(a.dataset.key)<0?999:saved.indexOf(a.dataset.key))-(saved.indexOf(b.dataset.key)<0?999:saved.indexOf(b.dataset.key))).forEach(n=>buttons.append(n));
  title.style.maxWidth="none";title.style.width="max-content";
  const natural=[...buttons.children].reduce((n,b)=>n+b.offsetWidth,0)+Math.max(0,buttons.children.length-1)+14;
  group.style.minWidth=Math.min(title.offsetWidth+26,root.clientWidth-4)+"px";
  group.style.width=Math.min(Math.max(title.offsetWidth+26,Math.min(layout.widths[key]||natural,natural)),root.clientWidth-4)+'px';
  title.title='Drag this tab to reorder within this menu bar';title.tabIndex=0;
  title.setAttribute('aria-label',title.textContent+'; drag to reorder, or Alt + Left/Right');
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('group-outline');svg.setAttribute('aria-hidden','true');group.append(svg);
  const draw=()=>{const w=group.clientWidth+2,h=group.clientHeight+16,tw=title.offsetWidth,l=11,r=l+tw+6;svg.innerHTML=`<path d="M 6 15 H ${l-3} Q ${l} 15 ${l} 12 V 6 Q ${l} 1 ${l+5} 1 H ${r-5} Q ${r} 1 ${r} 6 V 12 Q ${r} 15 ${r+3} 15 H ${w-6} Q ${w-1} 15 ${w-1} 20 V ${h-6} Q ${w-1} ${h-1} ${w-6} ${h-1} H 6 Q 1 ${h-1} 1 ${h-6} V 20 Q 1 15 6 15 Z" fill="none" stroke="#334155aa"/>`};
  if(!groupObserver)groupObserver=new ResizeObserver(()=>root.querySelectorAll('.group').forEach(g=>g.drawOutline?.()));
  const scroll=document.createElement('input');scroll.type='range';scroll.min=0;scroll.step=1;scroll.value=0;scroll.className='group-scroll';scroll.setAttribute('aria-label','Scroll '+title.textContent+' buttons');group.append(scroll);
  const sync=()=>{scroll.max=Math.max(0,buttons.scrollWidth-buttons.clientWidth);scroll.hidden=Number(scroll.max)<1;scroll.value=buttons.scrollLeft};
  scroll.oninput=()=>buttons.scrollLeft=Number(scroll.value);buttons.onscroll=sync;
  group.drawOutline=()=>{if(!group.classList.contains('collapsed')){const min=Math.min(title.offsetWidth+26,root.clientWidth-4);group.style.minWidth=min+'px';if(parseFloat(group.style.width)<min)group.style.width=min+'px'}draw();sync()};groupObserver.observe(group);groupObserver.observe(title);group.drawOutline();
  const save=emit;
  [...buttons.children].forEach(button=>{
   button.onclick=()=>{if(performance.now()<(suppressDemoUntil||0))return;launchButton(button)};
   button.title='Drag left or right to reorder within '+title.textContent;
   button.onkeydown=e=>{if(e.altKey&&['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const other=e.key==='ArrowLeft'?button.previousElementSibling:button.nextElementSibling;if(other){if(e.key==='ArrowLeft')other.before(button);else other.after(button);save();button.focus()}}};
   button.oncontextmenu=e=>e.preventDefault();
   button.onpointerdown=e=>startPreviewDrag(e,button,buttons,save,true);

  });
  const edge=document.createElement('span');edge.className='resize-edge';edge.tabIndex=0;edge.setAttribute('role','separator');edge.setAttribute('aria-orientation','vertical');edge.setAttribute('aria-label','Resize '+title.textContent);edge.title='Drag horizontally to resize';group.append(edge);
  const fitWidth=()=>Math.max(title.offsetWidth+26,[...buttons.children].reduce((n,b)=>n+b.offsetWidth,0)+Math.max(0,buttons.children.length-1)+14);const resize=w=>{group.style.width=Math.max(title.offsetWidth+26,Math.min(w,root.clientWidth-4,fitWidth()))+'px';group.drawOutline()};
  edge.onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();resize(group.offsetWidth+(e.key==='ArrowRight'?10:-10));emit()}};
  edge.oncontextmenu=e=>e.preventDefault();edge.onpointerdown=e=>{e.preventDefault();document.body.classList.add('drag-active');window.getSelection()?.removeAllRanges();const x=e.clientX,w=group.offsetWidth;edge.setPointerCapture(e.pointerId);edge.onpointermove=m=>resize(w+m.clientX-x);edge.onpointerup=edge.onpointercancel=()=>{edge.onpointermove=null;document.body.classList.remove('drag-active');emit()}};
  title.onkeydown=e=>{if(e.altKey&&['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const other=e.key==='ArrowLeft'?group.previousElementSibling:group.nextElementSibling;if(other){if(e.key==='ArrowLeft')other.before(group);else other.after(group);emit();title.focus()}}};
  title.oncontextmenu=e=>e.preventDefault();title.onpointerdown=e=>startPreviewDrag(e,group,group.parentElement,()=>{},false);

 });
}
function chiefMobileTabs(){

 root.querySelector('.header').classList.add('chief-mobile');
 root.querySelectorAll('fieldset.group').forEach(group=>{
  const title=group.querySelector('legend');title.setAttribute('role','button');title.setAttribute('aria-expanded','true');
  const toggle=()=>{if(performance.now()<(group.noTapUntil||0))return;const closed=group.classList.toggle('collapsed');if(closed){group.expandedWidth=group.style.width;group.style.width=(title.offsetWidth+2)+'px'}else group.style.width=group.expandedWidth;title.setAttribute('aria-expanded',String(!closed));group.drawOutline();emit()};
  title.onclick=toggle;title.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle()}};
  title.onpointerdown=e=>{
   if(e.button!==0)return;const bar=group.parentElement,original=[...bar.children],sx=e.clientX,sy=e.clientY;let active=false,ghost,timer,edgeTimer,last={x:sx,y:sy},valid=false,slideUntil=0;
   const within=()=>{const r=bar.getBoundingClientRect();return last.x>=r.left&&last.x<=r.right&&last.y>=r.top-24&&last.y<=r.bottom+48};
   const arrange=()=>{valid=within();if(!valid||performance.now()<slideUntil)return;const peers=[...bar.children].filter(n=>n!==group),target=peers.find(n=>{const r=n.getBoundingClientRect();return last.y<r.top-8||(last.y<=r.bottom&&last.x<r.x+r.width/2)});const before=peers.map(n=>[n,n.getBoundingClientRect()]);if(target){if(group.nextElementSibling===target)return;target.before(group)}else{if(bar.lastElementChild===group)return;bar.append(group)}before.forEach(([n,r])=>{const t=n.getBoundingClientRect();if(r.x!==t.x||r.y!==t.y)n.animate([{transform:`translate(${r.x-t.x}px,${r.y-t.y}px)`},{transform:'none'}],{duration:240,easing:'cubic-bezier(.2,.7,.3,1)'})});slideUntil=performance.now()+240};
   timer=setTimeout(()=>{active=true;group.noTapUntil=Infinity;document.body.classList.add('drag-active');window.getSelection()?.removeAllRanges();ghost=group.cloneNode(true);const originals=[group,...group.querySelectorAll('*')],copies=[ghost,...ghost.querySelectorAll('*')];originals.forEach((n,i)=>{const c=getComputedStyle(n);for(const k of c)copies[i].style.setProperty(k,c.getPropertyValue(k))});const r=group.getBoundingClientRect();ghost.classList.add('moving-copy');Object.assign(ghost.style,{position:'fixed',left:(last.x+8)+'px',top:(last.y+8)+'px',width:r.width+'px',height:r.height+'px',margin:0,transform:'none'});document.body.append(ghost);group.classList.add('landing-copy');valid=true;edgeTimer=setInterval(()=>{if(last.y>innerHeight-65)window.scrollBy(0,10);else if(last.y<65)window.scrollBy(0,-10);arrange()},40)},320);
   const move=m=>{if(m.pointerId!==e.pointerId)return;last={x:m.clientX,y:m.clientY};if(!active){if(Math.hypot(last.x-sx,last.y-sy)>8)clearTimeout(timer);return}m.preventDefault();ghost.style.left=(last.x+8)+'px';ghost.style.top=(last.y+8)+'px';arrange()};
   const finish=(m,cancel=false)=>{if(m.pointerId!==e.pointerId)return;clearTimeout(timer);clearInterval(edgeTimer);if(active){last={x:m.clientX,y:m.clientY};valid=within();if(cancel||!valid)original.forEach(n=>bar.append(n));else emit();ghost.remove();group.classList.remove('landing-copy');document.body.classList.remove('drag-active');group.noTapUntil=performance.now()+400}unlisten('pointermove',move);unlisten('pointerup',up);unlisten('pointercancel',abort)};
   const up=m=>finish(m),abort=m=>finish(m,true);listen('pointermove',move,{passive:false});listen('pointerup',up);listen('pointercancel',abort);
  };
 });
}

 setupDesktopGroups();chiefMobileTabs();
 for(const group of [...bar.children]){const title=group.querySelector('legend').textContent;if(layout.collapsed.includes(title)){group.expandedWidth=group.style.width;group.classList.add('collapsed');group.style.width='max-content';group.querySelector('legend').setAttribute('aria-expanded','false')}}
 const rank=g=>{const i=layout.groups.indexOf(g.querySelector('legend').textContent);return i<0?999:i};[...bar.children].sort((a,b)=>rank(a)-rank(b)).forEach(g=>bar.append(g));

 return ()=>{groupObserver?.disconnect();for(const [name,fn,options] of handlers)document.removeEventListener(name,fn,options);for(const id of timeouts)window.clearTimeout(id);for(const id of intervals)window.clearInterval(id);document.querySelectorAll('.moving-copy').forEach(node=>node.remove());document.body.classList.remove('drag-active','drag-invalid');root.replaceChildren()};
}
