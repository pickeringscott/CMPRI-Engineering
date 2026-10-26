import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { winterFixture, principal, store, secondActor, otherHotel, loadWinterTs } from './helpers/winter-fixture.mjs';
const { WINTER_TASKS, WINTER_TASK_IDS } = loadWinterTs('src/lib/winter-preparedness.ts');

test('complete source hierarchy: 21 main, 8 supplies, 3 snow-removal tasks', () => {
  assert.equal(WINTER_TASKS.length, 21);
  assert.equal(WINTER_TASKS[19].children.length, 8);
  assert.equal(WINTER_TASKS[20].children.length, 3);
  assert.equal(new Set(WINTER_TASK_IDS).size, 32);
  assert.match(WINTER_TASKS[2].text, /40°F/);
  assert.match(WINTER_TASKS[20].children[2].text, /emergency access roads/);
  const source = readFileSync(new URL('./fixtures/winter-preparedness-source.txt', import.meta.url),'utf8').split('Maintenance & IT -> Additional Resources')[1];
  const normalize = value => value.replace(/\u200b/g,'').replace(/\s+/g,' ').trim();
  const actual = WINTER_TASKS.flatMap(task => [task.text, ...(task.children || []).map(child => child.text)]).join(' ');
  assert.equal(normalize(actual), normalize(source), 'Every source word is preserved, including nested items');
});
test('only approved roles and matching active identity/hotel may use checklist', () => {
  for (const role of ['Chief Engineer','engineer','system_admin','General Manager','Assistant General Manager','Front Desk Manager']) assert.ok(store.winterHotel(principal(role)));
  for (const role of ['front_desk','housekeeping','technician','senior_management','unknown']) assert.throws(() => store.winterHotel(principal(role)), e => e.status === 403);
  for (const change of [p => p.profile.active = false, p => p.membership.active = false, p => p.profile.id = secondActor, p => p.membership.user_id = secondActor, p => p.membership.hotel_id = otherHotel]) {
    const p = principal(); change(p); assert.throws(() => store.winterHotel(p), e => e.status === 403);
  }
  const secondary = principal('front_desk'); secondary.profile.secondary_roles = ['Front Desk Manager']; assert.ok(store.winterHotel(secondary));
  assert.throws(() => store.winterHotel(principal(), true), e => e.status === 403);
});
test('real API/store/Postgres persistence, actor audit, conflict protection and isolation', async () => {
  const f = await winterFixture();
  const patch = body => f.route.PATCH(new Request('http://fixture.invalid/api/winter-preparedness', { method:'PATCH', body:JSON.stringify(body) }));
  try {
    assert.equal((await (await f.route.GET()).json()).items.length, 0);
    assert.equal((await f.db.query('select count(*)::int n from cmpri_winter_items')).rows[0].n, 0);
    const first = await patch({ item_id:'shovels', checked:true, revision:0 }); assert.equal(first.status, 200);
    const saved = (await first.json()).item; assert.equal(saved.changed_by_name,'Fixture Engineer'); assert.equal(saved.revision,1); assert.ok(Date.parse(saved.changed_at));
    assert.equal((await (await f.route.GET()).json()).items[0].checked,true);
    assert.equal((await patch({item_id:'shovels', checked:false, revision:0})).status,409);
    assert.equal((await patch({item_id:'shovels', checked:false, revision:1, changed_by_name:'Spoofed'})).status,400);
    for (const body of [{item_id:'bogus',checked:true,revision:0},{item_id:'shovels',checked:'true',revision:1},{item_id:'shovels',checked:false,revision:-1},{item_id:'shovels',checked:false,revision:1,hotel_id:otherHotel}]) assert.equal((await patch(body)).status,400);
    f.auth.principal = principal('General Manager', secondActor);
    assert.equal((await patch({item_id:'shovels',checked:false,revision:1})).status,200);
    assert.equal((await patch({item_id:'blankets',checked:true,revision:0})).status,200);
    const rows = (await (await f.route.GET()).json()).items;
    assert.equal(rows.find(x=>x.item_id==='shovels').checked,false);
    assert.equal(rows.find(x=>x.item_id==='shovels').changed_by,secondActor);
    const audit = (await f.db.query("select * from cmpri_winter_changes where item_id='shovels' order by revision")).rows;
    assert.equal(audit.length,2); assert.equal(audit[0].checked,true); assert.equal(audit[1].checked,false); assert.equal(audit[1].changed_by_name,'Fixture Manager');
    f.auth.principal = principal('General Manager',secondActor,otherHotel);
    assert.equal((await (await f.route.GET()).json()).items.length,0);
    assert.equal((await patch({item_id:'shovels',checked:true,revision:2})).status,409);
    f.auth.principal = principal('front_desk'); assert.equal((await f.route.GET()).status,403); assert.equal((await patch({item_id:'shovels',checked:true,revision:2})).status,403);
    f.auth.ok = false; assert.equal((await f.route.GET()).status,401);
    await assert.rejects(() => f.db.query('delete from cmpri_winter_changes'), /permission denied/);
    await assert.rejects(() => f.db.query('update cmpri_winter_changes set checked=true'), /permission denied/);
    await f.db.exec('reset role; set role authenticated');
    await assert.rejects(() => f.db.query('select * from cmpri_winter_items'), /permission denied/);
    await assert.rejects(() => f.db.query("update cmpri_winter_items set checked=true"), /permission denied/);
    await f.db.exec('reset role; set role anon');
    await assert.rejects(() => f.db.query('select * from cmpri_winter_changes'), /permission denied/);
  } finally { await f.close(); }
});
test('print rules suppress attribution, controls and surrounding app chrome', () => {
  const css = readFileSync(new URL('../src/app/engineering/winter-preparedness/winter.module.css',import.meta.url),'utf8');
  assert.match(css, /@media print/); assert.match(css, /\.toolbar, \.feedback, \.attribution, \.task input \{ display: none !important/);
  assert.match(css, /body\):has\(\.page\) > :not\(\.page\)/);
});
