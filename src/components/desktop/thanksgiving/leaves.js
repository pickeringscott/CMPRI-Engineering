/* Local animation only: no network or database access. */
(()=>{
 const layouts=JSON.parse(document.getElementById('theme-layouts').textContent),scene=document.getElementById('scene'),reduced=matchMedia('(prefers-reduced-motion:reduce)');
 const fields={leavesA:document.getElementById('leavesA'),leavesB:document.getElementById('leavesB')};
 const colors=['#e9a830','#d76320','#b43d21','#ecc15a','#ce6228','#b39a48'];
 const midrib='M30 10L30 66M30 32L17 25M30 42L44 33M30 52L18 45';
 const shapes=[
  {name:'White oak',outline:'M30 3C41 2 43 12 35 17C51 9 57 22 42 28C61 23 62 38 44 40C59 47 49 57 36 49L32 62L28 62L25 51C10 62 1 49 17 41C0 42 0 27 18 29C2 20 13 10 25 18C16 8 23 2 30 3Z',veins:midrib},
  {name:'Sugar maple',outline:'M30 2L36 20L44 13L43 29L58 25L49 39L54 45L35 50L31 64L28 64L28 51L8 47L14 39L2 25L19 29L17 13L25 20Z',veins:'M30 7L30 64M30 47L8 29M30 47L53 28M30 43L20 19M30 43L43 18'},
  {name:'American elm',outline:'M29 3L35 12L40 13L40 18L46 20L44 25L51 29L47 34L52 39L46 43L48 48L41 52L38 57L31 60L29 66L27 65L28 58L21 56L15 53L13 49L9 46L12 41L7 37L11 32L8 28L14 25L12 20L19 18L20 13L25 11Z',veins:'M29 8L29 65M29 21L38 16M29 30L44 23M29 40L47 32M29 49L43 42M29 23L20 17M29 33L15 26M29 43L13 36M29 52L17 45'},
  {name:'Green ash',outline:'M30 2Q45 12 30 25Q15 12 30 2Z M27 27Q6 8 7 27Q12 38 27 30Z M33 27Q54 8 53 27Q48 38 33 30Z M27 41Q4 23 6 43Q14 53 27 44Z M33 41Q56 23 54 43Q46 53 33 44Z M28 54Q9 40 12 57Q21 64 28 57Z M32 54Q51 40 48 57Q39 64 32 57Z',veins:'M30 9L30 68M30 29L11 20M30 29L49 20M30 43L10 36M30 43L50 36M30 56L15 51M30 56L45 51'},
  {name:'American sycamore',outline:'M30 2L39 24L47 17L45 31L59 32L48 43L52 51L36 53L31 66L28 65L28 54L10 54L14 44L1 33L16 31L13 17L23 24Z',veins:'M30 8L30 65M30 48L7 35M30 48L53 35M30 42L17 21M30 42L44 21'},
  {name:'Eastern cottonwood',outline:'M30 3L35 13L40 19L41 24L47 28L47 33L53 39L51 44L57 50L52 54L44 55L39 59L31 58L30 66L28 66L27 58L20 60L15 56L7 55L4 50L9 44L7 40L14 34L14 29L20 25L21 19L26 13Z',veins:'M30 9L29 66M29 55L9 49M29 55L51 48M29 46L15 34M29 46L44 31M29 34L23 22M29 34L37 22'},
  {name:'Northern catalpa',outline:'M30 3C25 15 5 17 4 34C2 50 16 59 28 52L29 66L32 66L32 52C44 60 59 50 57 35C56 18 37 15 30 3Z',veins:'M30 9L30 66M30 52Q17 47 9 32M30 52Q43 46 52 32M30 44L18 25M30 44L43 25M30 31L24 18M30 31L36 18'},
  {name:'Bur oak',outline:'M30 3C42 1 49 10 41 17C54 12 61 24 47 29C59 31 57 42 42 40L36 44C48 44 53 54 41 58L33 57L32 67L29 67L28 57C14 63 9 54 21 46L23 41C3 47-1 33 14 30C0 24 6 13 19 18C11 9 18 2 30 3Z',veins:'M30 9L30 66M30 20L22 11M30 20L38 11M30 31L12 22M30 31L49 22M30 39L13 37M30 39L47 36M30 51L18 53M30 51L43 52'},
  {name:'Pawpaw',outline:'M30 2C43 6 49 18 47 32C45 47 36 58 31 64L31 69L28 69L29 63C20 54 12 43 12 29C11 15 20 6 30 2Z',veins:'M30 7L30 67M30 18L38 13M30 28L43 20M30 38L43 29M30 48L40 40M30 56L35 50M30 22L21 15M30 32L17 24M30 42L18 34M30 52L23 44'}
 ];
 // Retain landed leaves separately from the 96 falling leaves. Each field keeps
 // its own bounded pile, preserving its existing place behind/in front of the art.
 const capacity=600, piles={leavesA:[],leavesB:[]};
 let config={count:0,size:42},pool=[],last=0,elapsed=0,paused=false;
 const rnd=(a,b)=>a+Math.random()*(b-a);
 const fieldFor=v=>v.index%2===0?'leavesA':'leavesB';
 const pileHeight=h=>Math.min(100,h*.125);
 function shapeMarkup(shape){return '<svg viewBox="0 0 60 70" aria-hidden="true"><path d="'+shape.outline+'" fill="currentColor" stroke="#743c20" stroke-width="1.1"/><path d="'+shape.veins+'" fill="none" stroke="#69371b" stroke-opacity=".78" stroke-width="1.05" stroke-linecap="round"/></svg>'}
 function applySize(v){v.size=config.size*v.scale;v.e.style.width=v.size+'px';v.e.style.height=v.size*70/60+'px'}
 function create(index){const e=document.createElement('span'),species=index%shapes.length;e.className='leaf';e.dataset.species=shapes[species].name;e.innerHTML=shapeMarkup(shapes[species]);e.style.color=colors[index%colors.length];const v={e,index,species,scale:rnd(.8,1.2),duration:rnd(9500,16500),x:rnd(.01,.99),depth:rnd(0,1),phase:rnd(0,7),sway:rnd(20,80),turn:rnd(-540,540),angle:rnd(0,360),born:0};v.born=elapsed-(index+.5)/Math.max(1,config.count)*v.duration;applySize(v);return v}
 function position(v,p,w,h){const flat=.28,radius=v.size*flat*.71,cap=Math.max(radius*2,pileHeight(h)),rise=radius+v.depth*Math.max(0,cap-radius*2),y=h-rise,dx=Math.sin(p*7+v.phase)*v.sway*(1-p);v.e.style.transform='translate('+(v.x*w+dx-v.size/2)+'px,'+(-v.size+(y+v.size)*p-v.size/2)+'px) scaleY('+(1-p*(1-flat))+') rotate('+(v.angle+(1-p)*v.turn)+'deg)';v.e.classList.toggle('settled',p>=1)}
 function land(v,w,h){
  const field=fieldFor(v),pile=piles[field],limit=capacity/2;
  // Reuse a ground leaf only after this layer reaches its capacity. Nothing
  // disappears from the accumulated pile when a falling leaf starts again.
  const e=pile.length===limit?pile.shift().e:v.e.cloneNode(true);
  e.innerHTML=v.e.innerHTML;e.dataset.species=v.e.dataset.species;e.style.cssText=v.e.style.cssText;
  const leaf={...v,e,depth:v.depth*Math.sqrt((pile.length+1)/limit)};
  position(leaf,1,w,h);pile.push(leaf);fields[field].append(e);
  v.born=elapsed;v.x=rnd(.01,.99);v.phase=rnd(0,7);v.turn=rnd(-540,540);
 }
 function paint(ground=false){
  const w=scene.clientWidth,h=scene.clientHeight;
  for(const v of pool)position(v,reduced.matches?1:Math.min(1,(elapsed-v.born)/v.duration),w,h);
  if(ground)for(const pile of Object.values(piles))for(const v of pile)position(v,1,w,h);
  const landed=piles.leavesA.length+piles.leavesB.length;
  scene.dataset.active=reduced.matches?0:pool.length;scene.dataset.settled=landed+(reduced.matches?pool.length:0);
  scene.dataset.leafCount=pool.length;scene.dataset.totalLeaves=pool.length+landed;scene.dataset.leafSize=config.size;
  scene.dataset.pileCapacity=capacity;scene.dataset.pileHeight=pileHeight(h);
 }
 function configure(next){
  const count=Math.max(0,Math.min(96,Math.round(next.count))),size=Math.max(12,Math.min(100,Math.round(next.size))),changed=size!==config.size;config={count,size};
  while(pool.length>count)pool.pop().e.remove();while(pool.length<count)pool.push(create(pool.length));
  for(const v of pool){const target=fields[fieldFor(v)];if(v.e.parentNode!==target)target.append(v.e);if(changed)applySize(v);}
  for(const pile of Object.values(piles)){if(!count){for(const v of pile)v.e.remove();pile.length=0;}else if(changed)for(const v of pile)applySize(v);}
  paint(true);
 }
 function frame(t){
  const dt=last?Math.min(t-last,100):0;last=t;
  if(!paused&&!reduced.matches&&!document.hidden){elapsed+=dt;const w=scene.clientWidth,h=scene.clientHeight;for(const v of pool)if(elapsed-v.born>=v.duration)land(v,w,h);paint();}
  requestAnimationFrame(frame);
 }
 const toggle=document.getElementById('toggle');toggle.addEventListener('click',()=>{paused=!paused;scene.classList.toggle('paused',paused);toggle.setAttribute('aria-pressed',String(paused));toggle.setAttribute('aria-label',paused?'Resume animation':'Pause animation');});
 reduced.addEventListener('change',()=>paint(true));addEventListener('resize',()=>paint(true));
 window.cmpriLeaves={configure,species:shapes.map(s=>s.name),shapeMarkup};configure(layouts[matchMedia('(max-width: 767px)').matches?'mobile':'desktop'].leaves);requestAnimationFrame(frame);
})();
