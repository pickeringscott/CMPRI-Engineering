// Executes actual route handlers against a fake Supabase boundary; no live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { roleAllows } from '../src/lib/server/roles.ts';
import { maximumAssetInstallYear, parseAssetInstallYear } from '../src/lib/asset-install-year.ts';
function canEditEngineeringData(role) { return roleAllows(role, "edit_tickets"); }
function fixtureRoleKey(value) {
  const key=String(value||'').toLowerCase().replace(/[\s_-]+/g,'');
  if(key==='systemadmin')return 'system_admin';
  if(key==='technician'||key==='maintenancetechnician')return 'technician';
  if(key==='frontdesk')return 'front_desk';
  return 'engineer';
}
function buildPrincipal(config, data, profile) {
  if (config.noUser) return null;
  if (config.authError) return null;
  if (!profile || profile.active !== true) return null;
  if (config.profileError) return null;
  return {
    identity: { id: 'test-user', email: 'test@test.invalid' },
    profile: { id: 'test-user', role: profile.role, active: profile.active, full_name: profile.full_name || 'Test' },
    hotelId: 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6',
    membership: { user_id: 'test-user', hotel_id: 'c81ad01a-7a9f-4880-ac1c-5e849f30bad6', active: true, role: profile.role },
    permissions: config.permission ? [{ role: profile.role, permission: 'manage_assets', allowed: true }] : [],
  };
}

function fixture(route, config={}) {
  const calls=[];
  let insertedAsset=null;
  let updatedAsset=null;
  const assetRows=config.assetRows || (config.asset ? [{id:'test'}] : []);
  const profile=config.profile === undefined ? {active:true,role:config.permission?'Chief Engineer':'Front Desk',full_name:'Test'} : config.profile;
  const data={
    auth:{getUser:async()=>({data:{user:config.noUser?null:{id:'test-user'}},error:config.authError?{message:'auth failed'}:null})},
    from(table){
      calls.push(table);
      const query={
        select(){return query;},eq(){return query;},range(start,end){query.rangeStart=start;query.rangeEnd=end;return query;},
        async maybeSingle(){
          if(table==='profiles')return {data:profile,error:config.profileError?{message:'profile failed'}:null};
          if(table==='role_permissions')return {data:config.permission?{permission:'manage_assets',allowed:true}:null,error:config.permissionError?{message:'permission failed'}:null};
          if(table==='assets')return {data:config.asset?{id:'test'}:null,error:null};
          if(table==='locations')return {data:{id:'test-location',name:'Test location'},error:null};
          throw new Error(`Unexpected table ${table}`);
        },
        order(){return query;},
        then(resolve,reject){return Promise.resolve({data:assetRows.slice(query.rangeStart ?? 0, (query.rangeEnd ?? assetRows.length - 1) + 1),error:null}).then(resolve,reject);},
        insert(row){insertedAsset=row;return query;},
        update(row){updatedAsset=row;return query;},
        async single(){
          if(table!=='assets')throw new Error(`Unexpected single row table ${table}`);
          if(updatedAsset){
            if(updatedAsset.manufacturer===null||updatedAsset.serial_number===null)return {data:null,error:{message:'not-null constraint'}};
            return {data:{id:'test',...updatedAsset},error:null};
          }
          if(insertedAsset.manufacturer===null||insertedAsset.serial_number===null)return {data:null,error:{message:'not-null constraint'}};
          return {data:{id:'created-asset',...insertedAsset},error:null};
        },
      };
      return query;
    },
    storage:{from:()=>({list:async()=>({data:[],error:config.storageError?{message:'Storage unavailable'}:null})})},
  };
  const exports={};
  const compiled=ts.transpileModule(readFileSync(new URL(`../src/app/api/assets/${route}`,import.meta.url),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  vm.runInNewContext(compiled,{exports,process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://test.invalid',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'fake',SUPABASE_SERVICE_ROLE_KEY:'fake'}},
    require(name){
      if(name==='next/server')return {NextResponse:{json:(body,init={})=>({body,status:init.status??200})}};
      if(name==='@supabase/supabase-js')return {createClient:()=>data};
      if(name==='@/lib/engineering-access')return {canEditEngineeringData};
      if(name==='@/lib/constants')return {HOTEL_ID:'c81ad01a-7a9f-4880-ac1c-5e849f30bad6'};
      if(name==='@/lib/asset-install-year')return {maximumAssetInstallYear,parseAssetInstallYear};
      if(name==='@/lib/manual-pdf-knowledge')return {extractManualPdfText:async()=>''};
      if(name==='@/lib/server/auth')return {
        requireUser: async (req) => {
          if (!req.headers.get('authorization')) return null;
          const userData = await data.auth.getUser();
          if (userData.error || !userData.data?.user) return null;
          const profileRes = await data.from('profiles').select('id,full_name,role,active,property_scope').eq('id',userData.data.user.id).maybeSingle();
          if (profileRes.error || !profileRes.data) return null;
          const p = buildPrincipal(config, data, profileRes.data);
          return p ? { principal: p, admin: data } : null;
        },
        requireCapability: async (req, cap) => {
          if (!req.headers.get('authorization')) return null;
          const auth = await (async () => {
            const userData = await data.auth.getUser();
            if (userData.error || !userData.data?.user) return null;
            const profileRes = await data.from('profiles').select('id,full_name,role,active,property_scope').eq('id',userData.data.user.id).maybeSingle();
            if (profileRes.error || !profileRes.data) return null;
            const p = buildPrincipal(config, data, profileRes.data);
            return p ? { principal: p, admin: data } : null;
          })();
          if (!auth) return null;
          if (cap === 'manage_assets') return canEditEngineeringData(auth.principal.profile.role) ? auth : null;
          return auth;
        },
      };
      if(name==='@/lib/server/access')return {
        allows: (principal, cap) => {
          if (cap === 'manage_assets') return true;
          if (cap === 'submit') return true;
          return false;
        },
        authenticate: async () => null,
        resolvePrincipal: () => null,
        hasAnyGrant: () => false,
      };
      if(name==='@/lib/server/roles')return {
        roleKey:fixtureRoleKey,
        canReadEquipment:(role)=>['engineer','technician','system_admin'].includes(fixtureRoleKey(role)),
        canEditEquipment:(role)=>['engineer','system_admin'].includes(fixtureRoleKey(role)),
      };
      if(name==='./access')return {allows:()=>false,authenticate:async()=>null,resolvePrincipal:()=>null,hasAnyGrant:()=>false};
      if(name==='./roles')return {roleAllows,roleKey:()=>'unknown'};
      if(name==='./supabase-admin')return {createSupabaseAdmin:()=>data};
      if(name==='server-only')return {};
      throw new Error(name);},
  });
  const request={headers:new Headers(config.noToken?{}:{authorization:'Bearer fake'}),nextUrl:new URL('https://test.invalid/api/assets?asset_id=test'),
    json:async()=>{if(config.badJson)throw new SyntaxError('Invalid JSON');return config.nullBody?null:(config.body??{id:'test',name:'Test',asset_type:'VTAC'});},formData:async()=>new FormData()};
  return {handlers:exports,request,calls,get insertedAsset(){return insertedAsset;},get updatedAsset(){return updatedAsset;}};
}
for(const [route,method] of [['route.ts','POST'],['route.ts','PATCH'],['documentation/route.ts','POST']]) {
  for(const condition of ['no permission','permission lookup fails'])test(`${route} ${method}: ${condition} denies mutation`,async()=>{
    const f=fixture(route,{permissionError:condition.includes('fails')});
    const result=await f.handlers[method](f.request);
    assert.equal(result.status,403);assert.equal(f.calls.includes('assets'),false);
  });
}
for(const route of ['route.ts','documentation/route.ts']) {
  for(const config of [{noToken:true},{noUser:true},{profile:null},{profile:{active:false,role:'Chief Engineer'}},{profile:{active:null,role:'Chief Engineer'}},{authError:true},{profileError:true}]) {
    test(`${route} GET rejects invalid identity: ${JSON.stringify(config)}`,async()=>{
      const f=fixture(route,config);const result=await f.handlers.GET(f.request);assert.equal(result.status,401);assert.equal(f.calls.includes('assets'),false);
    });
  }
}
test('active read-only account can still read asset list',async()=>{
  const f=fixture('route.ts',{profile:{active:true,role:'Maintenance Technician',full_name:'Tech'}});assert.equal((await f.handlers.GET(f.request)).status,200);
});
test('technician cannot mutate equipment',async()=>{
  const f=fixture('route.ts',{permission:true,profile:{active:true,role:'Maintenance Technician',full_name:'Tech'}});
  assert.equal((await f.handlers.PATCH(f.request)).status,403);
});
test('equipment PATCH clears optional non-null manufacturer and serial number to empty strings',async()=>{
  const f=fixture('route.ts',{permission:true,asset:true,body:{id:'test',manufacturer:'',serial_number:''}});
  const result=await f.handlers.PATCH(f.request);
  assert.equal(result.status,200);
  assert.equal(f.updatedAsset.manufacturer,'');
  assert.equal(f.updatedAsset.serial_number,'');
});
test('equipment PATCH rejects an install year beyond the next calendar year without writing',async()=>{
  const f=fixture('route.ts',{permission:true,asset:true,body:{id:'test',install_year:new Date().getUTCFullYear()+2}});
  const result=await f.handlers.PATCH(f.request);
  assert.equal(result.status,400);
  assert.equal(f.updatedAsset,null);
});
test('asset install-year parser shares one boundary and accepts nullable optional values',()=>{
  const now=new Date('2026-01-01T00:00:00.000Z');
  assert.equal(maximumAssetInstallYear(now),2027);
  assert.equal(parseAssetInstallYear('',now),null);
  assert.equal(parseAssetInstallYear(null,now),null);
  assert.equal(parseAssetInstallYear(1900,now),1900);
  assert.equal(parseAssetInstallYear(2027,now),2027);
  assert.throws(()=>parseAssetInstallYear(1899,now),/Install year is invalid/);
  assert.throws(()=>parseAssetInstallYear(2028,now),/Install year is invalid/);
  assert.throws(()=>parseAssetInstallYear(2026.5,now),/Install year is invalid/);
});
for (const [label, optionalFields, expected] of [
  ['both omitted', {}, { manufacturer: '', serial_number: '' }],
  ['manufacturer omitted', { serial_number: 'AUDIT-SERIAL' }, { manufacturer: '', serial_number: 'AUDIT-SERIAL' }],
  ['serial number omitted', { manufacturer: 'Audit Manufacturer' }, { manufacturer: 'Audit Manufacturer', serial_number: '' }],
  ['both supplied', { manufacturer: 'Audit Manufacturer', serial_number: 'AUDIT-SERIAL' }, { manufacturer: 'Audit Manufacturer', serial_number: 'AUDIT-SERIAL' }],
]) {
  test(`asset creation persists optional manufacturer and serial number when ${label}`,async()=>{
    const f=fixture('route.ts',{permission:true,body:{asset_type:'Audit equipment',location_id:'test-location',...optionalFields}});
    const result=await f.handlers.POST(f.request);
    assert.equal(result.status,200);
    assert.equal(f.insertedAsset.manufacturer,expected.manufacturer);
    assert.equal(f.insertedAsset.serial_number,expected.serial_number);
    assert.equal(result.body.asset.id,'created-asset');
  });
}
test('front desk cannot read equipment management',async()=>{
  const f=fixture('route.ts',{profile:{active:true,role:'Front Desk',full_name:'Front Desk'}});
  assert.equal((await f.handlers.GET(f.request)).status,403);
});
test('GET reads assets beyond the Supabase page limit',async()=>{
  const f=fixture('route.ts',{permission:true,assetRows:Array.from({length:1001},(_,index)=>({id:`asset-${index}`}))});
  const result=await f.handlers.GET(f.request);
  assert.equal(result.status,200);
  assert.equal(result.body.assets.length,1001);
});
test('work-order creation asset mode reads beyond the Supabase page limit',async()=>{
  const f=fixture('route.ts',{permission:true,assetRows:Array.from({length:1001},(_,index)=>({id:`asset-${index}`}))});
  f.request.nextUrl.searchParams.set('mode','create');
  const result=await f.handlers.GET(f.request);
  assert.equal(result.status,200);
  assert.equal(result.body.assets.length,1001);
});
test('authorized editor passes permission gate to scoped asset lookup',async()=>{
  const f=fixture('route.ts',{permission:true});assert.equal((await f.handlers.PATCH(f.request)).status,404);assert.equal(f.calls.includes('assets'),true);
});
test('GET still returns asset records when verification storage cannot be read',async()=>{
  const f=fixture('route.ts',{permission:true,asset:true,storageError:true});
  const result=await f.handlers.GET(f.request);
  assert.equal(result.status,200);
  assert.equal(result.body.documentation_state_available,false);
  assert.equal(result.body.assets.length,1);
});
test('PATCH fails closed when verification storage cannot be read',async()=>{
  const f=fixture('route.ts',{permission:true,asset:true,storageError:true});
  assert.equal((await f.handlers.PATCH(f.request)).status,503);
});
test('equipment save confirmation is shown only after the refreshed asset list succeeds',()=>{
  const source=readFileSync(new URL('../src/app/management/equipment/page.tsx',import.meta.url),'utf8');
  const ast=ts.createSourceFile('equipment-page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const functions=new Map();
  const visit=(node)=>{
    if(ts.isFunctionDeclaration(node)&&node.name&&['loadAssets','save','verify'].includes(node.name.text)){
      functions.set(node.name.text,node.getText(ast));
    }
    ts.forEachChild(node,visit);
  };
  visit(ast);
  const load=functions.get('loadAssets');
  const save=functions.get('save');
  const verify=functions.get('verify');
  assert.ok(load&&save&&verify);
  assert.match(load,/Promise<boolean>/);
  assert.match(load,/return true/);
  assert.match(load,/return false/);
  assert.match(save,/if\s*\(await loadAssets\(selectedId\)\)\s*setMessage\("Equipment saved\."\)/);
  assert.match(verify,/if\s*\(await loadAssets\(selectedId\)\)\s*setMessage\("Verified from documentation\. These equipment fields are now locked\."\)/);
  assert.match(source,/parseAssetInstallYear\(draft\.install_year\)/);
  assert.match(source,/max=\{maximumAssetInstallYear\(\)\}/);
});
for(const method of ['POST','PATCH'])for(const config of [{badJson:true},{nullBody:true}])test(`${method} rejects malformed input ${JSON.stringify(config)}`,async()=>{
  const f=fixture('route.ts',{permission:true,...config});assert.equal((await f.handlers[method](f.request)).status,400);
});

for (const role of ['Front Desk','Housekeeping','Unknown']) {
  for (const [route,method] of [['route.ts','POST'],['route.ts','PATCH'],['documentation/route.ts','POST']]) test(`${role} cannot gain equipment write access from an erroneous permission row (${route} ${method})`,async()=>{
    const f=fixture(route,{profile:{active:true,role},permission:true});assert.equal((await f.handlers[method](f.request)).status,403);assert.equal(f.calls.includes('assets'),false);
  });
}

const documentationSource=readFileSync(new URL('../src/app/api/assets/documentation/route.ts',import.meta.url),'utf8');
const documentationAst=ts.createSourceFile('documentation-route.ts',documentationSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const extractorNames=new Set(['cleanPhrase','firstCapture','extractEquipmentSuggestions']);
const extractorFunctions=documentationAst.statements
  .filter(node=>ts.isFunctionDeclaration(node)&&extractorNames.has(node.name?.text))
  .map(node=>node.getText(documentationAst)).join('\n');
assert.equal(documentationAst.statements.filter(node=>ts.isFunctionDeclaration(node)&&extractorNames.has(node.name?.text)).length,3);
const extractorExports={};
vm.runInNewContext(ts.transpileModule(extractorFunctions+'\nexports.extract=extractEquipmentSuggestions;',{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{exports:extractorExports});
const extractEquipmentSuggestions=extractorExports.extract;

test('equipment PDF extractor reads explicitly labelled fields',()=>{
  const result=extractEquipmentSuggestions('PAGE 1 Equipment Type: Pool Conditioner Manufacturer: Maritime Geothermal Ltd. Model Number: PC-55-P-15-T-KDERS-13 Serial No: 12345-AB Generation: 2 Installation Year: 2024 Voltage: 208V');
  assert.equal(result.asset_type,'Pool Conditioner');
  assert.equal(result.manufacturer,'Maritime Geothermal Ltd');
  assert.equal(result.model_number,'PC-55-P-15-T-KDERS-13');
  assert.equal(result.serial_number,'12345-AB');
  assert.equal(result.generation,'2');
  assert.equal(result.install_year,2024);
});

test('equipment PDF extractor supports S/N and manufactured-by labels',()=>{
  const result=extractEquipmentSuggestions('Manufactured by Friedrich Air Conditioning Model: VEA12K34-RTL-B S/N: ABC12345');
  assert.equal(result.manufacturer,'Friedrich Air Conditioning');
  assert.equal(result.model_number,'VEA12K34-RTL-B');
  assert.equal(result.serial_number,'ABC12345');
});

test('equipment PDF extractor accepts an explicitly labelled model family',()=>{
  const result=extractEquipmentSuggestions('Manufacturer: Friedrich Model Family: Verdepac VTAC');
  assert.equal(result.manufacturer,'Friedrich');
  assert.equal(result.model_family,'Verdepac VTAC');
});

test('equipment PDF extractor does not guess identifiers from unlabeled manual numbers',()=>{
  assert.equal(extractEquipmentSuggestions('Service manual revision 70398301R2 published 2025. Input 208 volts. Page count 44.'),null);
});
