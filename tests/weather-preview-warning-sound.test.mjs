import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './helpers/load-ts.mjs';

function fixture(options={}) {
  const calls={created:0,resumed:0,fetched:[],decoded:0,started:0,stopped:[],ramps:[],disconnected:0};
  let allowResume=options.allowResume!==false,releaseDecode,context;
  const decodeGate=options.pendingDecode?new Promise(resolve=>{releaseDecode=resolve;}):null;
  class Context {
    constructor(){calls.created++;this.state=options.state||'suspended';this.currentTime=12;this.destination={};context=this;}
    resume(){calls.resumed++;if(!allowResume)return Promise.reject(Error('Browser blocked'));this.state='running';return Promise.resolve();}
    async decodeAudioData(){calls.decoded++;if(decodeGate)await decodeGate;if(options.badDecode)throw Error('Unsupported audio');return {duration:11.72};}
    createBufferSource(){return {buffer:null,onended:null,connect(){},disconnect(){calls.disconnected++;},start(){calls.started++;},stop(at){calls.stopped.push(at);}};}
    createGain(){return {gain:{value:1,cancelScheduledValues(){},setValueAtTime(){},linearRampToValueAtTime(value,at){calls.ramps.push({value,at});}},connect(){},disconnect(){calls.disconnected++;}};}
  }
  const api=loadTs('src/lib/weather-warning-sound.ts',{}, {
    window:options.unsupported?{}:{AudioContext:Context},
    fetch:async(url,init)=>{calls.fetched.push({url,init});return new Response(new Uint8Array([1,2,3]),{status:options.httpStatus||200});},
  });
  return {api,calls,allowResume:()=>{allowResume=true;},releaseDecode:()=>releaseDecode?.(),pause:()=>{context.state='suspended';}};
}

test('launcher arming creates and resumes AudioContext synchronously, caching only the local decoded siren',async()=>{
  const f=fixture();const armed=f.api.armWeatherWarningSound();
  assert.equal(f.calls.created,1);assert.equal(f.calls.resumed,1,'Gesture activation must happen before asynchronous fetch/decode');
  assert.equal(await armed,true);assert.equal(f.calls.started,0,'Opening Weather alone is silent');
  assert.equal(f.calls.fetched[0].url,'/previews/weather/warning-siren.mp3');
  assert.equal(f.calls.fetched[0].init.credentials,'same-origin');
  await f.api.armWeatherWarningSound();assert.equal(f.calls.fetched.length,1);assert.equal(f.calls.decoded,1);
});

test('new warning keys play once; unchanged keys do not replay and dismiss uses a short gain fade',async()=>{
  const f=fixture();await f.api.armWeatherWarningSound();
  assert.equal(await f.api.playWeatherWarningSound('warning-a'),'played');
  assert.equal(await f.api.playWeatherWarningSound('warning-a'),'duplicate');assert.equal(f.calls.started,1);
  f.api.stopWeatherWarningSound();assert.deepEqual(f.calls.ramps.at(-1),{value:0,at:12.12});
  assert.equal(f.calls.stopped.at(-1),12.14);
  assert.equal(await f.api.playWeatherWarningSound('warning-b'),'played');assert.equal(f.calls.started,2);
});

test('a blocked browser can retry after a real arming gesture without duplicating asset reads',async()=>{
  const f=fixture({allowResume:false});
  assert.equal(await f.api.armWeatherWarningSound(),false);
  assert.equal(await f.api.playWeatherWarningSound('warning'),'blocked');assert.equal(f.calls.started,0);
  f.allowResume();assert.equal(await f.api.armWeatherWarningSound(),true);
  assert.equal(await f.api.playWeatherWarningSound('warning'),'played');assert.equal(f.calls.fetched.length,1);
});

test('dismissing during a browser audio suspension stops immediately rather than resuming stale sound later',async()=>{
  const f=fixture();await f.api.armWeatherWarningSound();await f.api.playWeatherWarningSound('warning');
  f.pause();f.api.stopWeatherWarningSound();assert.equal(f.calls.stopped.at(-1),undefined);
  assert.equal(f.calls.ramps.length,0,'A suspended audio clock cannot run a deferred fade');
});

test('closing while decoding cancels pending playback rather than playing after the warning was dismissed',async()=>{
  const f=fixture({pendingDecode:true});const armed=f.api.armWeatherWarningSound();
  const playing=f.api.playWeatherWarningSound('dismissed-warning');f.api.stopWeatherWarningSound();f.releaseDecode();
  await armed;assert.equal(await playing,'canceled');assert.equal(f.calls.started,0);
});

test('a newer pending warning batch replaces an older pending batch without overlapping sirens',async()=>{
  const f=fixture({pendingDecode:true});const armed=f.api.armWeatherWarningSound();
  const old=f.api.playWeatherWarningSound('older-batch'),current=f.api.playWeatherWarningSound('current-batch');
  f.releaseDecode();await armed;assert.equal(await old,'canceled');assert.equal(await current,'played');assert.equal(f.calls.started,1);
});

test('unsupported browsers and unavailable local audio fail gracefully',async()=>{
  for(const options of [{unsupported:true},{badDecode:true},{httpStatus:404}]) {
    const f=fixture(options);assert.equal(await f.api.armWeatherWarningSound(),false);
    assert.equal(await f.api.playWeatherWarningSound('warning'),'unavailable');assert.equal(f.calls.started,0);
  }
});
