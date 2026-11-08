import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceDataCache } from '../src/lib/data-cache/core.ts';
import { MemoryDataStore } from '../src/lib/data-cache/store.ts';
import { dataCachePolicy, mutationTopics } from '../src/lib/data-cache/policy.ts';
const json = value => Response.json(value);
const policy = { topics: ['rooms'], ttl: 1000, durable: true };
test('shared reads deduplicate requests and use fresh memory/disk data until expiration', async () => {
  const disk = new MemoryDataStore(); let now = 1, calls = 0, release;
  const cache = new DeviceDataCache(disk, () => now);
  const load = async () => { calls++; await new Promise(resolve => { release = resolve; }); return json({ value: calls }); };
  const first = cache.read('user:hotel:permissions','/api/rooms',policy,load), second = cache.read('user:hotel:permissions','/api/rooms',policy,load);
  await new Promise(setImmediate); assert.equal(calls,1); release();
  assert.deepEqual(await (await first).json(),{value:1}); assert.deepEqual(await (await second).json(),{value:1});
  assert.equal((await cache.read('user:hotel:permissions','/api/rooms',policy,load)).headers.get('X-CMPRI-Data-Cache'),'hit');
  const restarted = new DeviceDataCache(disk, () => now);
  assert.equal((await restarted.read('user:hotel:permissions','/api/rooms',policy,load)).headers.get('X-CMPRI-Data-Cache'),'hit');
  now=1002;
  assert.deepEqual(await (await restarted.read('user:hotel:permissions','/api/rooms',policy,async()=>{calls++;return json({value:2})})).json(),{value:2});
  assert.equal(calls,2);
});
test('topic changes refresh only related records; unchanged revision vectors preserve local data',async()=>{
  const disk=new MemoryDataStore(),cache=new DeviceDataCache(disk);let calls=0;
  await cache.reconcile('a',{rooms:1,pool:1});
  const load=()=>{calls++;return Promise.resolve(json({value:calls}))};
  await cache.read('a','/rooms',policy,load);await cache.read('a','/pool',{...policy,topics:['pool']},load);
  const restart=new DeviceDataCache(disk);
  assert.deepEqual(await restart.reconcile('a',{rooms:1,pool:1}),[]);
  await restart.read('a','/rooms',policy,load);assert.equal(calls,2);
  assert.deepEqual(await restart.reconcile('a',{rooms:2,pool:1}),['rooms']);
  await restart.read('a','/rooms',policy,load);await restart.read('a','/pool',{...policy,topics:['pool']},load);assert.equal(calls,3);
  await restart.reconcile('a',{rooms:1});assert.equal(calls,3,'retired/out-of-order signals do not roll versions back');
});
test('invalidation during a read and logout cannot repopulate the cleared persistent cache',async()=>{
  const disk=new MemoryDataStore(),cache=new DeviceDataCache(disk);let release;
  const pending=cache.read('a','/rooms',policy,()=>new Promise(resolve=>{release=resolve}));await new Promise(setImmediate);
  await cache.invalidate('a',['rooms']);release(json({old:true}));await pending;
  assert.equal(disk.entries.size,0);
  await cache.read('a','/rooms',policy,async()=>json({fresh:true}));assert.equal(disk.entries.size,1);
  await cache.clear();assert.equal(disk.entries.size,0);assert.equal(disk.vectors.size,0);
});
test('user, property, permission signature, route filters and transient response types stay isolated',async()=>{
  const disk=new MemoryDataStore(),cache=new DeviceDataCache(disk);let calls=0;
  const load=async()=>json({value:++calls});
  for(const scope of ['a:hotel1:role1','b:hotel1:role1','a:hotel2:role1','a:hotel1:role2'])await cache.read(scope,'/rooms',policy,load);
  await cache.read('a:hotel1:role1','/rooms?active=1',policy,load);assert.equal(calls,5);
  for(const response of [Response.json({error:'denied'},{status:403}),new Response('file'),json({access_token:'must-not-persist'}),json({signedUrl:'temporary'}),json({url:'https://example.invalid/storage/v1/object/sign/file?token=secret'})]){
    const isolated=new MemoryDataStore();await new DeviceDataCache(isolated).read('a','/data',policy,async()=>response);assert.equal(isolated.entries.size,0);
  }
  assert.equal(dataCachePolicy('/api/room-operations/guest-reports/drive'),null);assert.equal(dataCachePolicy('/api/session'),null);assert.equal(dataCachePolicy('/api/profile'),null);assert.equal(dataCachePolicy('/api/work-orders/00000000-0000-4000-8000-000000000001'),null);
  assert.equal(dataCachePolicy('/api/work-orders/references').durable,true);
  assert.equal(dataCachePolicy('/api/staff-notes').durable,false);
  assert.deepEqual(mutationTopics('/api/profile/header-layout'),[]);
});
