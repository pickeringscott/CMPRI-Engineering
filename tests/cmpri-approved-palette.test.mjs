import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {headerActionStyle as rawHeader,modalThemeStyle as rawTheme,modalTitleStyle as rawTitle,modalLauncherStyle,modalActionForRoute,modalDisplayTitle,hasBonvoyTierHelp} from '../src/lib/ui/header-palette.ts';
import {sitePalette,sitePaletteTokens} from '../src/lib/ui/site-palette-defaults.ts';
const palette=JSON.parse(readFileSync('src/lib/ui/site-palette.json','utf8'));
function resolveTokens(value){
 let text=value;
 for(let n=0;n<30;n++){
  const match=/var\(--cmpri-palette-([a-z0-9-]+),/.exec(text);if(!match)return text;
  const start=match.index;let depth=1,end=start+match[0].length;
  for(;end<text.length&&depth;end++){if(text[end]==='(')depth++;if(text[end]===')')depth--;}
  const fallback=text.slice(start+match[0].length,end-1);
  text=text.slice(0,start)+(sitePaletteTokens[match[1]]||fallback)+text.slice(end);
 }
 return text;
}
const resolved=style=>Object.fromEntries(Object.entries(style).map(([key,value])=>[key,resolveTokens(value)]));
const headerActionStyle=name=>resolved(rawHeader(name)),modalThemeStyle=name=>resolved(rawTheme(name)),modalTitleStyle=name=>resolved(rawTitle(name));
test('home tab buttons use their destination modal colors, including Hours Tracker and route aliases',()=>{
 for(const [href,label] of [['work-order-list','Work Order List'],['/engineering/room-operations','Daily Room Ops'],['/staff-notes','Staff Notes'],['/engineering/hours-tracker','Hours Tracker'],['/management/rooms','Manage Rooms'],['/engineering/purchasing','PO'],['/feedback','Feedback (7)'],['sign-out','Sign Out'],['/technician','Technician Dashboard']]){
  const launcher=modalLauncherStyle(href,label),modal=rawTitle(modalActionForRoute(href,label));
  assert.equal(launcher['background-color'],modal.backgroundColor,label);
  assert.equal(launcher['border-color'],modal.borderColor,label);
  assert.equal(launcher.color,modal.color,label);
 }
});
test('Bonvoy help belongs to the list, ticket and Daily Room Ops modal title bars',()=>{
 for(const href of ['work-order-list','/work-orders/00000000-0000-4000-8000-000000000001?embedded=1','/engineering/room-operations'])assert.equal(hasBonvoyTierHelp(href),true,href);
 for(const href of ['/work-orders','/staff-notes','/engineering/hours-tracker','/engineering'])assert.equal(hasBonvoyTierHelp(href),false,href);
});
test('every action uses the shared team palette while retaining inventory and numbered-label mapping',()=>{
 const html=readFileSync('.bridge/ChatGPT Errors/CMPRI-selected-tabbed-pills (2).html','utf8');
 const inventory=JSON.parse(html.match(/const inventories=(\{[^\n]+\});/)[1]);
 const names=[...new Set(Object.values(inventory).flatMap(groups=>groups.flatMap(g=>g.slice(1))))];
 for(const name of names){
  if(name==='Sign Out')continue;
  const rgb=name.includes('Maintenance')?palette.maintenance:palette.accents[names.indexOf(name)%palette.accents.length].rgb;
  assert.equal(headerActionStyle(name)['--action-rgb'],rgb,name);
  if(name==='Hours Tracker')continue; // Its dedicated modal palette is checked below.
  const theme=modalThemeStyle(name);assert.equal(theme['--cmpri-modal-base'],palette.modalBase);assert.equal(theme['--cmpri-modal-text'],headerActionStyle(name).color);assert.equal(theme['--cmpri-outline'],`rgba(${rgb},.42)`);assert.equal(theme['--cmpri-scroll-thumb'],`rgba(${rgb},.28)`);assert.equal(modalTitleStyle(name).backgroundColor,headerActionStyle(name)['background-color']);
 }
 assert.deepEqual(headerActionStyle('Feedback (7)'),headerActionStyle('Feedback'));
});

test('special team palettes resolve consistently for embedded routes and desktop titles',()=>{
 for(const [route,action,name] of [
  ['/work-orders?embedded=1','Create Work Order','create'],
  ['/work-orders/abc?embedded=1','Work Order Detail','detail'],
  ['/engineering/hours-tracker?embedded=1','Hours Tracker','hours'],
 ]){
  const {rgb,base}=palette.special[name];
  assert.equal(modalActionForRoute(route),action);
  const theme=modalThemeStyle(action);
  assert.equal(theme['--cmpri-action-rgb'],rgb);
  assert.equal(theme['--cmpri-modal-base'],base);
  assert.ok(theme['--cmpri-modal-surface'].includes(base));
  assert.ok(modalTitleStyle(action).backgroundColor.includes(rgb));
  assert.equal(modalTitleStyle(action).color,theme['--cmpri-modal-text']);
 }
 assert.equal(modalThemeStyle('Work Order List')['--cmpri-action-rgb'],palette.accents[0].rgb);
 assert.deepEqual(modalThemeStyle('+ Work Order'),modalThemeStyle('Create Work Order'));
});

test('Manage Locations keeps its route identity and labels both hosts consistently',()=>{
 assert.deepEqual(headerActionStyle('Manage Locations'),headerActionStyle('Manage Rooms'));
 assert.equal(modalActionForRoute('/management/rooms?embedded=1'),'Manage Locations');
 assert.equal(modalDisplayTitle('/management/rooms','Manage Rooms'),'Manage Locations');
 assert.equal(modalDisplayTitle('/management/rooms?embedded=1','Rooms'),'Manage Locations');
 assert.equal(modalDisplayTitle('/work-orders','Create Work Order'),'Create Work Order');
});

test('all shared header and modal styles use site palette tokens',()=>{
 for(const name of ['Work Order List','Staff Notes','Create Work Order','Work Order Detail','Hours Tracker','Manage Locations','Sign Out']){
  assert.ok(Object.values(rawTheme(name)).some(value=>value.includes('var(--cmpri-palette-')),name);
 }
});


test('the single palette source covers every surface with Illinois orange, Iowa gold, black and warm neutrals',()=>{
 assert.deepEqual(sitePalette,palette,'generated defaults must match the palette file');
 assert.equal(palette.accents[0].rgb,'255,95,5','Illinois orange');
 assert.equal(palette.accents[1].rgb,'255,205,0','Iowa gold');
 assert.equal(palette.semantic.gold,'#ffcd00');
 assert.equal(palette.semantic['control-rgb'],'255,95,5');
 assert.equal(palette.desktop['tone-13'],'#000000','the page canvas is Iowa black');
 assert.equal(palette.special.create.rgb,'255,95,5');
 assert.equal(palette.special.detail.rgb,'255,205,0');
 const rgb=value=>{
  if(/^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i.test(value))return [1,3,5].map(n=>parseInt(value.slice(n,n+2),16));
  const match=/^(?:rgb\()?([0-9]+),([0-9]+),([0-9]+)\)?$/.exec(value);
  return match?match.slice(1).map(Number):null;
 };
 const check=(value,path)=>{
  if(typeof value==='object')return Object.entries(value).forEach(([key,item])=>check(item,path+'.'+key));
  if(typeof value!=='string')return;
  const channels=rgb(value);if(!channels)return;
  const [red,green,blue]=channels;
  assert.ok(red>=green && green>=blue,path+' contains an unrelated blue/purple/green color: '+value);
 };
 check(palette,'palette');
 for(const [name,scheme] of Object.entries(palette.special)){
  const [r,g,b]=rgb(scheme.base);assert.equal(r,g,name+' modal base');assert.equal(g,b,name+' modal base');
 }
 for(const state of ['pending','open','progress','priority','overdue','completed','closed','all'])assert.ok(rgb(palette.semantic[state]),state+' needs a palette token');
 const css=readFileSync('src/app/site-palette.css','utf8');
 for(const [name,value] of Object.entries(sitePaletteTokens))assert.ok(css.includes('--cmpri-palette-'+name+':'+value+';'),name+' missing from generated CSS');
});

test('every utility color family follows the team palette in host and modal documents',()=>{
 const css=readFileSync('src/app/site-palette.css','utf8');
 const bridge=css.slice(css.indexOf(':where(html)[data-cmpri-site-theme="illinois-iowa"]'));
 assert.ok(bridge.startsWith(':where(html)[data-cmpri-site-theme="illinois-iowa"]{'),'the site flag must activate the bridge without outranking modal-local slate variables');
 const families=['slate','gray','zinc','neutral','stone','blue','sky','cyan','indigo','violet','purple','fuchsia','pink','rose','red','orange','amber','yellow','lime','green','emerald','teal'];
 const steps=[50,100,200,300,400,500,600,700,800,900,950];
 for(const family of families)for(const step of steps)assert.ok(bridge.includes('--color-'+family+'-'+step+':'),family+'-'+step+' must be themed');
 assert.ok(bridge.includes('--color-white:var(--cmpri-palette-white);'));
 assert.ok(bridge.includes('--color-black:var(--cmpri-palette-black);'));
 for(const family of ['slate','gray','zinc','neutral','stone']){
  assert.ok(bridge.includes('--color-'+family+'-950:var(--cmpri-palette-desktop-tone-1);'));
  assert.ok(bridge.includes('--color-'+family+'-900:var(--cmpri-palette-desktop-tone-2);'));
  assert.ok(bridge.includes('--color-'+family+'-50:var(--cmpri-palette-white);'));
 }
 for(const family of ['red','orange','rose','pink','fuchsia'])assert.ok(bridge.includes('--color-'+family+'-500:rgb(var(--cmpri-palette-control-rgb));'),family+' uses Illinois orange');
 for(const family of ['blue','sky','cyan','indigo','violet','purple','amber','yellow','lime','green','emerald','teal'])assert.ok(bridge.includes('--color-'+family+'-500:var(--cmpri-palette-gold);'),family+' uses Iowa gold');
 assert.match(bridge,/--color-orange-50:color-mix\(in srgb, rgb\(var\(--cmpri-palette-control-rgb\)\) 6%, var\(--cmpri-palette-white\)\);/);
 assert.match(bridge,/--color-blue-950:color-mix\(in srgb, var\(--cmpri-palette-gold\) 13%, var\(--cmpri-palette-black\)\);/);
 assert.doesNotMatch(bridge,/#(?:[\da-f]{3})\b|#[\da-f]{6}\b/i,'utility ramp colors must come from the single JSON palette through variables');
});
