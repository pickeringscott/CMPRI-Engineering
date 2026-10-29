import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharedRefresh} from '../src/lib/dashboard/shared-refresh.ts';

const flush = async () => { for(let i=0;i<20;i++) await Promise.resolve(); };
function fixture() {
  let time=0,id=0;
  const timers=new Map(),calls=[];
  const f={ session:{access_token:'alice-token',user:{id:'alice'}}, result:{notifications:{status:200,data:{notifications:[],orders_version:'0',checked_at:'now'}},pool:{status:200,data:{closed:false,revision:1,notifications:[]}}}, request:null };
  const service=createSharedRefresh({
    now:()=>time,
    session:async()=>f.session,
    schedule:(fn,ms)=>{const key=++id;timers.set(key,{at:time+ms,fn});return key;},
    cancel:key=>timers.delete(key),
    request:async(resources,token,signal)=>{calls.push({time,resources,token,signal});return f.request?f.request(resources,token,signal):f.result;},
  });
  async function advance(to) {
    while(true){await flush();const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>to)break;time=next[1].at;timers.delete(next[0]);next[1].fn();}
    time=to;await flush();
  }
  return Object.assign(f,{service,calls,timers,advance,delay:ms=>new Promise(resolve=>{timers.set(++id,{at:time+ms,fn:resolve});})});
}

test('200ms latency still coalesces initial resources without periodic polling',async()=>{
  const f=fixture();f.request=async()=>{await f.delay(200);return f.result;};
  f.service.subscribe('notifications',()=>{});f.service.subscribe('pool',()=>{});
  await f.advance(59999);assert.equal(f.calls.length,1);
  assert.equal(f.calls.filter(c=>c.resources.includes('pool')).length,1);
});

test('one page: notification plus three pool views share one initial request, then idle',async()=>{
  const f=fixture(),pool=[[],[],[]],notes=[];
  const stops=[f.service.subscribe('notifications',e=>notes.push(e),'alice'),...pool.map(events=>f.service.subscribe('pool',e=>events.push(e)))];
  await f.advance(59999);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls.filter(c=>c.resources.includes('pool')).length,1);
  assert.equal(f.calls.filter(c=>c.resources.includes('notifications')).length,1);
  for(const events of pool)assert.equal(events.filter(e=>e.data).length,1);
  assert.equal(notes.filter(e=>e.data).length,1);
  stops.forEach(stop=>stop());assert.equal(f.timers.size,0);
  await f.advance(70000);assert.equal(f.calls.length,1);
});

test('separate tabs/account sessions are independent and do not share results',async()=>{
  const a=fixture(),b=fixture(),ra=[],rb=[];
  b.session={access_token:'bob-token',user:{id:'bob'}};
  a.service.subscribe('pool',e=>ra.push(e));b.service.subscribe('pool',e=>rb.push(e));
  a.result.pool.data.closed=true;
  await a.advance(0);await b.advance(0);
  assert.equal(ra.at(-1).data.closed,true);assert.equal(rb.at(-1).data.closed,false);
  assert.equal(a.calls[0].token,'alice-token');assert.equal(b.calls[0].token,'bob-token');
});

test('slow responses never create overlapping requests; last unsubscribe aborts and remount recovers',async()=>{
  const f=fixture();let finish;f.request=()=>new Promise(r=>finish=r);
  const events=[],stop=f.service.subscribe('pool',e=>events.push(e));
  await f.advance(0);await f.advance(10000);assert.equal(f.calls.length,1);
  stop();assert.equal(f.calls[0].signal.aborted,true);
  const stop2=f.service.subscribe('pool',e=>events.push(e));
  f.request=null;finish(f.result);await f.advance(10000);
  assert.equal(f.calls.length,2);assert.equal(events.filter(e=>e.data).length,1);
  stop2();assert.equal(f.timers.size,0);
});

test('logout and account changes discard in-flight results and clear old state',async()=>{
  const f=fixture(),events=[];let finish;f.request=()=>new Promise(r=>finish=r);
  f.service.subscribe('notifications',e=>events.push(e),'alice');
  await f.advance(0);f.session=null;f.service.reset();finish(f.result);f.request=null;
  await f.advance(0);assert.equal(events.filter(e=>e.data).length,0);
  assert.equal(events.at(-1).reset,true);
  f.session={access_token:'bob-token',user:{id:'bob'}};
  f.service.reset();await f.advance(0);
  assert.equal(events.filter(e=>e.data).length,0,'old Alice subscriber must not receive Bob data');
  assert.equal(f.calls.at(-1).token,'bob-token');
});

test('token change discovered after response also discards old result',async()=>{
  const f=fixture(),events=[];let finish;f.request=()=>new Promise(r=>finish=r);
  f.service.subscribe('pool',e=>events.push(e));await f.advance(0);
  f.session={access_token:'rotated',user:{id:'alice'}};
  finish(f.result);f.request=null;await f.advance(0);
  assert.equal(events.filter(e=>e.data).length,1);
  assert.equal(f.calls.at(-1).token,'rotated');
});

test('transient and individual resource errors recover without stopping other widgets',async()=>{
  const f=fixture(),pool=[],notes=[];
  f.service.subscribe('pool',e=>pool.push(e));f.service.subscribe('notifications',e=>notes.push(e));
  f.request=async()=>{throw Error('offline');};await f.advance(0);
  assert.equal(pool.at(-1).error,'offline');
  f.request=null;f.result.notifications={status:403,data:{error:'Dashboard access is required.'}};
  f.service.invalidate(); await f.advance(5000);
  assert.equal(pool.at(-1).data.closed,false);assert.equal(notes.at(-1).error,'Dashboard access is required.');
});

test('pool closure, manual hold and reopen propagate identically to all mounted views',async()=>{
  const f=fixture(),a=[],b=[];
  f.service.subscribe('pool',e=>a.push(e));f.service.subscribe('pool',e=>b.push(e));
  await f.advance(0);
  f.result.pool={status:200,data:{closed:true,manual_closed:true,revision:2,reason:'Maintenance',notifications:[{id:'closed'}]}};
  f.service.invalidate();await f.advance(0);
  assert.equal(a.at(-1).data.closed,true);assert.equal(b.at(-1).data.manual_closed,true);
  f.result.pool={status:200,data:{closed:false,manual_closed:false,revision:3,notifications:[]}};
  f.service.invalidate();await f.advance(0);
  assert.equal(a.at(-1).data.closed,false);assert.deepEqual(a.at(-1),b.at(-1));
});

test('confirmed inbox mutation invalidates stale unread result and immediately refreshes seen state',async()=>{
  const f=fixture(),events=[];let finish;
  f.request=()=>new Promise(r=>finish=r);
  f.service.subscribe('notifications',e=>events.push(e),'alice');await f.advance(0);
  f.service.invalidate();
  finish({notifications:{status:200,data:{notifications:[{id:'n',is_read:false}]}}});
  f.result.notifications={status:200,data:{notifications:[{id:'n',is_read:true}]}};f.request=null;
  await f.advance(0);
  assert.equal(events.filter(e=>e.data).length,1);assert.equal(events.at(-1).data.notifications[0].is_read,true);
});
