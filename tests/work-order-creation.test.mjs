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
    then(resolve){return Promise.resolve({data:table==='locations'?(config.noLocation?[]:[{id:'location-409',name:'Room 409'}]):assets,error:config.lookupError?{message:'Unavailable'}:null}).then(resolve);},
    limit:async()=>({data:table==='assets'?assets:(config.existing||[]),error:(table==='assets'?config.assetLookupError:config.duplicateError)?{message:'Unavailable'}:null}),
    insert:async rows=>{writes.push(...rows);return {error:config.insertError?{message:'Rejected'}:null};},
  };}};
  function load(file) {
    const exports={};
    vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,process:{env:config.noServiceRole?{}:{SUPABASE_SERVICE_ROLE_KEY:'service-role-test'}},
      require(name){
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
