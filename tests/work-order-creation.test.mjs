import {partsStatusDependency} from "./helpers/load-ts.mjs";
import { ticketReadDependency, loadTs } from "./helpers/load-ts.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
const root=fileURLToPath(new URL('../src/',import.meta.url));
const order={location_id:'location-409',issue:'Sink leaking',display_id:'WO-test',category:'Plumbing',priority:'Medium'};
function fixture(body,config={}) {
  const writes=[],clients=[];
  const profile={active:true,role:'Front Desk',full_name:'Shared Desk',...config.profile};
  const assets=config.assets??[{id:'asset',location_id:config.wrongAsset?'other':'location-409',name:'Verified sink',asset_type:'Plumbing',active:true}];
  const db={from(table){return {
    select(){return this;},eq(){return this;},in(){return this;},range(from,to){
      const rows = table === 'assets' ? assets : (config.existing || []);
      return Promise.resolve({data: rows.slice(from, to + 1), error: (table === 'assets' ? config.assetLookupError : config.duplicateError) ? {message:'Unavailable'} : null});
    },
    then(resolve){return Promise.resolve({data:table==='locations'?(config.noLocation?[]:(config.locations||[{id:'location-409',name:'Room 409'}])):assets,error:config.lookupError?{message:'Unavailable'}:null}).then(resolve);},
    limit:async()=>({data:table==='assets'?assets:(config.existing||[]),error:(table==='assets'?config.assetLookupError:config.duplicateError)?{message:'Unavailable'}:null}),
    insert:async rows=>{writes.push(...rows);return {error:config.insertError?{message:'Rejected'}:null};},
  };}};
  function load(file) {
    const exports={};
    vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,process:{env:config.noServiceRole?{}:{SUPABASE_SERVICE_ROLE_KEY:'service-role-test'}},
      require(name) { if(name === "@/lib/server/work-order-parts-status") return partsStatusDependency;
      if (name.includes("work-order-read-policy") || name.includes("work-order-reader")) return ticketReadDependency(name);
        if(name==='next/server')return {NextResponse:{json:(body,init={})=>({body,status:init.status??200})}};
        if(name==='@supabase/supabase-js')return {createClient:(url,key,options)=>{clients.push({url,key,options});return db;}};
        if(name==='@/lib/server/request-auth')return {authenticatedUser:async()=>config.unauthorized?null:{user:{id:'shared-id',email:'desk@example.invalid'},profile}};if(name==='server-only')return {};
        if(name==='@/lib/supabase/config')return {SUPABASE_URL:'https://test.invalid'};
        if(name==='@/lib/server/room-ranker')return {processRoomRankerSyncForWorkOrder:async()=>({processed:true})};
        let target=name.startsWith('@/')?path.join(root,name.slice(2)):path.resolve(path.dirname(file),name);if(!existsSync(target))target+='.ts';return load(target);
      },
    });return exports;
  }
  return {writes,clients,infer:load(path.join(root,'lib/work-order-suggestions.ts')).inferWorkOrder,handler:load(path.join(root,'app/api/work-orders/route.ts')).POST,request:{headers:new Headers({authorization:'Bearer caller-token'}),json:async()=>{if(config.badJson)throw new SyntaxError('bad');return body;}}};
}
for(const name of [undefined,'','   ',123,'1234','Scott123'])test(`front desk requires first name ${JSON.stringify(name)}`,async()=>{
  const f=fixture({orders:[order],staff_first_name:name});assert.equal((await f.handler(f.request)).status,400);assert.equal(f.writes.length,0);
});
for(const name of ['Scott','María','Anne-Marie','李'])test(`first name ${name} is stored with the shared account identity`,async()=>{
  const f=fixture({orders:[{...order,created_by:'spoof',creator_name:'Spoof',status:'Closed'}],staff_first_name:name});
  assert.equal((await f.handler(f.request)).status,200);assert.equal(f.writes[0].creator_name,name);assert.equal(f.writes[0].submitted_by_name,name);
  assert.equal(f.writes[0].created_by,'shared-id');assert.equal(f.writes[0].creator_account_user_id,'shared-id');assert.equal(f.writes[0].status,'Pending Verification');
  assert.equal(f.writes[0].creator_source,'front_desk_pending_verification');
  assert.equal(f.clients[0].key,'service-role-test');
  assert.equal(f.clients[0].options.auth.persistSession,false);
  assert.equal(f.clients[0].options.auth.autoRefreshToken,false);
});
test('batch submissions attribute every ticket to the same first name and account',async()=>{
  const f=fixture({orders:[order,{...order,issue:'Door sticks'}],staff_first_name:' Scott '});
  assert.equal((await f.handler(f.request)).status,200);assert.equal(f.writes.length,2);assert.ok(f.writes.every(row=>row.creator_name==='Scott'&&row.created_by==='shared-id'&&row.creator_source==='front_desk_pending_verification'));
});
test('Housekeeping submissions retain department provenance without a front-desk name',async()=>{
  const f=fixture({orders:[order]}, {profile:{role:'Housekeeping',full_name:'Audit Housekeeping'}});
  assert.equal((await f.handler(f.request)).status,200);
  assert.equal(f.writes[0].creator_name,'Audit Housekeeping');
  assert.equal(f.writes[0].submitted_by_name,null);
  assert.equal(f.writes[0].creator_source,'department_pending_verification');
  assert.equal(f.writes[0].status,'Pending Verification');
});
test('engineer identity comes from the signed-in profile, not submitted names',async()=>{
  const f=fixture({orders:[order],staff_first_name:'Spoof'},{profile:{role:'Engineer',full_name:'Scott Pickering'}});
  assert.equal((await f.handler(f.request)).status,200);assert.equal(f.writes[0].creator_name,'Scott Pickering');assert.equal(f.writes[0].submitted_by_name,null);
});
for(const config of [{unauthorized:true},{noLocation:true},{lookupError:true}])test(`creation rejects unavailable authority or target ${JSON.stringify(config)}`,async()=>{
  const f=fixture({orders:[{...order,asset_id:'asset'}],staff_first_name:'Scott'},config);assert.ok((await f.handler(f.request)).status>=400);assert.equal(f.writes.length,0);
});
for(const orders of [[],[null],[{...order,issue:' '}],[order,{...order,location_id:''}]])test(`invalid batch is rejected without partial insert ${JSON.stringify(orders)}`,async()=>{
  const f=fixture({orders,staff_first_name:'Scott'});assert.equal((await f.handler(f.request)).status,400);assert.equal(f.writes.length,0);
});
test('first-name field is required and all three creation paths use the common submission function',()=>{
  const source=readFileSync(path.join(root,'app/work-orders/page.tsx'),'utf8');
  assert.match(source,/Your first name/);assert.match(source,/<input required maxLength=\{80\}/);
  assert.equal((source.match(/await submitWorkOrders\(/g)||[]).length,4);
  assert.equal(/\.insert\(/.test(source),false);
});
test('only roles classified submit-only by the shared role policy lose draft controls',()=>{
  const source=readFileSync(path.join(root,'app/work-orders/page.tsx'),'utf8');
  const roles=readFileSync(path.join(root,'lib/server/roles.ts'),'utf8');
  assert.match(source,/!isSubmitOnlyUser && <button type="button" onClick=\{\(\) => void saveDraft\(\)\}/);
  assert.match(source,/const isSubmitOnlyUser = isSubmitOnlyRole\(currentRole\)/);
  assert.match(roles,/export const isSubmitOnlyRole = \(role: unknown\) =>\s*\[\s*"front_desk", "housekeeping"\s*\]\.includes\(roleKey\(role\)\)/);
  assert.doesNotMatch(source,/const isSubmitOnlyUser = \[[^\n]*(?:front desk manager|assistant general manager)/i);
  assert.match(source,/frontdeskmanager/);
  assert.match(source,/setTimeout\(\(\) => \{ void saveDraft\(true\); \}, 30 \* 60 \* 1000\)/);
});
test('issue-driven suggestions share inference with submit-only overrides',()=>{
  const source=readFileSync(path.join(root,'app/work-orders/page.tsx'),'utf8');
  const start=source.indexOf('function applySmartSuggestions(');
  const end=source.indexOf('function handleLocationChange(',start);
  assert.ok(start>=0&&end>start);
  const handler=source.slice(start,end);
  assert.match(handler,/inferWorkOrder\(/);
  assert.match(handler,/shouldAutoSelectAsset/);
  assert.match(handler,/systemAssignedTechnicalFields/);
});
test('troubleshooting guide is bottom-placed and restricted to maintenance roles',()=>{
  const source=readFileSync(path.join(root,'app/work-orders/page.tsx'),'utf8');
  assert.match(source,/"engineeringmanager".*"regionalmaintenance".*"technician".*"maintenancetechnician"/s);
  assert.match(source,/\.includes\(currentRoleKey\)/);
  const notesPosition=source.indexOf('Notes / Actions Taken');
  const guidePosition=source.indexOf('aria-label="Troubleshooting Guide"');
  const formEnd=source.indexOf('</form>',notesPosition);
  assert.ok(notesPosition>=0&&guidePosition>notesPosition&&formEnd>guidePosition);
});
test('duplicate tickets inside one batch are rejected without partial insertion',async()=>{
  const f=fixture({orders:[order,{...order,issue:'The sink is leaking'}],staff_first_name:'Scott'});
  assert.equal((await f.handler(f.request)).status,409);assert.equal(f.writes.length,0);
});
test('a saved matching ticket blocks any new ticket in the batch',async()=>{
  const f=fixture({orders:[{...order,issue:'Door sticks'},order],staff_first_name:'Scott'},{existing:[{...order,id:'existing-id',status:'Open'}]});
  const result=await f.handler(f.request);assert.equal(result.status,409);assert.equal(result.body.existing_work_order_id,'existing-id');assert.equal(f.writes.length,0);
});
for(const config of [{duplicateError:true},{existing:Array.from({length:1000},()=>({...order,issue:'Different task'}))}])test(`incomplete duplicate lookup fails closed: ${config.duplicateError?'error':'result limit reached'}`,async()=>{
  const f=fixture({orders:[order],staff_first_name:'Scott'},config);assert.equal((await f.handler(f.request)).status,503);assert.equal(f.writes.length,0);
});

test('front desk supplied equipment, category and priority cannot override server guesses',async()=>{
  const f=fixture({orders:[{...order,asset_id:'spoof',asset_name:'Fake TV',category:'Safety',priority:'Urgent'}],staff_first_name:'Scott'});
  assert.equal((await f.handler(f.request)).status,200);assert.equal(f.writes[0].asset_id,'asset');assert.equal(f.writes[0].asset_name,'Verified sink');assert.equal(f.writes[0].category,'Plumbing');assert.equal(f.writes[0].priority,'Medium');
});
test('front desk HVAC defaults to High based on location equipment and issue',async()=>{
  const f=fixture({orders:[{...order,issue:'not cooling',priority:'Low'}],staff_first_name:'Scott'},{assets:[{id:'vtac',location_id:'location-409',name:'VTAC – Room 409',asset_type:'VTAC',active:true}]});
  assert.equal((await f.handler(f.request)).status,200);assert.equal(f.writes[0].asset_id,'vtac');assert.equal(f.writes[0].priority,'High');
});
test('Lead Housekeeper HVAC reports use the same location-bound inference',async()=>{
  const f=fixture({orders:[{...order,issue:'no AC',asset_id:'spoof',asset_name:'Fake equipment',category:'General',priority:'Low'}]},{profile:{role:'Lead Housekeeper'},assets:[{id:'vtac',location_id:'location-409',name:'VTAC - Room 409',asset_type:'VTAC',active:true}]});
  assert.equal((await f.handler(f.request)).status,200);
  assert.equal(f.writes[0].asset_id,'vtac');assert.equal(f.writes[0].asset_name,'VTAC - Room 409');
  assert.equal(f.writes[0].category,'HVAC');assert.equal(f.writes[0].priority,'High');
});
test('guest departure comment is saved in notes beside the maintenance issue',async()=>{
  const f=fixture({orders:[{...order,issue:'TV is broken\nGuest is going to leave at 5 PM'}],staff_first_name:'Scott'});
  assert.equal((await f.handler(f.request)).status,200);
  assert.equal(f.writes[0].issue,'TV is broken');
  assert.equal(f.writes[0].notes,'Guest is going to leave at 5 PM');
  assert.equal(f.writes[0].reporter_notes,undefined);
});
test('reporter comments are appended to submitted notes without losing either',async()=>{
  const f=fixture({orders:[{...order,issue:'TV is broken\nGuest is going to leave at 5 PM',notes:'Remote was already replaced.'}],staff_first_name:'Scott'});
  assert.equal((await f.handler(f.request)).status,200);
  assert.equal(f.writes[0].notes,'Remote was already replaced.\nGuest is going to leave at 5 PM');
});
for(const role of ['Front Desk','Front Desk Manager','Assistant General Manager','Housekeeping','Lead Housekeeper','Sales Manager','General Manager','Maintenance Technician','Chief Engineer','System Administrator'])test(`reporter comments reach work-order notes for ${role} submissions`,async()=>{
  const f=fixture({orders:[{...order,issue:'TV is broken\nGuest is going to leave at 5 PM',notes:'Remote was already replaced.'}],staff_first_name:'Scott'},{profile:{role,full_name:'Test Submitter'}});
  assert.equal((await f.handler(f.request)).status,200);
  assert.equal(f.writes[0].issue,'TV is broken');
  assert.equal(f.writes[0].notes,'Remote was already replaced.\nGuest is going to leave at 5 PM');
});
test('multi-work-order submissions preserve each issue and move shared reporter context to notes atomically',async()=>{
  const f=fixture({orders:[
    {...order,issue:'TV is broken\nGuest is leaving at 5 PM'},
    {...order,issue:'Sink is leaking\nGuest is leaving at 5 PM'},
  ],staff_first_name:'Scott'});
  assert.equal((await f.handler(f.request)).status,200);
  assert.equal(f.writes.length,2);
  assert.deepEqual(f.writes.map(row=>row.issue),['TV is broken','Sink is leaking']);
  assert.deepEqual(f.writes.map(row=>row.notes),['Guest is leaving at 5 PM','Guest is leaving at 5 PM']);
});
test('guest departure comment alone cannot create another work order',async()=>{
  const f=fixture({orders:[{...order,issue:'Guest is going to leave at 5 PM'}],staff_first_name:'Scott'});
  assert.equal((await f.handler(f.request)).status,400);
  assert.equal(f.writes.length,0);
});
test('front desk cannot assign unlocated, retired or other-room equipment',async()=>{
  const f=fixture({orders:[{...order,issue:'not cooling',asset_id:'other'}],staff_first_name:'Scott'},{assets:[{id:'other',location_id:'other-room',name:'VTAC',asset_type:'VTAC'},{id:'retired',location_id:'location-409',name:'VTAC',asset_type:'VTAC',active:false},{id:'unlocated',location_id:null,name:'VTAC',asset_type:'VTAC'}]});
  assert.equal((await f.handler(f.request)).status,200);assert.equal(f.writes[0].asset_id,null);assert.equal(f.writes[0].category,'HVAC');assert.equal(f.writes[0].priority,'High');
});
for(const config of [{assetLookupError:true}])test('incomplete equipment lookup prevents partial or guessed writes',async()=>{
  const f=fixture({orders:[order],staff_first_name:'Scott'},config);assert.equal((await f.handler(f.request)).status,503);assert.equal(f.writes.length,0);
});
test('engineering assignment still rejects equipment from another room',async()=>{
  const f=fixture({orders:[{...order,asset_id:'asset'}]},{profile:{role:'Engineer'},wrongAsset:true});assert.equal((await f.handler(f.request)).status,400);assert.equal(f.writes.length,0);
});

test('the observed system_admin role can create a work order',async()=>{
  const f=fixture({orders:[order]},{profile:{role:'system_admin',full_name:'Engineer'}});assert.equal((await f.handler(f.request)).status,200);assert.equal(f.writes[0].creator_name,'Engineer');
});

test('general managers can create work orders without setting engineering-owned fields',async()=>{
  const f=fixture({
    orders:[{...order,asset_id:'forged-asset',asset_name:'Forged equipment',category:'Forged category',priority:'Urgent',technician_name:'Spoof',status:'Closed'}],
  },{profile:{role:'General Manager',full_name:'Audit Manager'}});
  assert.equal((await f.handler(f.request)).status,200);
  assert.equal(f.writes.length,1);
  assert.notEqual(f.writes[0].asset_id,'forged-asset');
  assert.notEqual(f.writes[0].asset_name,'Forged equipment');
  assert.notEqual(f.writes[0].category,'Forged category');
  assert.notEqual(f.writes[0].priority,'Urgent');
  assert.equal(f.writes[0].technician_name,'');
  assert.notEqual(f.writes[0].status,'Closed');
});

test('creation fails closed when server-only database credentials are unavailable',async()=>{
  const f=fixture({orders:[order],staff_first_name:'Scott'}, {noServiceRole:true});
  assert.equal((await f.handler(f.request)).status,503);
  assert.equal(f.writes.length,0);
  assert.equal(f.clients.length,0);
});

test('submit-only work orders page past the 1000-asset threshold without failing closed',async()=>{
  const assets = Array.from({length:1250},(_,index)=>({id:`asset-${index}`,location_id:'location-409',name:`Asset ${index}`,asset_type:'HVAC',active:true}));
  const f=fixture({orders:[{...order,issue:'not cooling',priority:'Low'}],staff_first_name:'Scott'},{assets});
  assert.equal((await f.handler(f.request)).status,200);
  assert.equal(f.writes[0].category,'HVAC');
  assert.equal(f.writes[0].priority,'High');
});

test('assetless work orders still infer the category and priority from the issue',async()=>{
  const f=fixture({orders:[{...order,asset_id:null,asset_name:'',category:'General',priority:'Medium',issue:'not cooling'}],staff_first_name:'Scott'});
  assert.equal((await f.handler(f.request)).status,200);
  assert.equal(f.writes[0].category,'HVAC');
  assert.equal(f.writes[0].priority,'High');
});

test('mixed maintenance reports split into separate reviewable work orders',()=>{
  const creationSource=readFileSync(path.join(root,'lib/work-order-creation.ts'),'utf8');
  const suggestionsSource=readFileSync(path.join(root,'lib/work-order-suggestions.ts'),'utf8');
  const categoriesSource=readFileSync(path.join(root,'lib/work-order-categories.ts'),'utf8');
  const creationAst=ts.createSourceFile('work-order-creation.ts',creationSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const suggestionsAst=ts.createSourceFile('work-order-suggestions.ts',suggestionsSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const categoriesAst=ts.createSourceFile('work-order-categories.ts',categoriesSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const names=new Set([
    'normalizeWorkOrderCategory',
    'normalizedIssueText',
    'assetTermsForPlumbingIssue',
    'priorityForCategory',
    'categoryFromIssue',
    'capitalizeIssue',
    'capitalizeIssuePreservingWhitespace',
    'findLocationFromText',
    'cleanIssueLocationPrefix',
    'createSuggestionFromIssueClause',
    'splitMaintenanceIssueClauses',
    'detectMultipleCreateIssues',
  ]);
  const functions = [
    ...categoriesAst.statements.filter(
      (node) =>
        (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) ||
        (ts.isVariableStatement(node) && node.declarationList.declarations.some((decl) => decl.name.getText() === 'WORK_ORDER_CATEGORIES'))
    ),
    ...suggestionsAst.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text)),
    ...creationAst.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text)),
  ].map(node=>node.getText(node.getSourceFile())).join('\n');
  const exports={};
  vm.runInNewContext(ts.transpileModule(functions+'\nexports.detect=detectMultipleCreateIssues;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports});
  const detect=exports.detect;
  const suggestions=detect("Room 409 AC isn’t cooling and the bathroom sink is leaking");
  const categories=Array.from(suggestions,(item)=>String(item.category));
  assert.equal(suggestions.length,2);
  assert.deepEqual(categories.slice().sort(),['HVAC','Plumbing']);
  assert.ok(suggestions.every((item)=>!/room\s*409/i.test(item.issue)));
  assert.ok(suggestions.some((item)=>/^ac\s+/i.test(item.issue) || /cool/i.test(item.issue)));
  assert.ok(suggestions.some((item)=>/sink|leak/i.test(item.issue)));
});

test('punctuation-free reports split every repeated issue starter without an upper limit',()=>{
  const creationSource=readFileSync(path.join(root,'lib/work-order-creation.ts'),'utf8');
  const creationAst=ts.createSourceFile('work-order-creation.ts',creationSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const suggestionsSource=readFileSync(path.join(root,'lib/work-order-suggestions.ts'),'utf8');
  const suggestionsAst=ts.createSourceFile('work-order-suggestions.ts',suggestionsSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const categoriesSource=readFileSync(path.join(root,'lib/work-order-categories.ts'),'utf8');
  const categoriesAst=ts.createSourceFile('work-order-categories.ts',categoriesSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const names=new Set(['normalizeWorkOrderCategory','normalizedIssueText','assetTermsForPlumbingIssue','categoryFromIssue','priorityForCategory','capitalizeIssue','capitalizeIssuePreservingWhitespace','findLocationFromText','cleanIssueLocationPrefix','createSuggestionFromIssueClause','splitMaintenanceIssueClauses','detectMultipleCreateIssues']);
  const functions=[
    ...categoriesAst.statements.filter((node)=>(ts.isFunctionDeclaration(node)&&names.has(node.name?.text))||(ts.isVariableStatement(node)&&node.declarationList.declarations.some((decl)=>decl.name.getText()==='WORK_ORDER_CATEGORIES'))),
    ...suggestionsAst.statements.filter((node)=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text)),
    ...creationAst.statements.filter((node)=>ts.isFunctionDeclaration(node)&&names.has(node.name?.text)),
  ].map((node)=>node.getText(node.getSourceFile())).join('\n');
  const exports={};
  vm.runInNewContext(ts.transpileModule(functions+'\nexports.detect=detectMultipleCreateIssues;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports});
  const two=exports.detect('not cooling bathroom sink leaking');
  const four=exports.detect('not cooling bathroom sink leaking bedroom TV no signal door lock broken');
  assert.equal(two.length,2);
  assert.equal(four.length,4);
});

const equipmentBatchRoles=['General Manager','Assistant General Manager','Front Desk Manager','Maintenance Technician','Chief Engineer','Lead Housekeeper','Front Desk'];
for(const role of equipmentBatchRoles)for(const scenario of [
 {name:'lamp',issue:'Desk lamp not working',assets:[{id:'lamp',name:'Desk lamp',asset_type:'Desk lamp'}],expected:'lamp'},
 {name:'washer number',issue:'Washer #2 not draining',assets:[1,2,12].map(n=>({id:`washer-${n}`,name:`Washer #${n}`,asset_type:'Washer'})),expected:'washer-2'},
 {name:'pool category',issue:'Pool filter pressure high',assets:[{id:'filter',name:'Sand filter',asset_type:'Pool Filter'}],expected:'filter'},
 {name:'manufacturer input',issue:'Beta washer not working',assets:[{id:'a',name:'Washer',asset_type:'Washer',manufacturer:'Alpha'},{id:'b',name:'Washer',asset_type:'Washer',manufacturer:'Beta'}],expected:'b'},
])test(`equipment batch preview/save agrees: ${role} / ${scenario.name}`,async()=>{
 const assets=scenario.assets.map(a=>({...a,location_id:'location-409',active:true}));
 const preliminary=fixture({orders:[{...order,issue:scenario.issue}],staff_first_name:'Casey'},{profile:{role},assets});
 const preview=preliminary.infer(scenario.issue,assets);assert.equal(preview.assetId,scenario.expected);
 const f=fixture({orders:[{...order,issue:scenario.issue,asset_id:preview.assetId,category:preview.category,priority:preview.priority,notes:'Original technician context'}],staff_first_name:'Casey'},{profile:{role},assets});
 const response=await f.handler(f.request);assert.equal(response.status,200,JSON.stringify(response));
 assert.equal(f.writes.length,1);assert.equal(f.writes[0].asset_id,preview.assetId);assert.equal(f.writes[0].category,preview.category);assert.equal(f.writes[0].priority,preview.priority);assert.equal(f.writes[0].notes,'Original technician context');
});

for (const role of ['Lead Housekeeper', 'Front Desk']) test(`${role} Spanish issue and notes are preserved, not falsely translated`, async () => {
  const issue = 'La manija de la ducha está rota en 409';
  const notes = 'Habitación vacía. No se cambió ninguna pieza.';
  const f = fixture({orders:[{...order, issue, notes}], staff_first_name:'María'}, {profile:{role}});
  assert.equal((await f.handler(f.request)).status, 200);
  assert.equal(f.writes[0].location_id, 'location-409');
  assert.equal(f.writes[0].room, 'Room 409');
  assert.equal(f.writes[0].issue, issue);
  assert.equal(f.writes[0].notes, notes);
});


test('Front Desk common-area selection preserves ticket and physical asset locations while guest-room asset is rejected',async()=>{
 const locations=[{id:'desk',name:'Front Desk',area:'Lobby',active:true},{id:'pbx',name:'PBX Room',area:'Maintenance',active:true},{id:'r137',name:'Room 137',room_number:'137',location_type:'guest_room',active:true}];
 for(const physical of ['pbx','r137']){
  const assets=[{id:'selected',location_id:physical,name:physical==='pbx'?'PBX telephone':'Art Sofa A Room137',asset_type:'Electrical',active:true}];
  const f=fixture({orders:[{location_id:'desk',issue:'Telephone issue',asset_id:'selected',category:'Electrical',priority:'Medium'}]},{locations,assets,profile:{role:'Chief Engineer',full_name:'Engineer'}});
  const response=await f.handler(f.request);assert.equal(response.status,physical==='pbx'?200:400,JSON.stringify(response.body));
  if(physical==='pbx'){assert.equal(f.writes[0].location_id,'desk');assert.equal(f.writes[0].asset_id,'selected');assert.equal(assets[0].location_id,'pbx');}
  else assert.equal(f.writes.length,0);
 }
});

// Execute the real creation-guide effect with controlled response ordering.
// Source parsing, equipment identity and issue matching use their real helpers.
const creationGuideSource=readFileSync(path.join(root,'app/work-orders/page.tsx'),'utf8');
const creationGuideAst=ts.createSourceFile('creation.tsx',creationGuideSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const creationGuideComponent=creationGuideAst.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='WorkOrdersPage');
const creationGuideEffect=creationGuideComponent.body.statements.find(node=>ts.isExpressionStatement(node)&&node.getText(creationGuideAst).startsWith('useEffect(')&&node.getText(creationGuideAst).includes('&source=asset-upload')).getText(creationGuideAst);
let creationGuideMediaExpression;
function findCreationGuideMedia(node){
  if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(creationGuideAst)==='WorkOrderStepMedia')creationGuideMediaExpression=node.attributes.properties.find(attribute=>attribute.name?.text==='media').initializer.expression.getText(creationGuideAst);
  ts.forEachChild(node,findCreationGuideMedia);
}
findCreationGuideMedia(creationGuideAst);assert.ok(creationGuideMediaExpression);
const creationGuideKeySource=creationGuideAst.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='createGuideAssetKey').getText(creationGuideAst);
const creationGuideRuntime={};
vm.runInNewContext(ts.transpileModule(creationGuideKeySource+'\nexports.key=createGuideAssetKey;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:creationGuideRuntime});
const creationGuideHelpers={
  ...loadTs('src/lib/manual-knowledge.ts'),
  ...loadTs('src/lib/manual-document-match.ts'),
  ...loadTs('src/lib/work-orders/guide-selection.ts'),
  ...loadTs('src/lib/troubleshooting-completed-steps.ts'),
  createGuideAssetKey:creationGuideRuntime.key,
};
const guideAsset={id:'00000000-0000-4000-8000-000000000071',active:true,manufacturer:'ACME',model_family:null,model_number:'W1',documentation_key:'approved-guide',documentation_revision_id:null,documentation_verified_at:'2026-11-08T20:00:00Z'};
const guideKnowledge={manufacturer:'ACME',model_family:'',model_number:'W1',source:{verified:true,source_kind:'asset-upload',storage_path:'hotel/asset/manual.pdf',registered_file_id:'registered-upload',sha256:'a'.repeat(64),title:'Washer manual.pdf',source_file_name:'Washer manual.pdf',file_url:'https://example.invalid/washer.pdf'},symptom_rules:[{match:['No heat'],steps:['Check the source thermostat.'],source_pages:[4]},{match:['No Fill'],steps:['Inspect the source inlet valve.'],source_pages:[5]}],error_codes:[],general_checks:['This generic check must never appear.'],manual_tests:[]};
const settleCreationGuide=()=>new Promise(resolve=>setImmediate(resolve));
const guidePayload=(asset=guideAsset,knowledge=guideKnowledge)=>({asset_id:asset.id,assets:[asset],manualKnowledge:knowledge,documentation_status:'verified'});
function creationGuideHarness(asset=guideAsset,{allowed=true,userId='actor-a'}={}){
  const writes=[],requests=[],pending=[];let currentUser=userId,cleanup,refresh,result=null;
  const context={...creationGuideHelpers,canViewTroubleshootingGuide:allowed,selectedCreateAssetId:asset?.id,troubleshootingAssetKey:creationGuideRuntime.key(asset),troubleshootingUserId:userId,
    getValidSession:async()=>currentUser?{access_token:'fixture-token',user:{id:currentUser}}:null,
    setTroubleshootingResult:value=>{result=value;writes.push(value);},
    fetch:(url,options)=>{requests.push({url,options});return new Promise(resolve=>pending.push(resolve));},
    subscribeResources:(topics,load)=>{assert.deepEqual(Array.from(topics),['reference']);refresh=load;void load();return ()=>{};},
    useEffect:run=>{cleanup=run();},
  };
  vm.runInNewContext(ts.transpileModule(creationGuideEffect,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return {writes,requests,pending,get result(){return result;},refresh:()=>refresh(),close:()=>cleanup?.(),user:value=>{currentUser=value;},respond(index,payload,status=200){pending[index]({ok:status===200,json:async()=>payload});}};
}
function creationGuideView(asset,result,{userId='actor-a',issue='It will not get warm',notes=''}={}){
  const names=['troubleshootingAssetKey','troubleshootingUserId','currentTroubleshootingResult','troubleshootingKnowledge','trustedTroubleshootingKnowledge','trustedManualUrl','troubleshootingEvidence','matchingTroubleshootingRules','matchingTroubleshootingSteps','troubleshootingSteps','troubleshootingMediaContext'];
  const declarations=names.map(name=>creationGuideComponent.body.statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>declaration.name.getText(creationGuideAst)===name)).getText(creationGuideAst));
  const context={...creationGuideHelpers,selectedCreateAsset:asset,troubleshootingResult:result,cmpriSession:{user:{id:userId}},issue,notes};
  vm.runInNewContext(ts.transpileModule(declarations.join('\n')+`\nglobalThis.view={knowledge:trustedTroubleshootingKnowledge,url:trustedManualUrl,steps:troubleshootingSteps,media:troubleshootingSteps.map(step=>({step,items:${creationGuideMediaExpression}})),mediaContext:troubleshootingMediaContext};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return JSON.parse(JSON.stringify(context.view));
}
test('creation guide uses one authenticated strict-source read and the shared everyday issue matcher',async()=>{
  const h=creationGuideHarness();try{
    await settleCreationGuide();assert.equal(h.requests.length,1);
    const request=h.requests[0],url=new URL(request.url,'https://example.invalid');
    assert.equal(url.pathname,'/api/maintenance-reference');assert.equal(url.searchParams.get('assetId'),guideAsset.id);assert.equal(url.searchParams.get('source'),'asset-upload');
    assert.equal(request.options.headers.Authorization,'Bearer fixture-token');assert.equal(request.options.cache,'no-store');
    h.respond(0,guidePayload());await settleCreationGuide();assert.equal(h.result.error,'');
    assert.deepEqual(creationGuideView(guideAsset,h.result).steps,['Check the source thermostat.']);
    assert.deepEqual(creationGuideView(guideAsset,h.result,{issue:"It won't fill"}).steps,['Inspect the source inlet valve.']);
    assert.deepEqual(creationGuideView(guideAsset,h.result,{issue:'It is broken'}).steps,[]);
    assert.deepEqual(creationGuideView(guideAsset,h.result,{issue:'No issue with heating'}).steps,[]);
    assert.equal(creationGuideView(guideAsset,h.result).url,guideKnowledge.source.file_url);assert.equal(h.requests.length,1,'issue changes match the approved source without a second service');
  }finally{h.close();}
});
test('creation diagrams follow the matched source page even when unrelated rules share the same instruction',async()=>{
  const label='Inspect the source connection.';
  const candidate=structuredClone(guideKnowledge);
  candidate.symptom_rules=[{match:['No heat'],steps:[label],source_pages:[4]},{match:['No Fill'],steps:[label],source_pages:[5]}];
  const image=(id,page,stepLabel=label)=>({id:`media-${id.repeat(64)}`,stepLabel,sourcePage:page,caption:`Figure ${page}. Source connection`,width:100,height:100});
  candidate.step_media=[image('a',4),image('b',5),image('c',4,'An unrelated source instruction.')];
  const h=creationGuideHarness();try{
    await settleCreationGuide();h.respond(0,guidePayload(guideAsset,candidate));await settleCreationGuide();
    const heating=creationGuideView(guideAsset,h.result,{issue:'It will not get warm'}),filling=creationGuideView(guideAsset,h.result,{issue:"It won't fill"});
    assert.deepEqual(heating.steps,[label]);assert.deepEqual(filling.steps,[label]);
    assert.deepEqual(heating.media[0].items.map(item=>item.id),[candidate.step_media[0].id]);
    assert.deepEqual(filling.media[0].items.map(item=>item.id),[candidate.step_media[1].id]);
    assert.notEqual(heating.mediaContext,filling.mediaContext,'an issue change invalidates the old image even when the instruction label is identical');
  }finally{h.close();}
});
test('creation guide ignores an older reference refresh and responses after unmount',async()=>{
  const h=creationGuideHarness();try{
    await settleCreationGuide();const refresh=h.refresh();await settleCreationGuide();assert.equal(h.requests.length,2);
    const newer=structuredClone(guideKnowledge);newer.source.file_url='https://example.invalid/newer.pdf';
    h.respond(1,guidePayload(guideAsset,newer));await refresh;assert.equal(h.result.knowledge.source.file_url,newer.source.file_url);
    h.respond(0,guidePayload());await settleCreationGuide();assert.equal(h.result.knowledge.source.file_url,newer.source.file_url);
    const leaving=h.refresh();await settleCreationGuide();h.close();h.respond(2,guidePayload());await leaving;
    assert.equal(h.result,null,'a late response cannot restore the source cleared before unmount');
  }finally{h.close();}
});
for(const change of [{model_number:'W2'},{manufacturer:'Other'},{documentation_key:'replacement'},{documentation_revision_id:'pending-review'},{documentation_verified_at:'2026-11-09T00:00:00Z'},{active:false}])test(`creation guide rejects a source response after equipment ${Object.keys(change)[0]} changes`,async()=>{
  const h=creationGuideHarness();try{await settleCreationGuide();h.respond(0,guidePayload({...guideAsset,...change}));await settleCreationGuide();assert.equal(h.result.knowledge,null);assert.match(h.result.error,/changed/);}finally{h.close();}
});
for(const source of [{verified:false},{source_kind:'catalog'},{storage_path:''},{registered_file_id:''},{sha256:'not-a-sha256'}])test(`creation guide refuses unapproved source metadata: ${Object.keys(source)[0]}`,async()=>{
  const h=creationGuideHarness();try{await settleCreationGuide();const candidate=structuredClone(guideKnowledge);Object.assign(candidate.source,source);h.respond(0,guidePayload(guideAsset,candidate));await settleCreationGuide();assert.equal(h.result.knowledge,null);assert.match(h.result.error,/approved uploaded document/);}finally{h.close();}
});
test('creation guide rejects mismatched manual identity and account changes without exposing stale content',async()=>{
  const wrong=creationGuideHarness();try{await settleCreationGuide();wrong.respond(0,guidePayload(guideAsset,{...guideKnowledge,manufacturer:'Other'}));await settleCreationGuide();assert.equal(wrong.result.knowledge,null);}finally{wrong.close();}
  const switched=creationGuideHarness();try{await settleCreationGuide();switched.user('actor-b');switched.respond(0,guidePayload());await settleCreationGuide();assert.equal(switched.result.knowledge,null);assert.match(switched.result.error,/account changed/);}finally{switched.close();}
  const valid=creationGuideHarness();try{await settleCreationGuide();valid.respond(0,guidePayload());await settleCreationGuide();assert.equal(creationGuideView(guideAsset,valid.result,{userId:'actor-b'}).knowledge,null,'the previous account result is hidden before its effect cleanup');}finally{valid.close();}
});
test('creation guide preserves unavailable-source explanations and never loads for a disallowed role',async()=>{
  const h=creationGuideHarness();try{await settleCreationGuide();h.respond(0,{...guidePayload(guideAsset,null),documentation_status:'no_uploaded_document',documentation_reason:'Attach the approved equipment document.'});await settleCreationGuide();assert.equal(h.result.knowledge,null);assert.equal(h.result.reason,'Attach the approved equipment document.');}finally{h.close();}
  const denied=creationGuideHarness(guideAsset,{allowed:false});try{await settleCreationGuide();assert.equal(denied.requests.length,0);}finally{denied.close();}
});
