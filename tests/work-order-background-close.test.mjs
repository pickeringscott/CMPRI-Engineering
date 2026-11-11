import test from 'node:test';
import assert from 'node:assert/strict';
import { closeWorkOrderInBackground } from '../src/lib/work-orders/background-close.ts';

test('the work-order window hides immediately while saving continues',async()=>{
  const shell={style:{visibility:''},isConnected:true};let finish;
  const pending=new Promise(resolve=>{finish=resolve;});let saved=false;
  const result=closeWorkOrderInBackground({shell,waitForWrites:()=>pending,saveOrClose:async()=>{saved=true;return true;},onError:()=>assert.fail('Unexpected failure')});
  assert.equal(shell.style.visibility,'hidden');assert.equal(saved,false);finish(true);
  assert.equal(await result,true);assert.equal(saved,true);
});
test('failed pending writes or save restore the editor without dropping the draft',async()=>{
  for(const fail of ['queue','save','throw']){
    const shell={style:{visibility:'visible'},isConnected:true};let errors=0;
    const result=await closeWorkOrderInBackground({shell,waitForWrites:async()=>fail!=='queue',saveOrClose:async()=>{if(fail==='throw')throw Error('offline');return fail!=='save';},onError:()=>errors++});
    assert.equal(result,false);assert.equal(shell.style.visibility,'visible');assert.equal(errors,fail==='throw'?1:0);
  }
});
