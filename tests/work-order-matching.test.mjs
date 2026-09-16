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
const {priorityForCategory,categoryFromIssue,inferWorkOrder}=suggestionExports;
const source=readFileSync(new URL('../src/app/work-orders/page.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('page.tsx',source,99,true,ts.ScriptKind.TSX);
const helpers=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name?.text!=='WorkOrdersPage').map(n=>n.getText(ast));
let matching;
function find(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='applySmartSuggestions')matching=n.getText(ast);ts.forEachChild(n,find);}find(ast);
assert.ok(matching,'must exercise the real matcher');
const code=ts.transpileModule(helpers.join('\n')+'\n'+matching+'\nexports.match=applySmartSuggestions;',{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
const locations=[409,410].map(n=>({id:String(n),name:`Room ${n}`,room_number:String(n),area:'Guest Rooms',location_type:'Guest Room'}));
const assets=locations.map(l=>({id:`vtac-${l.id}`,location_id:l.id,asset_type:'VTAC',name:`VTAC - Room ${l.id}`,manufacturer:'Friedrich',active:true}));
function fixture(overrides={}){
  const writes={};const exports={};
  const context={exports,classifyAsset,priorityForCategory,categoryFromIssue,inferWorkOrder,isFrontDeskUser:false,isSubmitOnlyUser:false,locations,assets,locationId:'409',assetId:'',manualLocation:true,manualAsset:false,manualCategory:false,manualPriority:false,...overrides};
  for(const key of ['LocationId','AssetId','Category','Priority'])context['set'+key]=value=>{writes[key[0].toLowerCase()+key.slice(1)]=value;};
  vm.runInNewContext(code,context);return {match:exports.match,writes};
}
test('cooling issue selects the current room VTAC with High priority',()=>{
  const f=fixture();f.match('not cooling','');assert.equal(f.writes.assetId,'vtac-409');assert.equal(f.writes.category,'HVAC');assert.equal(f.writes.priority,'High');
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
test('pool pump remains Pool',()=>assert.equal(classifyAsset({asset_type:'Pool Pump',name:'Hayward - Pool Pump Room'}),'Pool'));
test('surveillance camera is Safety and Enseo STB is TV / AV',()=>{
  assert.equal(classifyAsset({asset_type:'Camera',name:'Camera - Lobby'}),'Safety');
  assert.equal(classifyAsset({asset_type:'STB',name:'Enseo - Room 103B'}),'TV / AV');
});

test('front desk replaces stale guesses with the same canonical result used on submission',()=>{
  const f=fixture({isFrontDeskUser:true,isSubmitOnlyUser:true,assetId:'stale',manualAsset:true,manualCategory:true,manualPriority:true});f.match('not cooling','');assert.equal(f.writes.assetId,'vtac-409');assert.equal(f.writes.category,'HVAC');assert.equal(f.writes.priority,'High');
});
test('front desk does not display unassigned inventory as room equipment',()=>{
  const f=fixture({isFrontDeskUser:true,isSubmitOnlyUser:true,assets:[{id:'stock-vtac',location_id:null,asset_type:'VTAC',name:'VTAC inventory',active:true}]});f.match('not cooling','');assert.equal(f.writes.assetId,'');assert.equal(f.writes.category,'HVAC');
});
