import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTs } from './helpers/load-ts.mjs';

test('restored winter checklist preserves every supplied source word and all 32 item identities',()=>{
  const {WINTER_TASKS,WINTER_TASK_IDS}=loadTs('src/lib/winter-preparedness.ts');
  assert.equal(WINTER_TASKS.length,21);
  assert.equal(WINTER_TASKS[19].children.length,8);
  assert.equal(WINTER_TASKS[20].children.length,3);
  assert.equal(new Set(WINTER_TASK_IDS).size,32);
  const normalize=s=>s.replace(/\u200b/g,'').replace(/\s+/g,' ').trim();
  const source=readFileSync(new URL('./fixtures/winter-preparedness-source.txt',import.meta.url),'utf8').split('Maintenance & IT -> Additional Resources')[1];
  const actual=WINTER_TASKS.flatMap(t=>[t.text,...(t.children||[]).map(c=>c.text)]).join(' ');
  assert.equal(normalize(actual),normalize(source));
});

test('Winter Preparedness gives technicians and senior management read-only access', async () => {
  const winter = loadTs('src/lib/winter-preparedness.ts');
  const store = loadTs('src/lib/server/winter-preparedness-store.ts');
  const access = loadTs('src/lib/winter-preparedness-access.ts');
  const profile = { id:'account', active:true, full_name:'Fixture' };
  const identity = { id:profile.id, email:'fixture@example.invalid' };
  const membership = { user_id:profile.id, hotel_id:'hotel', active:true };
  const principal = { profile, identity, membership, hotelId:'hotel', permissions:[] };
  let writes = 0;
  const item = { item_id:winter.WINTER_TASK_IDS[0], checked:true, revision:1 };
  const query = {
    eq() { return this; },
    select() { return this; },
    insert() { writes++; return this; },
    maybeSingle: async () => ({ data:item }),
    then(resolve) { return Promise.resolve({ data:[item] }).then(resolve); },
  };
  const route = loadTs('src/app/api/winter-preparedness/route.ts', {
    '@/lib/server/auth': { requireUserAttempt:async () => ({ ok:true, principal, admin:{from:() => query}, mcp:false }) },
    '@/lib/server/winter-preparedness-store': store,
    '@/lib/winter-preparedness-access': access,
    '@/lib/server/manual-preview': { manualPreviewReadOnly:() => false },
  }, { Response });
  const request = { text:async () => JSON.stringify({ item_id:item.item_id, checked:true, revision:0 }) };
  for (const role of ['technician', 'senior_management']) {
    profile.role = role;
    const read = await route.GET({});
    assert.equal(read.status, 200, role);
    assert.deepEqual(await read.json(), { items:[item], preview_read_only:false, can_edit:false }, role);
    assert.equal((await route.PATCH(request)).status, 403, role);
  }
  for (const role of ['front_desk', 'housekeeping']) {
    profile.role = role;
    assert.equal((await route.GET({})).status, 403, role);
    assert.equal((await route.PATCH(request)).status, 403, role);
  }
  assert.equal(writes, 0);
  profile.role = 'manager';
  assert.equal((await (await route.GET({})).json()).can_edit, true);
  assert.equal((await route.PATCH(request)).status, 200);
  assert.equal(writes, 1);
});
