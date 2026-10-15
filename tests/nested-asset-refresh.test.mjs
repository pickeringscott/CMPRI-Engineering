import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {queuedAssetRefresh,isAssetListRefresh} from '../src/lib/asset-list-refresh.js';
function extract(file,name,kind='function') {
 const source=readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),ast=ts.createSourceFile(file,source,99,true,4);let found;
 function visit(n){if((kind==='function'?ts.isFunctionDeclaration(n):ts.isVariableDeclaration(n))&&n.name?.text===name)found=n;ts.forEachChild(n,visit);}visit(ast);assert.ok(found,name);
 return (kind==='function'?'': 'const ')+found.getText(ast)+';\nexports.value='+name+';';
}
function evaluate(code,context){const exports={};vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,...context});return exports.value;}

test('successful asset creation emits one invalidation; failed or incomplete saves emit none',async()=>{
 const code=extract('app/management/equipment/page.tsx','createAsset');
 for(const outcome of ['success','failure','incomplete']){
  const messages=[],state={assets:[]};const parent={postMessage:m=>messages.push(m)};
  const save=evaluate(code,{canManage:true,createPending:{current:false},locations:[{id:'desk'}],newAsset:{location_id:'desk',asset_type:'Terminal'},parseAssetInstallYear(){},setCreateMessage(){},setCreating(){},token:async()=> 'mock',fetch:async()=>({ok:outcome!=='failure',json:async()=>outcome==='success'?{asset:{id:'created',location_id:'desk'}}:{}}),setAssets:fn=>state.assets=fn(state.assets),selectAsset(){},setAdding(){},setNewAsset(){},blankAsset:{},setMessage(){},URLSearchParams,window:{parent,location:{origin:'https://fixture.invalid',search:'?modalToken=equipment-token'}}});
  await save({preventDefault(){}});assert.equal(messages.length,outcome==='success'?1:0);if(messages.length){assert.equal(messages[0].modalToken,'equipment-token');assert.equal(messages[0].assetId,'created');}
 }
});
test('host validates source and token, relays only to open creation forms, never closes or reloads',()=>{
 const parent={},equipment={},messages=[];const stack=[{id:'create',href:'/work-orders',modalToken:'form-token'},{id:'unrelated',href:'/profile',modalToken:'profile-token'},{id:'equipment',href:'/management/equipment',modalToken:'equipment-token'}];
 const refs=new Map([['equipment',{contentWindow:equipment}],['create',{contentWindow:{postMessage:m=>messages.push(m)}}]]);
 const handler=evaluate(extract('components/GlobalModalHost.tsx','handleMessage','variable'),{window:{location:{origin:'https://fixture.invalid'},parent},stack,frameRefs:{current:refs},URL,setStack(){throw Error('must not close form');}});
 const event={origin:'https://fixture.invalid',source:equipment,data:{type:'cmpri-assets-changed',assetId:'created',modalToken:'equipment-token'}};
 handler({...event,origin:'https://foreign.invalid'});handler({...event,source:{}});handler({...event,data:{...event.data,modalToken:'wrong'}});assert.equal(messages.length,0);
 handler(event);assert.equal(messages.length,1);assert.equal(messages[0].modalToken,'form-token');
 assert.equal(isAssetListRefresh({origin:event.origin,source:parent,data:messages[0]},event.origin,parent,'form-token'),true);
 assert.equal(isAssetListRefresh({origin:event.origin,source:{},data:messages[0]},event.origin,parent,'form-token'),false);
});
test('refetch changes only assets; failure retains list and draft; retry is GET only',async()=>{
 const state={assets:[{id:'old'}],room:'desk',issue:'Phone',notes:'Keep notes',draft:'saved-draft',selected:'old',error:''};let failed=false;const methods=[];
 const refresh=evaluate(extract('app/work-orders/page.tsx','loadAssets','variable'),{useMemo:fn=>fn(),queuedAssetRefresh,apiHeaders:async()=>({Authorization:'mock'}),fetch:async(url,options)=>{methods.push(options.method||'GET');return {ok:!failed,json:async()=>failed?{error:'Offline'}:{assets:[{id:'old'},{id:'created',location_id:'desk',active:true}]}};},setAssets:assets=>state.assets=assets,setAssetRefreshError:error=>state.error=error,setLoadingAssets(){}});
 await refresh();assert.equal(state.assets.length,2);failed=true;await refresh();assert.equal(state.assets.length,2);assert.match(state.error,/Retry the list/);failed=false;await refresh();assert.equal(state.error,'');
 assert.deepEqual(methods,['GET','GET','GET']);assert.equal(state.room,'desk');assert.equal(state.issue,'Phone');assert.equal(state.notes,'Keep notes');assert.equal(state.draft,'saved-draft');assert.equal(state.selected,'old');
});
test('save during an old request queues one follow-up instead of accepting stale data',async()=>{
 let release,calls=0;const gate=new Promise(resolve=>release=resolve);const refresh=queuedAssetRefresh(async()=>{calls++;if(calls===1)await gate;});
 const pending=refresh();refresh();refresh();assert.equal(calls,1);release();await pending;assert.equal(calls,2);
});


test('desktop host relays saved asset to existing create window without resetting windows',()=>{
 const equipment={},messages=[],origin='https://fixture.invalid';
 const windows=[{key:'/management/equipment',src:'/management/equipment?modalToken=equipment-token'},{key:'/work-orders',src:'/work-orders?modalToken=form-token'}];
 const handler=evaluate(extract('app/engineering/page.tsx','handleWindowMessage','variable'),{window:{location:{origin}},URL,windowsRef:{current:windows},frameRefs:{current:new Map([['/management/equipment',{contentWindow:equipment}],['/work-orders',{contentWindow:{postMessage:m=>messages.push(m)}}]])},closeWindow(){throw Error('must remain open');},loadDashboard(){throw Error('no reload');}});
 const event={origin,source:equipment,data:{type:'cmpri-assets-changed',assetId:'created',modalToken:'equipment-token'}};
 handler({...event,data:{...event.data,modalToken:'wrong'}});assert.equal(messages.length,0);handler(event);assert.equal(messages.length,1);assert.equal(messages[0].modalToken,'form-token');assert.equal(windows.length,2);
});
