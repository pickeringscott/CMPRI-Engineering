import assert from 'node:assert/strict';
import {normalizePoProductFields,poImportFieldIssue} from '../src/lib/po-import-field-review.ts';
import {persistReviewedPoPlan} from '../src/lib/server/po-import.ts';
import {persistReviewedOfflineRecovery,offlineRecoveryDigest} from '../src/lib/server/po-offline-recovery.ts';
for(const [item,url] of [
 ['MASTERFO RCE BOOST? 20-VOLT 8.0AH XHC? LITHIUM-I ON BATTERY','https://www.menards.com/main/battery.htm'],
 ['UNIMAC #F980P3 WASHER KIT CONTROL ASSY','https://parts.alliancelaundry.com/washer.html'],
 ['VALVE CORE REMOVAL TOOL HVAC','https://www.amazon.com/dp/B09Y16QJRS']]){
 const source={sourceFormat:'ibuy-offline',itemNumber:item,description:url},before=structuredClone(source);
 const n=normalizePoProductFields(source);assert.equal(n.description,item);assert.equal(n.productUrl,url);assert.equal(n.supplierSku,null);assert.equal(n.reviewRequired,false);assert.deepEqual(n.source,before);assert.deepEqual(source,before);
 assert.ok(poImportFieldIssue({sku:item,description:url}));
}
const numeric={sourceFormat:'ibuy-offline',itemNumber:'837679',description:'Single Gang Old Work Electrical Box PVC'};
assert.equal(normalizePoProductFields(numeric).supplierSku,'837679');
assert.equal(normalizePoProductFields({...numeric,description:'https://example.test/product'}).reviewRequired,true);
assert.equal(normalizePoProductFields({sourceFormat:'supplier-table',itemNumber:'NOT A VERIFIED NAME',description:'https://example.test/product'}).reviewRequired,true);
for(const description of ['https://user:password@example.test/item','https://example.test:123/item','http://example.test/item','https://example.test/a b'])assert.equal(normalizePoProductFields({...numeric,description}).reviewRequired,true);
let calls=0;const admin={rpc:async()=>{calls++;return {data:'id'}}};
const bad={sku:'Product name',description:'https://example.test/product',quantity:1,uom:'EA'};
await persistReviewedPoPlan(admin,'hotel','actor',{orders:[{externalPo:'123',supplier:'Vendor',lines:[bad],evidence:[]}],review:[]});assert.equal(calls,0);
const documents=[{order:{lines:[{...bad,sku:"837679"}]}}];await assert.rejects(()=>persistReviewedOfflineRecovery(admin,'hotel','actor',documents,offlineRecoveryDigest(documents)),/Actual product name/);assert.equal(calls,0);
await persistReviewedPoPlan(admin,'hotel','actor',{orders:[{externalPo:'123',supplier:'Vendor',lines:[{...bad,sku:'837679',description:numeric.description}],evidence:[]}],review:[]});assert.equal(calls,1);
console.log('PASS source semantics, URL/identifier ambiguity, immutable provenance, and both persistence gates');

for(const sourceFormat of ['ibuy-offline','supplier-table']){const source={sourceFormat,itemNumber:'https://example.test/product',description:'Actual product title'};assert.equal(normalizePoProductFields(source).reviewRequired,true);assert.equal(normalizePoProductFields(source).source.itemNumber,source.itemNumber);}
console.log('PASS URL identifiers held in both import formats without swapping or losing provenance');
