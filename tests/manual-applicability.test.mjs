import test from 'node:test';
import assert from 'node:assert/strict';
import {eligibleManualLinks,manualAssetIdentity,validateManualApplicability} from '../src/lib/manual-applicability.ts';
const asset={id:'washer-4',manufacturer:'UniMac',model_number:'UWN065T4VXU4001',model_family:null,serial_number:'1305000216'};
const choice=(id)=>({object_id:id,storage_path:`Asset Docs/${id}.pdf`,sha256:'a'.repeat(64),applicability:'confirmed_model',applicability_review:{...manualAssetIdentity(asset),confirmed:true}});
test('all explicitly chosen documents belong to one physical asset, independent of names and preferred flags',()=>{
 const files=[{...choice('incorrect-old-title'),preferred:true},{...choice('unrelated-filename'),preferred:false}];
 const result=eligibleManualLinks(asset,files);assert.deepEqual(result.eligible,files);assert.equal(result.unresolved.length,0);
});
test('different physical machines never inherit a choice merely because model and serial match',()=>{
 const result=eligibleManualLinks({...asset,id:'washer-5'},[choice('manual')]);assert.equal(result.eligible.length,0);assert.match(result.unresolved[0].reason,/different physical asset/);
});
test('reference and legacy links stay unresolved, with no inferred compatibility',()=>{
 const result=eligibleManualLinks(asset,[{...choice('reference'),applicability:'reference'},{...choice('legacy'),applicability_review:null}]);assert.equal(result.eligible.length,0);assert.equal(result.unresolved.length,2);
});
test('changed equipment details retain user choices and produce a warning without mandatory reconfirmation',()=>{
 const result=eligibleManualLinks({...asset,serial_number:'1305000017'},[choice('manual')]);assert.equal(result.eligible.length,1);assert.equal(result.warnings.length,1);assert.match(result.warnings[0].reason,/retained/);
});
test('user can explicitly choose manuals even when machine identity fields are not yet recorded',()=>{
 const bare={id:'dryer-2'},review={...manualAssetIdentity(bare),confirmed:true};
 assert.deepEqual(validateManualApplicability(bare,review),review);
 assert.equal(eligibleManualLinks(bare,[{...choice('manual'),applicability_review:review}]).eligible.length,1);
});
test('file identity must be present and confirmation must be explicit',()=>{
 assert.equal(eligibleManualLinks(asset,[{...choice('manual'),sha256:''}]).eligible.length,0);
 assert.throws(()=>validateManualApplicability(asset,{...manualAssetIdentity(asset),confirmed:false}),/Confirm/);
});

test('earlier explicitly confirmed user choices do not require a new confirmation for this release',()=>{
 const old={...choice('existing'),applicability_review:null,compatibility_basis:'user_confirmed',saved_by:'editor'};
 assert.equal(eligibleManualLinks(asset,[old]).eligible.length,1);
 assert.equal(eligibleManualLinks(asset,[{...old,compatibility_basis:'general_reference'}]).eligible.length,0);
});
