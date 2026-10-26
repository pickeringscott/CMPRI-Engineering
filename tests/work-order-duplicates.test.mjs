import test from 'node:test';
import assert from 'node:assert/strict';
import { likelyDuplicate } from '../src/lib/work-order-duplicates.ts';
const a={location_id:'409',asset_id:'sink',issue:'Sink leaking'};
for(const [name,other,expected] of [
  ['punctuation',{...a,issue:'SINK leaking!'},true],
  ['common wording',{...a,issue:'The sink is leaking'},true],
  ['extra details',{...a,issue:'Sink leaking under cabinet'},true],
  ['another room',{...a,location_id:'410'},false],
  ['another asset',{...a,asset_id:'shower'},false],
  ['completed history',{...a,status:'Completed'},false],
  ['done history',{...a,status:'Done'},false],
  ['closed history',{...a,status:'Closed'},false],
  ['different issue',{...a,issue:'Sink is clogged'},false],
  ['missing asset',{...a,asset_id:null},true],
])test(`duplicate matching: ${name}`,()=>assert.equal(likelyDuplicate(a,other),expected));
test('negation is retained',()=>assert.equal(likelyDuplicate({...a,issue:'Unit cooling'},{...a,issue:'Unit not cooling'}),false));
test('domain synonyms and inflections match',()=>{
  assert.equal(likelyDuplicate({...a,asset_id:'vtac',issue:'AC not cooling'},{...a,asset_id:'vtac',issue:"Air conditioner isn't cool"}),true);
  assert.equal(likelyDuplicate({...a,asset_id:'tv',issue:'TV no signal'},{...a,asset_id:'tv',issue:'Television no picture'}),true);
});

import { duplicateWithinReport } from '../src/lib/work-order-duplicates.ts';
for (const [left, right, expected] of [
  ['Reading light not working', 'Light under microwave not working', false],
  ['Shower handle broken', 'Cabinet handle broken', false],
  ['Sink leaking', 'The sink is leaking!', true],
  ['AC not cooling', "Air conditioner isn't cool", true],
  ['TV no signal', 'Television no picture', true],
  ['Reading light', 'Reading light', true],
  ['Light working', 'Light not working', false],
  ['', '', false],
]) test(`intra-report comparison: ${left} / ${right}`, () => {
  assert.equal(duplicateWithinReport({...a,issue:left},{...a,issue:right}), expected);
});
test('intra-report comparison respects room and equipment boundaries', () => {
  assert.equal(duplicateWithinReport(a,{...a,location_id:'410'}),false);
  assert.equal(duplicateWithinReport(a,{...a,asset_id:'shower'}),false);
});
