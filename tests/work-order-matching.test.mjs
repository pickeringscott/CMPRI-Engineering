import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { classifyAsset } from '../src/lib/asset-category.ts';
import { normalizeWorkOrderCategory } from '../src/lib/work-order-categories.ts';
const suggestionExports = {};
const requireStub = (mod) => {
  if (mod.includes('asset-category')) return { classifyAsset };
  if (mod.includes('work-order-categories')) return { normalizeWorkOrderCategory, WORK_ORDER_CATEGORIES: ['General','HVAC','Plumbing','Electrical','Appliances','Doors/Locks','Pool/Spa','Laundry','Public Area','Safety','TV / AV','Furniture'], categoryOptions: () => [] };
  return {};
};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/work-order-suggestions.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:suggestionExports,require:requireStub});
const creationExports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/work-order-creation.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:creationExports,require:requireStub});
const {findLocationFromText} = creationExports;
const {priorityForCategory,categoryFromIssue,inferWorkOrder,assetTermsForPlumbingIssue,separateIssueFromReporterNotes}=suggestionExports;
const source=readFileSync(new URL('../src/app/work-orders/page.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('page.tsx',source,99,true,ts.ScriptKind.TSX);
const helpers=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text!=='WorkOrdersPage').map(n=>n.getText(ast));
let matching;
function find(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='applySmartSuggestions')matching=n.getText(ast);ts.forEachChild(n,find);}find(ast);
assert.ok(matching,'must exercise the real matcher');
const code=ts.transpileModule(helpers.join('\n')+'\n'+matching+'\nexports.match=applySmartSuggestions;',{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React},
}).outputText;
const locations=[409,410].map(n=>({id:String(n),name:`Room ${n}`,room_number:String(n),area:'Guest Rooms',location_type:'Guest Room'}));
const assets=locations.map(l=>({id:`vtac-${l.id}`,location_id:l.id,asset_type:'VTAC',name:`VTAC - Room ${l.id}`,manufacturer:'Friedrich',active:true}));
function fixture(overrides={}){
  const writes={};const exports={};
  const context={exports,classifyAsset,priorityForCategory,categoryFromIssue,inferWorkOrder,separateIssueFromReporterNotes,findLocationFromText,isFrontDeskUser:false,isSubmitOnlyUser:false,locations,assets,locationId:'409',assetId:'',manualLocation:true,manualAsset:false,manualCategory:false,manualPriority:false,...overrides};
  context.systemAssignedTechnicalFields=overrides.systemAssignedTechnicalFields ?? context.isSubmitOnlyUser;
  for(const key of ['LocationId','AssetId','Category','Priority'])context['set'+key]=value=>{writes[key[0].toLowerCase()+key.slice(1)]=value;};
  vm.runInNewContext(code,context);return {match:exports.match,writes};
}
test('cooling issue selects the current room VTAC with High priority',()=>{
  const f=fixture();f.match('not cooling','');assert.equal(f.writes.assetId,'vtac-409');assert.equal(f.writes.category,'HVAC');assert.equal(f.writes.priority,'High');
});
test('room number and AC shorthand select the matching room equipment',()=>{
  const location={id:'321',name:'Room 321',room_number:'321',area:'Guest Rooms',location_type:'Guest Room'};
  const asset={id:'vtac-321',location_id:'321',asset_type:'VTAC',name:'VTAC - Room 321',manufacturer:'Friedrich',active:true};
  const f=fixture({locations:[...locations,location],assets:[...assets,asset],manualLocation:false});
  f.match('321, no AC','');assert.equal(f.writes.locationId,'321');assert.equal(f.writes.assetId,'vtac-321');assert.equal(f.writes.category,'HVAC');
});
test('AC symptom selects the air conditioner ahead of another HVAC asset',()=>{
  const candidates=[
    {id:'a-thermostat',location_id:'409',asset_type:'Thermostat',name:'Room Thermostat - Room 409',active:true},
    {id:'z-vtac',location_id:'409',asset_type:'VTAC',name:'VTAC - Room 409',active:true},
  ];
  const suggestion=inferWorkOrder('No AC',candidates);
  assert.equal(suggestion.assetId,'z-vtac');
  assert.equal(suggestion.category,'HVAC');
});
test('ambiguous equipment guesses stay unassigned instead of selecting by ID order',()=>{
  const candidates=[
    {id:'a-vtac',location_id:'409',asset_type:'VTAC',name:'VTAC - Room 409',active:true},
    {id:'b-vtac',location_id:'409',asset_type:'VTAC',name:'VTAC - Room 409 backup',active:true},
  ];
  assert.equal(inferWorkOrder('No AC',candidates).assetId,null);
});
test('named lobby with AC shorthand uses lobby equipment',()=>{
  const location={id:'lobby',name:'Lobby / General',room_number:null,area:'Lobby',location_type:'Public Area'};
  const asset={id:'lobby-hvac',location_id:'lobby',asset_type:'HVAC',name:'Lobby HVAC',active:true};
  const f=fixture({locations:[...locations,location],assets:[...assets,asset],manualLocation:false});
  f.match('Lobby no AC','');assert.equal(f.writes.locationId,'lobby');assert.equal(f.writes.assetId,'lobby-hvac');assert.equal(f.writes.category,'HVAC');
});
test('TV and light reports infer their work-order categories and assigned assets',()=>{
  const television={id:'tv-321',location_id:'409',asset_type:'Television',name:'TV - Room 409',active:true};
  const light={id:'light-321',location_id:'409',asset_type:'Light Fixture',name:'Light Bulb - Room 409',active:true};
  const tvGuess=inferWorkOrder('broken TV',[television]);
  const lightGuess=inferWorkOrder('light bulb out',[light]);
  assert.equal(tvGuess.assetId,'tv-321');assert.equal(tvGuess.category,'TV / AV');
  assert.equal(lightGuess.assetId,'light-321');assert.equal(lightGuess.category,'Electrical');
});
test('guest-reported fridge noise remains an Appliances work order',()=>{
  const split=separateIssueFromReporterNotes('Guest reports that the fridge makes loud noises');
  const fridge={id:'fridge-321',location_id:'409',asset_type:'Refrigerator',name:'Fridge - Room 409',active:true};
  const suggestion=inferWorkOrder(split.issue,[fridge]);
  assert.equal(split.issue,'the fridge makes loud noises');
  assert.equal(split.reporterNotes,'');
  assert.equal(suggestion.assetId,'fridge-321');
  assert.equal(suggestion.category,'Appliances');
});
test('guest departure commentary is separated from the maintenance issue',()=>{
  const result=separateIssueFromReporterNotes('No AC in room 321\nGuest is going to leave at 5 PM');
  assert.equal(result.issue,'No AC in room 321');
  assert.equal(result.reporterNotes,'Guest is going to leave at 5 PM');
});
test('explicit room change ignores stale prior selection flags',()=>{
  const f=fixture({assetId:'vtac-409',manualAsset:true,manualCategory:true,manualPriority:true});
  f.match('not cooling','',locations[1]);assert.equal(f.writes.assetId,'vtac-410');assert.equal(f.writes.category,'HVAC');assert.equal(f.writes.priority,'High');
});
test('typing respects manually selected equipment/category/priority',()=>{
  const f=fixture({assetId:'vtac-409',manualAsset:true,manualCategory:true,manualPriority:true});f.match('not cooling','');assert.deepEqual(f.writes,{});
});
test('empty issue and notes do not alter selections',()=>{
  const f=fixture();f.match('','');assert.deepEqual(f.writes,{});
});
test('unresolved location cannot assign another rooms equipment',()=>{
  const f=fixture({locationId:'missing'});f.match('not cooling','');assert.deepEqual(f.writes,{});
});
test('HVAC equipment in the pool room stays HVAC',()=>assert.equal(classifyAsset({asset_type:'VTAC',name:'VTAC - Pool Room'}),'HVAC'));
test('pool pump uses canonical Pool/Spa',()=>assert.equal(classifyAsset({asset_type:'Pool Pump',name:'Hayward - Pool Pump Room'}),'Pool/Spa'));
test('surveillance camera is Safety and Enseo STB is TV / AV',()=>{
  assert.equal(classifyAsset({asset_type:'Camera',name:'Camera - Lobby'}),'Safety');
  assert.equal(classifyAsset({asset_type:'STB',name:'Enseo - Room 103B'}),'TV / AV');
});

test('front desk replaces stale guesses with the same canonical result used on submission',()=>{
  const f=fixture({isFrontDeskUser:true,isSubmitOnlyUser:true,assetId:'stale',manualAsset:true,manualCategory:true,manualPriority:true});f.match('not cooling','');assert.equal(f.writes.assetId,'vtac-409');assert.equal(f.writes.category,'HVAC');assert.equal(f.writes.priority,'High');
});
test('General Managers cannot preserve manually selected engineering-owned creation fields',()=>{
  const f=fixture({systemAssignedTechnicalFields:true,assetId:'stale',manualAsset:true,manualCategory:true,manualPriority:true});
  f.match('not cooling','');
  assert.equal(f.writes.assetId,'vtac-409');
  assert.equal(f.writes.category,'HVAC');
  assert.equal(f.writes.priority,'High');
});
test('front desk does not display unassigned inventory as room equipment',()=>{
  const f=fixture({isFrontDeskUser:true,isSubmitOnlyUser:true,assets:[{id:'stock-vtac',location_id:null,asset_type:'VTAC',name:'VTAC inventory',active:true}]});f.match('not cooling','');assert.equal(f.writes.assetId,'');assert.equal(f.writes.category,'HVAC');
});
test('plumbing split preview does not match a sink report to a shower-only asset',()=>{
  const terms=Array.from(assetTermsForPlumbingIssue('Bathroom sink leaking'));
  const matches=asset=>terms.some(term=>`${asset.name} ${asset.asset_type}`.toLowerCase().includes(term));
  assert.deepEqual(terms,['sink']);
  assert.equal(matches({name:'Shower curtain - Room 101',asset_type:'Shower Curtain'}),false);
  assert.equal(matches({name:'Sink - Room 101',asset_type:'Plumbing Fixture'}),true);
});

test('desk lamps and bulbs classify before incidental furniture words',()=>{
  for(const name of ['Desk lamp','Desk-lamp bulb','Floor lamp','Bulb']){
    const asset={id:name,name,asset_type:name,active:true};
    assert.equal(classifyAsset(asset),'Electrical');
    const result=inferWorkOrder(`${name} not working`,[asset]);
    assert.equal(result.assetId,name);assert.equal(result.category,'Electrical');assert.equal(result.priority,'Medium');
  }
  assert.equal(classifyAsset({name:'Desk',asset_type:'Furniture'}),'Furniture');
});
test('numbered washer selects exact unit, never another unit or a numeric substring',()=>{
  const candidates=[1,2,12].map(n=>({id:`washer-${n}`,name:`Washer #${n}`,asset_type:'Washer',active:true}));
  for(const issue of ['Washer #2 not draining','washer 2 stopped','Washer No. 2 not working'])assert.equal(inferWorkOrder(issue,candidates).assetId,'washer-2');
  assert.equal(inferWorkOrder('Washer #3 not draining',candidates).assetId,null);
  assert.equal(inferWorkOrder('Washer not draining',candidates).assetId,null);
  assert.equal(inferWorkOrder('Washer #2 stopped',candidates.map(a=>({...a,active:a.id!=='washer-2'}))).assetId,null);
});
test('pool equipment category and inferred category use the same canonical value',()=>{
  const asset={id:'filter',name:'Sand filter',asset_type:'Pool Filter',active:true};
  assert.equal(classifyAsset(asset),'Pool/Spa');
  const result=inferWorkOrder('Pool filter pressure high',[asset]);
  assert.equal(result.category,'Pool/Spa');assert.equal(result.assetId,'filter');assert.equal(result.priority,'High');
});
test('documentation availability does not establish which identical equipment is installed',()=>{
  const candidates=[{id:'a',name:'Washer',asset_type:'Washer'},{id:'b',name:'Washer',asset_type:'Washer',documentation_key:'manual'}];
  assert.equal(inferWorkOrder('Washer not draining',candidates).assetId,null);
});
test('locationless model and equipment from other rooms remain ineligible',()=>{
  const f=fixture({assets:[{id:'model',name:'Friedrich VTAC',asset_type:'VTAC',location_id:null,active:true},{id:'other',name:'VTAC',asset_type:'VTAC',location_id:'410',active:true}]});
  f.match('No AC','');assert.equal(f.writes.assetId,'');assert.equal(f.writes.category,'HVAC');
});
