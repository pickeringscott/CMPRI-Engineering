import {createClient} from '@supabase/supabase-js';
import ts from 'typescript';
import webpush from 'web-push';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createECDH,randomBytes} from 'node:crypto';
const k=JSON.parse(readFileSync(new URL('../../.sandbox/local-keys.json',import.meta.url)));
assert.match(k.API_URL,/^http:\/\/(127\.0\.0\.1|localhost):54321$/);
const admin=createClient(k.API_URL,k.SERVICE_ROLE_KEY,{auth:{persistSession:false}}),hotel='c81ad01a-7a9f-4880-ac1c-5e849f30bad6';
const users=JSON.parse(readFileSync(new URL('../../.sandbox/synthetic-users.json',import.meta.url)));
function compile(file,deps){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../src/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,{exports,require:n=>{if(n in deps)return deps[n];throw Error(n)},process,console});return exports;}
const schedule=compile('lib/notifications/schedule.ts',{});
const delivery=compile('lib/notifications/web-push.ts',{'web-push':webpush,'@/lib/constants':{HOTEL_ID:hotel},'@/lib/notifications/schedule':schedule});
const vapid=webpush.generateVAPIDKeys();Object.assign(process.env,{WEB_PUSH_VAPID_PUBLIC_KEY:vapid.publicKey,WEB_PUSH_VAPID_PRIVATE_KEY:vapid.privateKey,WEB_PUSH_VAPID_SUBJECT:'mailto:synthetic@example.invalid'});
async function ok(q){const r=await q;if(r.error)throw r.error;return r.data;}
const outcomes=[];
for(const u of users.filter(x=>['technician','chief_engineer'].includes(x.role))){
const profileRows=await ok(admin.from('profiles').select('role,secondary_roles').eq('id',u.id));assert.equal(profileRows[0].role,u.role);assert.ok(schedule.isWebPushEligibleProfile(profileRows[0]));
const ecdh=createECDH('prime256v1');ecdh.generateKeys();
const endpoint='https://127.0.0.1:3143/synthetic-'+u.role;
const subscription={endpoint,keys:{p256dh:ecdh.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
await ok(admin.from('cmpri_web_push_subscriptions').insert({hotel_id:hotel,recipient_user_id:u.id,endpoint,subscription}));
const settings={timezone:'UTC',schedule:Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(d=>[d,{enabled:false,start:'00:00',end:'00:00'}]))};
await ok(admin.from('cmpri_user_notification_schedules').insert({hotel_id:hotel,user_id:u.id,...settings}));
const notification={id:'synthetic-ordinary-work-order-'+u.role,message:'Synthetic room work order',target_path:'/technician'};
await delivery.dispatchWebPushNotifications(admin,u.id,{role:u.role},[notification]);
let rows=await ok(admin.from('cmpri_web_push_deliveries').select('status').eq('recipient_user_id',u.id));assert.deepEqual(rows,[{status:'pending'}]);
for(const d of Object.values(settings.schedule))d.enabled=true;
await ok(admin.from('cmpri_user_notification_schedules').update(settings).eq('user_id',u.id));
await delivery.dispatchWebPushNotifications(admin,u.id,{role:u.role},[notification]);
await delivery.dispatchWebPushNotifications(admin,u.id,{role:u.role},[notification]);
rows=await ok(admin.from('cmpri_web_push_deliveries').select('status').eq('recipient_user_id',u.id));assert.deepEqual(rows,[{status:'sent'}]);
const receipts=readFileSync(new URL('../../.sandbox/push-receipts.jsonl',import.meta.url),'utf8').trim().split('\n').map(JSON.parse);assert.equal(receipts.length,outcomes.length+1);assert.ok(receipts[0].bytes>0);
outcomes.push({role:u.label,storedRole:u.role,quietHoursPending:true,resumedSent:true,repeatedDispatchNoDuplicate:true});
}
assert.equal(outcomes.length,2);
assert.equal(schedule.isWebPushEligibleProfile({role:'engineer'}),false);
writeFileSync(new URL('../../.sandbox/notification-db-results.json',import.meta.url),JSON.stringify({outcomes,genericEngineerExcluded:true,coverage:'Actual dispatch module, real local DB profiles and persistence, controlled encrypted HTTPS receiver; no browser enrollment or staff delivery'},null,2));console.log(JSON.stringify({phase:'controlled-push',passed:true,outcomes}));
