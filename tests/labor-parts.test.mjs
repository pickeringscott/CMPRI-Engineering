import test from 'node:test';import assert from 'node:assert/strict';
import {suggestedSupplies,exactSupply,partsMentionedInNotes,linkedPartStatus,PART_STATUSES} from '../src/lib/work-order-parts.ts';
const items=[{id:'1',item_name:'LED bulb',quantity_on_hand:12,quantity_reserved:2,unit_of_measure:'EA'},{id:'2',item_name:'Faucet washer',quantity_on_hand:2,quantity_reserved:0,unit_of_measure:'EA'}];
test('everyday issue wording narrows suggestions without choosing a part',()=>{assert.deepEqual(suggestedSupplies(items,'Bathroom light is out').map(i=>i.id),['1']);assert.deepEqual(suggestedSupplies(items,'tap leaks').map(i=>i.id),['2']);assert.equal(exactSupply(items,'Bathroom light'),undefined);assert.equal(exactSupply(items,'LED bulb')?.id,'1');assert.equal(exactSupply([...items,items[0]],'LED bulb'),undefined);});
test('only explicit needed or ordered parts in note text are offered, ignoring generated history and author metadata',()=>{
 const notes='CMPRI2|2026-11-09T10:00:00Z|Scott|Engineer|note|Need a replacement fitting.\nCMPRI|2026-11-09|Scott|note|LED bulb on order.\nCMPRI|2026-11-09|Scott|note|[Supply use] Used 1 bulb.\nPlease check the bathroom light.';
 assert.deepEqual(partsMentionedInNotes(notes),['replacement fitting','LED bulb']);
});
test('manual-origin PO exemption and stock-unit partial receipts follow existing receiving rules',()=>{
 const part={requested_status:'Need to Order',po_line_id:'line',quantity:2};const line={order_id:'po'};
 assert.equal(linkedPartStatus(part,line,{acceptance:'unresolved',origin:'manual',cancelled:false},0),'On Order');
 assert.equal(linkedPartStatus(part,line,{acceptance:'accepted',cancelled:false},1),'On Order');
 assert.equal(linkedPartStatus(part,line,{acceptance:'accepted',cancelled:false},2),'Received');
 assert.equal(linkedPartStatus(part,line,{acceptance:'accepted',cancelled:true},2),'Received');
 assert.equal(linkedPartStatus(part,line,{acceptance:'submitted',origin:'ibuy',cancelled:false},0),'Need to Order');
 assert.deepEqual(PART_STATUSES,['In-House','Need to Order','On Order','Received']);
});

test('notes retain explicit used/replaced parts and exclude negative ordering statements',()=>{
 assert.deepEqual(partsMentionedInNotes('Do not order a bulb. No parts needed. Replaced the LED bulb. Used 2 filters.'),['LED bulb','filters']);
});
test('PO remapping cannot make the old selected supply Received',()=>{
 assert.equal(linkedPartStatus({requested_status:'Need to Order',po_line_id:'line',inventory_item_id:'old',quantity:1},{order_id:'po',inventory_item_id:'new'},{acceptance:'accepted',cancelled:false},2),'Need to Order');
});

test('exact automatic mapping preserves dimensions, fractions, and non-ASCII names',()=>{
 const sized=[{...items[1],item_name:'½-inch washer'}];
 assert.equal(exactSupply(sized,'¾-inch washer'),undefined);assert.equal(exactSupply(sized,'½-inch washer')?.id,'2');
 assert.equal(exactSupply([{...items[1],item_name:'válvula'}],'valvula'),undefined);
});
test('changing the issue recomputes suggestions without changing saved parts or inventory',()=>{
 const before=structuredClone(items);
 assert.deepEqual(suggestedSupplies(items,'Bathroom light is out').map(item=>item.id),['1']);
 assert.deepEqual(suggestedSupplies(items,'Faucet is leaking').map(item=>item.id),['2']);assert.deepEqual(items,before);
});

test('ticket parts cache is a durable snapshot; main ticket open remains a server read',async()=>{
 const {dataCachePolicy}=await import('../src/lib/data-cache/policy.ts');
 const url='/api/work-orders/00000000-0000-4000-8000-000000000001';
 assert.equal(dataCachePolicy(url),null);assert.equal(dataCachePolicy(url+'/parts').durable,true);
});
