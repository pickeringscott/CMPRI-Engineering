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
const {inferWorkOrder}=load('src/lib/work-order-suggestions.ts');
const {roomAssetsForInference}=load('src/lib/work-orders/assignable-assets.ts');
const {guideRulesForIssue,equipmentSearchAliases}=load('src/lib/work-orders/guide-selection.ts');
const {manualMatchesEquipment,manualTextContainsExactIdentity}=load('src/lib/manual-document-match.ts');
const built={id:'built',location_id:'101',active:true,name:'Room AC',asset_type:'HVAC',manufacturer:'Friedrich',model_family:'Vert-I-Pak',documentation_key:'verified'};
const portable={id:'portable',location_id:'101',active:true,name:'Portable A/C',asset_type:'Air conditioner',manufacturer:'Other'};
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
test('family punctuation aliases preserve exact manufacturer and model protections',()=>{
 assert.ok(manualMatchesEquipment(built,{manufacturer:'Friedrich',model_family:'Vertipak'}));
 assert.ok(manualTextContainsExactIdentity('Friedrich Vert-I-Pak service manual','Vertipak'));
 assert.equal(manualMatchesEquipment(built,{manufacturer:'Other',model_family:'Vertipak'}),false);
 assert.equal(manualMatchesEquipment(built,{manufacturer:'Friedrich',model_family:'ZoneAire'}),false);
});
const page=fs.readFileSync('src/app/work-orders/[id]/page.tsx','utf8');
const ast=ts.createSourceFile('page.tsx',page,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='WorkOrderTicketPage');
const manualLoader=component.body.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='loadManualForAsset').getText(ast);
const effects=component.body.statements.filter(n=>ts.isExpressionStatement(n)&&n.getText(ast).startsWith('useEffect('));
const manualEffect=effects.find(n=>n.getText(ast).includes('loadManualForAsset(selectedAsset')).getText(ast);
const documentEffect=effects.find(n=>n.getText(ast).includes('/api/assets/documentation?')).getText(ast);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function hydrationHarness(asset,kind='manual') {
 const writes=[],pending=[];let cleanup;
 const globals={selectedAsset:asset,selectedAssetId:asset?.id,assetId:asset?.id,canReadAssetDocuments:true,documentIdentity:JSON.stringify(asset),
  getValidSession:async()=>({access_token:'fixture'}),authorizationHeaders:async()=>({}),
  normalizeManualKnowledge:x=>x,setManualResult:x=>writes.push(x),setAssetDocumentResult:x=>writes.push(x),
  fetch:()=>new Promise(resolve=>pending.push(resolve)),encodeURIComponent,
  window:{setInterval:()=>1,clearInterval(){}},document:{addEventListener(){},removeEventListener(){}},
  useEffect:fn=>{cleanup=fn();}};
 vm.runInNewContext(ts.transpileModule(manualLoader+'\n'+(kind==='manual'?manualEffect:documentEffect),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,globals);
 return {writes,pending,close:()=>cleanup()};
}
for(const kind of ['manual','documents']) test(`${kind}: switching, reopening and late responses retain only current selection`,async()=>{
 const first=hydrationHarness(built,kind);await flush();first.close();
 const second=hydrationHarness(portable,kind);await flush();
 second.pending[0]({ok:true,json:async()=>({manualKnowledge:{source:{verified:true}},documentation_status:'verified',documents:[{name:'portable.pdf'}]})});await flush();
 first.pending[0]({ok:true,json:async()=>({manualKnowledge:{source:{verified:true}},documents:[{name:'old.pdf'}]})});await flush();
 assert.equal(first.writes.length,0);assert.equal(second.writes[0].assetId,'portable');second.close();
 const reopened=hydrationHarness(built,kind);await flush();assert.equal(reopened.pending.length,1);reopened.close();
});
test('manual lookup failure settles explicitly instead of retaining previous guidance',async()=>{
 const h=hydrationHarness(built);await flush();h.pending[0]({ok:false});await flush();
 assert.equal(h.writes[0].knowledge,null);assert.equal(h.writes[0].status,'lookup_unavailable');h.close();
});
test('model-number-only changes trigger manual and PDF reloads',()=>{
 assert.match(manualEffect,/selectedAsset\?\.model_number/);assert.match(documentEffect,/documentIdentity/);assert.match(page,/const documentIdentity = JSON.stringify\(\[selectedAssetId, selectedAsset\?\.manufacturer, selectedAsset\?\.model_family, selectedAsset\?\.model_number/);
});

test('unclassified technical manual tests are not applied to every symptom',()=>{assert.equal(guideRulesForIssue({source:{verified:true},manual_tests:[{title:'Calibration',steps:['Unrelated technical test']}]},'AC noisy').length,0);});

test('Room 410 field evidence: GE model unknown never inherits Friedrich guide',()=>{
 const ge={id:'ge-410',location_id:'410',active:true,name:'GE room air conditioner',asset_type:'Air conditioner',manufacturer:'GE',model_family:null,model_number:null};
 assert.equal(inferWorkOrder('AC is noisy',[ge]).assetId,'ge-410');
 assert.equal(manualMatchesEquipment(ge,{manufacturer:'Friedrich',model_family:'Vertipak'}),false);
 assert.equal(manualMatchesEquipment(ge,{manufacturer:'GE',model_family:'Zoneline'}),false);
});

test('empty-guidance footer is hidden when verified manual steps or diagnostic guidance are visible',()=>{
 const expressions=[];function visit(node){if(ts.isJsxExpression(node)&&node.getText(ast).includes('No symptom-specific troubleshooting matched yet.'))expressions.push(node);ts.forEachChild(node,visit);}visit(ast);
 const node=expressions.sort((a,b)=>a.getWidth(ast)-b.getWidth(ast))[0];assert.ok(node&&ts.isBinaryExpression(node.expression));const condition=node.expression.left.getText(ast);
 const shown=(manual,displayed,codes,loading)=>vm.runInNewContext(condition,{manualSteps:Array(manual),displayedSteps:Array(displayed),relevantErrorCodes:Array(codes),manualLoading:loading,manualKnowledge:null});
 assert.equal(shown(1,0,0,false),false);assert.equal(shown(0,1,0,false),false);assert.equal(shown(0,0,1,false),false);assert.equal(shown(0,0,0,true),false);assert.equal(shown(0,0,0,false),true);
});
const sourceHelpers=load('src/lib/manual-source.ts');
const ticketDeclaration=name=>component.body.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)===name)).getText(ast);
function ticketCodeSelection(verified,issue,codes){const scope={manualKnowledge:{source:{verified},error_codes:codes},trustedManualKnowledge:verified,issue,order:{reporter_notes:''},normalizeDiagnosticCode:sourceHelpers.normalizeDiagnosticCode,reportedDiagnosticCode:sourceHelpers.reportedDiagnosticCode};vm.runInNewContext(ts.transpileModule(ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='normalizeDiagnosticCode').getText(ast)+'\n'+['reportedCode','manualErrorCodes','matchingErrorCode'].map(ticketDeclaration).join('\n')+'\nglobalThis.result={reportedCode,manualErrorCodes,matchingErrorCode};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,scope);return scope.result;}
test('actual ticket matches exact reported diagnostic code and preserves its source page',()=>{const codes=[{code:'40',problem:'Neighbor',action:'Other',source_pages:[40]},{code:'4',problem:'Exact',action:'Reviewed',source_pages:[30]}];const r=ticketCodeSelection(true,'Fault code 4',codes);assert.equal(r.matchingErrorCode.code,'4');assert.equal(r.matchingErrorCode.source_pages[0],30);assert.equal(ticketCodeSelection(true,'Fault code 41',codes).matchingErrorCode,undefined);});
test('actual ticket refuses diagnostic entries from unverified knowledge',()=>{const r=ticketCodeSelection(false,'Fault code 4',[{code:'4',problem:'Unverified',action:'Do not show'}]);assert.equal(r.manualErrorCodes.length,0);assert.equal(r.matchingErrorCode,undefined);});
