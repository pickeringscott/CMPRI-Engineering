import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
function load(file) {
 const exports={};
 const source=fs.readFileSync(file,'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require(name){return load(path.resolve(path.dirname(file),name+'.ts'));}});
 return exports;
}
const {assetGuideIdentity,reconcileAssetGuide}=load('src/lib/work-orders/asset-guide-cache.ts');
const {inferWorkOrder}=load('src/lib/work-order-suggestions.ts');
const {roomAssetsForInference}=load('src/lib/work-orders/assignable-assets.ts');
const {guideRulesForIssue,equipmentSearchAliases}=load('src/lib/work-orders/guide-selection.ts');
const {manualMatchesEquipment,manualTextContainsExactIdentity}=load('src/lib/manual-document-match.ts');
const built={id:'built',location_id:'101',active:true,name:'Room AC',asset_type:'HVAC',manufacturer:'Friedrich',model_family:'Vert-I-Pak',documentation_key:'verified'};
const portable={id:'portable',location_id:'101',active:true,name:'Portable A/C',asset_type:'Air conditioner',manufacturer:'Other'};
const uploadedSource={verified:true,source_kind:'asset-upload',storage_path:'hotel/asset/original.pdf',sha256:'a'.repeat(64),registered_file_id:'uploaded-file',registered_updated_at:'2026-11-08T20:00:00Z',source_file_name:'uploaded.pdf',file_url:'https://example.invalid/uploaded.pdf'};
for(const report of ['AC is noisy','A/C is loud','HVAC is rattling','Frederick is noisy','Vertipak is noisy','Vert-I-Pak is noisy']) test(report,()=>assert.equal(inferWorkOrder(report,[built]).assetId,'built'));
test('portable only room matches portable; multiple units require selection despite available docs',()=>{
 assert.equal(inferWorkOrder('AC is noisy',[portable]).assetId,'portable');
 assert.equal(inferWorkOrder('AC is noisy',[built,portable]).assetId,null);
 assert.equal(inferWorkOrder('portable AC is noisy',[built,portable]).assetId,'portable');
});
test('all room scopes exclude generic catalog and other-room identities',()=>{
 for(const room of ['101','207','410','512']) {
 const assets=[{...built,id:room,location_id:room},{...built,id:'catalog',location_id:null},{...portable,location_id:'elsewhere'}];
 assert.equal(inferWorkOrder('AC is noisy',roomAssetsForInference(assets,room)).assetId,room);
 }
});
test('aliases search brand and family without manufacturing an identity',()=>{
 const aliases=equipmentSearchAliases('Friedrich Vert-I-Pak');
 assert.ok(aliases.includes('Frederick'));assert.ok(aliases.includes('Vertipak'));
 assert.equal(equipmentSearchAliases('Unidentified AC').length,1);
});
test('verified noise rules, manual tests and general checks survive hydration; unrelated rules do not',()=>{
 const result=guideRulesForIssue({source:{verified:true},symptom_rules:[{match:['noise'],steps:['Verified noise step'],source_pages:[4]},{match:['no heat'],steps:['Heating step']}],manual_tests:[{match:['rattling'],steps:['Verified test']}],general_checks:['Verified general check']},'AC is noisy and rattles');
 assert.equal(result.flatMap(r=>r.steps).join('|'),'Verified noise step|Verified test');
 assert.equal(result[0].source_pages[0],4);
});
test('missing/unverified documentation yields no invented instructions',()=>{
 assert.equal(guideRulesForIssue(null,'AC noisy').length,0);
 assert.equal(guideRulesForIssue({source:{verified:false},general_checks:['Untrusted']},'AC noisy').length,0);
});
test('denied symptoms, safety qualifiers and diagnostic codes cannot route to source repair actions',()=>{
 const cases=[
  ['It is not making any noise.','Abnormal noise'],
  ["It doesn't make a loud noise.",'Abnormal noise'],
  ["I don't hear any noise.",'Abnormal noise'],
  ['It never gets noisy.','Abnormal noise'],
  ['It is not a water leak.','Water leak'],
  ['There is no visible water leak.','Water leak'],
  ['There is no unusual vibration.','Vibration'],
  ['No leaks or noise.','Abnormal noise'],
  ['It is not leaking or noisy.','Abnormal noise'],
  ['The noise is normal.','Abnormal noise'],
  ['It vibrates normally.','Vibration'],
  ['No heat with no gas odor present.','No heat — gas odor present'],
  ['No heat without gas odor present.','No heat — gas odor present'],
  ['No heat flow switch not open.','No heat flow switch open'],
  ['No power when door open is ruled out; noisy.','No power when door open'],
  ['No power when door open was not found; noisy.','No power when door open'],
  ['No power when door open has not been observed; noisy.','No power when door open'],
  ['No heat gas odor present is not the problem; noise.','No heat gas odor present'],
  ['No error code F1 is displayed; only noisy.','Code F1'],
  ['No error code F1 is displayed; only noisy.','F1 is displayed'],
 ];
 for(const [issue,heading] of cases){
  const knowledge={source:{verified:true},symptom_rules:[{match:[heading],steps:['Use only this source-specific repair.'],source_pages:[27]}]};
  assert.equal(guideRulesForIssue(knowledge,issue).length,0,`${issue} must not select ${heading}`);
 }
});
test('family punctuation aliases preserve exact manufacturer and model protections',()=>{
 assert.ok(manualMatchesEquipment(built,{manufacturer:'Friedrich',model_family:'Vertipak'}));
 assert.ok(manualTextContainsExactIdentity('Friedrich Vert-I-Pak service manual','Vertipak'));
 assert.equal(manualMatchesEquipment(built,{manufacturer:'Other',model_family:'Vertipak'}),false);
 assert.equal(manualMatchesEquipment(built,{manufacturer:'Friedrich',model_family:'ZoneAire'}),false);
});
const page=fs.readFileSync('src/app/work-orders/[id]/page.tsx','utf8');
const ast=ts.createSourceFile('page.tsx',page,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='WorkOrderTicketEditor')||ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='WorkOrderTicketPage');
const manualLoader=component.body.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='loadManualForAsset').getText(ast);
const effects=component.body.statements.filter(n=>ts.isExpressionStatement(n)&&n.getText(ast).startsWith('useEffect('));
const manualEffect=effects.find(n=>n.getText(ast).includes('loadManualForAsset(selectedAsset')).getText(ast);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function hydrationHarness(asset) {
 const writes=[],pending=[],urls=[];let cleanup; let assets=[asset];
 const selectionKey=`test-ticket:${assetGuideIdentity(asset)}`;
 const globals={id:"test-ticket",assetGuideIdentity,reconcileAssetGuide,manualSelection:{current:selectionKey},manualCompletedIdentity:{current:""},manualLoadGeneration:{current:0},manualSelectionKey:selectionKey,selectedAsset:asset,assetId:asset?.id,
  setAssets:next=>{assets=typeof next==="function"?next(assets):next;},
  getValidSession:async()=>({access_token:'fixture'}),authorizationHeaders:async()=>({}),
  // This harness records completed lookups; null is the loading transition.
  normalizeManualKnowledge:x=>x,setManualResult:x=>{if(x)writes.push(x);},
  fetch:url=>{urls.push(String(url));return new Promise(resolve=>pending.push(resolve));},encodeURIComponent,
  window:{setInterval:()=>1,clearInterval(){}},document:{addEventListener(){},removeEventListener(){}},
  subscribeResources(_topics,load,initial=true){if(initial)void load();return ()=>{};},
  useEffect:fn=>{cleanup=fn();}};
 vm.runInNewContext(ts.transpileModule(manualLoader+'\n'+manualEffect,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,globals);
 return {writes,pending,urls,get assets(){return assets;},close:()=>cleanup()};
}
test('switching, reopening and late responses retain only the current uploaded guide and its PDF',async()=>{
 const first=hydrationHarness(built);await flush();first.close();
 const second=hydrationHarness(portable);await flush();
 second.pending[0]({ok:true,json:async()=>({manualKnowledge:{source:{...uploadedSource}},documentation_status:'verified'})});await flush();
 first.pending[0]({ok:true,json:async()=>({manualKnowledge:{source:{...uploadedSource,file_url:'https://example.invalid/old.pdf'}}})});await flush();
 assert.equal(first.writes.length,0);assert.equal(second.writes[0].asset.id,'portable');second.close();
 assert.equal(second.writes[0].knowledge.source.storage_path,uploadedSource.storage_path);
 assert.equal(displayedGuide(portable,second.writes[0]).documents[0].url,uploadedSource.file_url);
 assert.equal(displayedGuide(built,second.writes[0]).documents.length,0);
 const reopened=hydrationHarness(built);await flush();assert.equal(reopened.pending.length,1);reopened.close();
});
test('work-order guidance requests only the selected asset upload source',async()=>{
 const h=hydrationHarness({...built,id:'asset with spaces'});await flush();
 assert.equal(h.urls.length,1);const requested=new URL(h.urls[0],'https://example.invalid');
 assert.equal(requested.pathname,'/api/maintenance-reference');assert.equal(requested.searchParams.get('assetId'),'asset with spaces');assert.equal(requested.searchParams.get('source'),'asset-upload');h.close();
});
for(const source of [{verified:true},{...uploadedSource,source_kind:'catalog'}])test(`work-order hydration rejects ${source.source_kind||'legacy'} guidance despite verification`,async()=>{
 const h=hydrationHarness(built);await flush();h.pending[0]({ok:true,json:async()=>({manualKnowledge:{source},documentation_status:'verified'})});await flush();
 assert.equal(h.writes[0].knowledge,null);h.close();
});
test('manual lookup failure settles explicitly instead of retaining previous guidance',async()=>{
 const h=hydrationHarness(built);await flush();h.pending[0]({ok:false});await flush();
 assert.equal(h.writes[0].knowledge,null);assert.equal(h.writes[0].status,'lookup_unavailable');h.close();
});
test('model-number-only changes invalidate both instructions and their sole source PDF until reloaded',async()=>{
 assert.match(manualEffect,/selectedAsset\?\.model_number/);
 const original={...built,model_number:'A1'},h=hydrationHarness(original);await flush();
 h.pending[0]({ok:true,json:async()=>({manualKnowledge:{source:{...uploadedSource}},documentation_status:'verified'})});await flush();h.close();
 assert.equal(displayedGuide(original,h.writes[0]).documents.length,1);
 const changed={...original,model_number:'A2'};
 assert.equal(displayedGuide(changed,h.writes[0]).knowledge,null);assert.equal(displayedGuide(changed,h.writes[0]).documents.length,0);
 const refreshed=hydrationHarness(changed);await flush();assert.equal(refreshed.pending.length,1);refreshed.close();
});
test('server asset changes reconcile the cached selection while results remain hidden against an unreconciled stale asset',async()=>{
 const original={...built,model_number:'A1',documentation_revision_id:null,documentation_verified_at:'2026-11-08T19:00:00Z'};
 const current={...original,model_number:'A2',documentation_key:'replacement-guide',documentation_verified_at:'2026-11-08T21:00:00Z'};
 const source={...uploadedSource,storage_path:'hotel/asset/replacement.pdf',sha256:'c'.repeat(64),registered_file_id:'replacement-upload'};
 const h=hydrationHarness(original);await flush();
 h.pending[0]({ok:true,json:async()=>({assets:[{id:'unrelated',model_number:'OTHER'},current],manualKnowledge:{source},documentation_status:'verified'})});await flush();h.close();
 assert.equal(h.urls.length,1);assert.equal(h.writes[0].asset.model_number,'A2');assert.equal(h.writes[0].asset.documentation_key,current.documentation_key);
 const stale=displayedGuide(original,h.writes[0]);assert.equal(stale.knowledge,null);assert.equal(stale.documents.length,0);
 assert.equal(h.assets[0].model_number,current.model_number); assert.equal(h.assets[0].documentation_key,current.documentation_key);
 const refreshed=displayedGuide(h.assets[0],h.writes[0]);assert.equal(refreshed.knowledge.source.storage_path,source.storage_path);assert.equal(refreshed.documents[0].storage_path,source.storage_path);
});

test('unclassified technical manual tests are not applied to every symptom',()=>{assert.equal(guideRulesForIssue({source:{verified:true},manual_tests:[{title:'Calibration',steps:['Unrelated technical test']}]},'AC noisy').length,0);});

test('Room 410 field evidence: GE model unknown never inherits Friedrich guide',()=>{
 const ge={id:'ge-410',location_id:'410',active:true,name:'GE room air conditioner',asset_type:'Air conditioner',manufacturer:'GE',model_family:null,model_number:null};
 assert.equal(inferWorkOrder('AC is noisy',[ge]).assetId,'ge-410');
 assert.equal(manualMatchesEquipment(ge,{manufacturer:'Friedrich',model_family:'Vertipak'}),false);
 assert.equal(manualMatchesEquipment(ge,{manufacturer:'GE',model_family:'Zoneline'}),false);
});

test('empty-guidance footer is hidden when verified manual steps or diagnostic guidance are visible',()=>{
 const expressions=[];function visit(node){if(ts.isJsxExpression(node)&&node.getText(ast).includes('No instructions match this description yet.'))expressions.push(node);ts.forEachChild(node,visit);}visit(ast);
 const node=expressions.sort((a,b)=>a.getWidth(ast)-b.getWidth(ast))[0];assert.ok(node&&ts.isBinaryExpression(node.expression));const condition=node.expression.left.getText(ast);
 const shown=(manual,displayed,codes,loading,trusted=true)=>vm.runInNewContext(condition,{trustedManualKnowledge:trusted,manualSteps:Array(manual),displayedSteps:Array(displayed),relevantErrorCodes:Array(codes),manualLoading:loading,manualKnowledge:null});
 assert.equal(shown(1,0,0,false),false);assert.equal(shown(0,1,0,false),false);assert.equal(shown(0,0,1,false),false);assert.equal(shown(0,0,0,true),false);assert.equal(shown(0,0,0,false),true);assert.equal(shown(0,0,0,false,false),false);
});
const sourceHelpers=load('src/lib/manual-source.ts');
const ticketDeclaration=name=>component.body.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)===name)).getText(ast);
function displayedGuide(asset,manualResult){
 const scope={assetGuideIdentity,selectedAsset:asset,assetId:asset?.id,manualResult};
 vm.runInNewContext(ts.transpileModule(['manualCurrent','manualKnowledge','guideSource','guideDocuments'].map(ticketDeclaration).join('\n')+'\nglobalThis.result={knowledge:manualKnowledge,documents:guideDocuments};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,scope);
 return JSON.parse(JSON.stringify(scope.result));
}
test('guide links come from the same strict uploaded source without a generic documentation request',()=>{
 assert.doesNotMatch(page,/\/api\/assets\/documentation\?/);
 const result={asset:built,knowledge:{source:{...uploadedSource}}};
 assert.deepEqual(displayedGuide(built,result).documents,[{name:uploadedSource.source_file_name,storage_path:uploadedSource.storage_path,url:uploadedSource.file_url}]);
 for(const source of [{...uploadedSource,source_kind:'catalog'},{...uploadedSource,storage_path:''}])assert.equal(displayedGuide(built,{...result,knowledge:{source}}).documents.length,0);
});
for(const change of [{manufacturer:'Other'},{model_family:'Other family'},{documentation_key:'new guide'},{documentation_revision_id:'pending'},{documentation_verified_at:'2026-11-09T00:00:00Z'}])test(`changed ${Object.keys(change)[0]} clears stale guidance and its PDF link`,()=>{
 const result={asset:built,knowledge:{source:{...uploadedSource}}};
 const shown=displayedGuide({...built,...change},result);assert.equal(shown.knowledge,null);assert.equal(shown.documents.length,0);
});
function ticketCodeSelection(verified,issue,codes,provenance={}){const scope={manualKnowledge:{source:{...uploadedSource,verified,...provenance},error_codes:codes},issue,order:{reporter_notes:''},normalizeDiagnosticCode:sourceHelpers.normalizeDiagnosticCode,reportedDiagnosticCode:sourceHelpers.reportedDiagnosticCode};vm.runInNewContext(ts.transpileModule(ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='normalizeDiagnosticCode').getText(ast)+'\n'+['trustedManualKnowledge','reportedCode','manualErrorCodes','matchingErrorCode'].map(ticketDeclaration).join('\n')+'\nglobalThis.result={reportedCode,manualErrorCodes,matchingErrorCode};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,scope);return scope.result;}
test('actual ticket matches exact reported diagnostic code and preserves its source page',()=>{const codes=[{code:'40',problem:'Neighbor',action:'Other',source_pages:[40]},{code:'4',problem:'Exact',action:'Reviewed',source_pages:[30]}];const r=ticketCodeSelection(true,'Fault code 4',codes);assert.equal(r.matchingErrorCode.code,'4');assert.equal(r.matchingErrorCode.source_pages[0],30);assert.equal(ticketCodeSelection(true,'Fault code 41',codes).matchingErrorCode,undefined);});
test('actual ticket refuses diagnostic entries from unverified knowledge',()=>{const r=ticketCodeSelection(false,'Fault code 4',[{code:'4',problem:'Unverified',action:'Do not show'}]);assert.equal(r.manualErrorCodes.length,0);assert.equal(r.matchingErrorCode,undefined);});
test('actual ticket does not turn a denied diagnostic code into a code-specific repair',()=>{
 const codes=[{code:'F1',problem:'Exact fault',action:'Replace the fault component.',source_pages:[30]}];
 for(const issue of ['No error code F1 is displayed; the washer is only noisy.','It is not showing fault F1.','We cannot see error code F1.','It is not the error code F1.','Fault code F1 was not found.','Fault code F1 has not been observed.'])assert.equal(ticketCodeSelection(true,issue,codes).matchingErrorCode,undefined,issue);
});
for(const provenance of [{source_kind:'catalog'},{storage_path:''},{sha256:''},{registered_file_id:''}])test(`actual ticket refuses diagnostic guidance without uploaded provenance: ${Object.keys(provenance)[0]}`,()=>{
 const r=ticketCodeSelection(true,'Fault code 4',[{code:'4',problem:'Verified flag alone',action:'Do not show'}],provenance);assert.equal(r.manualErrorCodes.length,0);assert.equal(r.matchingErrorCode,undefined);
});
