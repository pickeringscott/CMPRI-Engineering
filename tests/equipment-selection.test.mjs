import test from 'node:test';
import assert from 'node:assert/strict';
import {equipmentOptionLabel} from '../src/lib/equipment-selection.ts';
test('same-name binder records remain distinguishable by source tag and quantity',()=>{
 assert.equal(equipmentOptionLabel({name:'Dining chair',binder_tag:'LM206',quantity:12}),'Dining chair · LM206 · Qty 12');
 assert.equal(equipmentOptionLabel({name:'Dining chair',binder_tag:'LM218',quantity:8}),'Dining chair · LM218 · Qty 8');
});
test('labels preserve zero quantity and deduplicate identical tags',()=>assert.equal(equipmentOptionLabel({name:'Lamp',binder_tag:'L1',asset_tag:'L1',quantity:0}),'Lamp · L1 · Qty 0'));
