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

for (const [name, left, right] of [
  ['Room 128 pressure/drizzling', 'Low water pressure in shower', 'Her shower water pressure is just drizzling out'],
  ['Room 403 pressure buried in a longer report', 'Shower Handle is hard to turn on... Pressure is very low in', 'Low water pressure in shower'],
  ['Room 212 room heat failure', "Heat doesn't turn on. says you can come at anytime.", 'Guest has no heat working in room'],
]) test(`recent repeated report: ${name}`, () => {
  const base = {location_id: 'same-room', status: 'Pending Verification'};
  assert.equal(likelyDuplicate({...base, issue: left}, {...base, issue: right}), true);
  assert.equal(likelyDuplicate({...base, issue: right}, {...base, issue: left}), true);
  assert.equal(likelyDuplicate({...base, issue: left}, {...base, issue: right, status: 'Closed'}), false);
  assert.equal(likelyDuplicate({...base, issue: left}, {...base, issue: right, location_id: 'other-room'}), false);
  assert.equal(likelyDuplicate({...base, issue: left, asset_id: 'a'}, {...base, issue: right, asset_id: 'b'}), false);
});

for (const issue of ['Shower handle falling off', 'Shower is leaking', 'Low water pressure in sink', 'Shower water is cold', 'Shower pressure is not low', "Shower pressure isn't low", 'No low water pressure in shower']) {
  test(`pressure repeats do not block distinct faults: ${issue}`, () => {
    assert.equal(likelyDuplicate({location_id: 'room', issue: 'Low water pressure in shower'}, {location_id: 'room', issue}), false);
  });
}
