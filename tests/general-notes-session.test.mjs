import test from 'node:test';import assert from 'node:assert/strict';
import {NotesSessionGuard,isNotesSessionRestart} from '../src/lib/general-notes-session.ts';
const account={user:{id:'a'},hotelId:'hotel',landing:'/engineering',capabilities:[]};
test('temporary focus failures and a missing SDK snapshot never unmount an already verified notebook',async()=>{
 let now=0,mode='ok';const updates=[];const guard=new NotesSessionGuard(async()=>{if(mode==='fail')throw Error('Temporary 503');return mode==='missing'?{kind:'missing'}:{kind:'authorized',session:account}},(session,message)=>updates.push({session,message}),()=>now);
 await guard.refresh();mode='fail';now+=16000;await guard.refresh();assert.equal(guard.session,account);assert.equal(updates.at(-1).session,account);assert.match(updates.at(-1).message,/temporarily/);mode='missing';now+=16000;await guard.refresh();assert.equal(updates.at(-1).session,account);guard.authChanged('INITIAL_SESSION');guard.authChanged('TOKEN_REFRESHED');assert.equal(guard.session,account);guard.stop();
});
test('focus storms are deduplicated and real revocation still hides the notebook',async()=>{
 let now=0,calls=0,denied=false;const updates=[];const guard=new NotesSessionGuard(async()=>{calls++;return denied?{kind:'denied'}:{kind:'authorized',session:account}},(session,message)=>updates.push({session,message}),()=>now);
 await Promise.all([guard.refresh(),guard.refresh(),guard.refresh()]);for(let i=0;i<20;i++)await guard.refresh();assert.equal(calls,1);denied=true;now+=16000;await guard.refresh();assert.equal(guard.session,null);assert.equal(updates.at(-1).session,null);assert.match(updates.at(-1).message,/Sign in/);guard.stop();
});
test('sign-out and account changes invalidate in-flight checks instead of restoring an old account',async()=>{
 let resolve;const updates=[];const guard=new NotesSessionGuard(()=>new Promise(done=>resolve=done),(session,message)=>updates.push({session,message}));const read=guard.refresh();guard.authChanged('SIGNED_OUT');resolve({kind:'authorized',session:account});await read;assert.equal(guard.session,null);assert.equal(updates.length,1);guard.stop();
 const other=new NotesSessionGuard(async()=>({kind:'authorized',session:account}),(session,message)=>updates.push({session,message}));await other.refresh();other.authChanged('SIGNED_IN','b');assert.equal(other.session,null);other.stop();
});
test('an initially missing session remains gated, and disposed guards do not publish late responses',async()=>{
 const updates=[];const guard=new NotesSessionGuard(async()=>({kind:'missing'}),(session,message)=>updates.push({session,message}));await guard.refresh();assert.equal(updates.at(-1).session,null);assert.match(updates.at(-1).message,/Sign in/);guard.stop();let resolve;const late=new NotesSessionGuard(()=>new Promise(done=>resolve=done),()=>{throw Error('Published after disposal')});const reading=late.refresh();late.stop();resolve({kind:'authorized',session:account});await reading;
});

test('current and older parent-cache restarts retry without confusing actual authorization denials',async()=>{assert.equal(await isNotesSessionRestart(new Response('{}',{status:401,headers:{'X-CMPRI-Session-Changed':'1'}})),true);const legacy=Response.json({error:'The device session changed. Reload to continue.'},{status:401});assert.equal(await isNotesSessionRestart(legacy),true);assert.ok((await legacy.json()).error);for(const response of [Response.json({error:'Unauthorized'},{status:401}),Response.json({error:'Forbidden'},{status:403}),new Response('unreadable',{status:401})])assert.equal(await isNotesSessionRestart(response),false)});
