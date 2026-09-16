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
  ['closed history',{...a,status:'Closed'},false],
  ['different issue',{...a,issue:'Sink is clogged'},false],
  ['missing asset',{...a,asset_id:null},true],
])test(`duplicate matching: ${name}`,()=>assert.equal(likelyDuplicate(a,other),expected));
test('negation is retained',()=>assert.equal(likelyDuplicate({...a,issue:'Unit cooling'},{...a,issue:'Unit not cooling'}),false));
