import type {SupabaseClient} from '@supabase/supabase-js';
import {createHmac,randomUUID} from 'node:crypto';
import {HOTEL_ID} from '@/lib/constants';
import {existingDriveToken,driveRequest,secretEqual,DRIVE_PO_ACCOUNT} from './drive-po-api';
import {withRankerWrite} from './room-ranker-write';
import {isIntegrationsSafeMode} from './integrations-safe-mode';
import {verifyDriveSheetVersion} from '@/lib/integrations/provider-event-contracts';
const callback='https://www.cmpri-engineering.com/api/integrations/room-ranker/watch/notify';
function fileId(){const id=process.env.CMPRI_ROOM_RANKER_SPREADSHEET_ID||'';if(!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('Configured spreadsheet required');return id;}
function token(id:string,file:string){const secret=process.env.CRON_SECRET;if(!secret)throw Error('Existing CRON_SECRET required');return createHmac('sha256',secret).update(`cmpri-ranker:${HOTEL_ID}:${file}:${id}`).digest('hex');}
async function access(){
 const credential=await existingDriveToken();
 const about=await driveRequest<{user?:{emailAddress?:string}}>(credential,'about?fields=user(emailAddress)');
 if(about.user?.emailAddress?.toLowerCase()!==DRIVE_PO_ACCOUNT)throw Error('Existing Drive account mismatch');
 const file=fileId();
 const metadata=await driveRequest<{id:string;version:string;mimeType:string;trashed?:boolean}>(credential,`files/${file}?fields=id,version,mimeType,trashed&supportsAllDrives=true`);
 return {credential,file,version:verifyDriveSheetVersion(file,metadata)};
}
export async function rankerWatchStatus(admin:SupabaseClient){
 const result=await admin.from('cmpri_ranker_watch_channels').select('id,status,expires_at,sync_received_at').eq('hotel_id',HOTEL_ID).eq('file_id',fileId()).order('expires_at',{ascending:false}).limit(5);
 if(result.error)throw Error('Ranker watch registry unavailable');return result.data;
}
/** Only explicit operator activation or renewal of an already active channel registers a watch. */
export async function ensureRankerWatch(admin:SupabaseClient,activate=false){
 if(!process.env.CMPRI_ROOM_RANKER_SPREADSHEET_ID)return {status:'disabled'};
 if(isIntegrationsSafeMode())return {status:'safe-mode'};
 const file=fileId();
 const result=await admin.from('cmpri_ranker_watch_channels').select('id,status,expires_at').eq('hotel_id',HOTEL_ID).eq('file_id',file).in('status',['active','pending']).order('expires_at',{ascending:false}).limit(10);
 if(result.error)throw Error('Ranker watch registry unavailable');
 const rows=result.data||[];
 if(!activate&&!rows.some(row=>row.status==='active'))return {status:'disabled'};
 const active=rows.find(row=>row.status==='active'&&Date.parse(row.expires_at)>Date.now()+6*3600000);
 if(active)return {status:'active'};
 if(rows.some(row=>row.status==='pending'&&Date.parse(row.expires_at)>Date.now()))return {status:'pending-verification'};
 const verified=await access(),id=randomUUID(),expiration=Date.now()+23*3600000;
 const reserved=await admin.rpc('cmpri_ranker_reserve_watch',{p_hotel:HOTEL_ID,p_file:file,p_id:id,p_expiry:new Date(expiration).toISOString()});
 if(reserved.error)throw Error('Watch reservation failed');if(reserved.data!==true)return {status:'registration-in-progress-or-active'};
 // An uncertain response leaves this reservation pending. No blind registration retry.
 const watched=await driveRequest<{id:string;resourceId:string;expiration:string}>(verified.credential,`files/${file}/watch`,{method:'POST',body:JSON.stringify({id,type:'web_hook',address:callback,token:token(id,file),expiration})});
 if(watched.id!==id||!watched.resourceId||!Number.isFinite(Number(watched.expiration))||Number(watched.expiration)<=Date.now()||Number(watched.expiration)>expiration+60000)throw Error('Unverified watch response');
 const saved=await admin.rpc('cmpri_ranker_bind_watch',{p_hotel:HOTEL_ID,p_id:id,p_resource:watched.resourceId,p_expiry:new Date(Number(watched.expiration)).toISOString()});
 if(saved.error||saved.data!==true)throw Error('Watch response binding unconfirmed');
 return {status:'active'};
}
export async function receiveRankerWatch(admin:SupabaseClient,headers:Headers){
 if(isIntegrationsSafeMode())return 503;
 const file=fileId(),id=headers.get('x-goog-channel-id')||'',secret=headers.get('x-goog-channel-token')||'',resource=headers.get('x-goog-resource-id')||'',number=headers.get('x-goog-message-number')||'',state=headers.get('x-goog-resource-state')||'';
 if(!/^[a-f0-9-]{36}$/i.test(id)||!/^\d{1,20}$/.test(number)||!resource||resource.length>512||!secretEqual(secret,token(id,file)))return 403;
 const found=await admin.from('cmpri_ranker_watch_channels').select('status,expires_at,resource_id').eq('hotel_id',HOTEL_ID).eq('file_id',file).eq('id',id).maybeSingle();
 if(found.error)throw Error('Watch registry unavailable');const row=found.data;
 if(!row||!['active','pending'].includes(row.status)||Date.parse(row.expires_at)<=Date.now())return 410;
 if(row.resource_id&&row.resource_id!==resource)return 403;
 if(!row.resource_id&&state!=='sync')return 503;
 if(state==='sync'){
  const expiry=Date.parse(headers.get('x-goog-channel-expiration')||'');if(!Number.isFinite(expiry)||expiry<=Date.now()||expiry>Date.parse(row.expires_at)+60000)return 403;
  const bound=await admin.rpc('cmpri_ranker_bind_watch',{p_hotel:HOTEL_ID,p_id:id,p_resource:resource,p_expiry:new Date(expiry).toISOString(),p_sync:true});if(bound.error||bound.data!==true)return 403;
 }
 const event=await admin.from('cmpri_ranker_watch_events').upsert({channel_id:id,message_number:number},{onConflict:'channel_id,message_number',ignoreDuplicates:true});
 if(event.error)throw Error('Durable watch receipt failed');return 202;
}
export async function processRankerWatch(admin:SupabaseClient){
 if(!process.env.CMPRI_ROOM_RANKER_SPREADSHEET_ID)return {status:'disabled'};
 if(isIntegrationsSafeMode())return {status:'safe-mode'};
 const channels=await admin.from('cmpri_ranker_watch_channels').select('id').eq('hotel_id',HOTEL_ID).eq('file_id',fileId());if(channels.error)throw Error('Watch registry unavailable');
 const ids=(channels.data||[]).map(row=>row.id);if(!ids.length)return {status:'disabled'};
 const pending=await admin.from('cmpri_ranker_watch_events').select('channel_id,message_number').in('channel_id',ids).is('processed_at',null).limit(500);if(pending.error)throw Error('Watch receipts unavailable');
 if(!pending.data?.length)return {status:'idle'};
 const events=pending.data;
 return withRankerWrite(admin,async()=>{
 const verified=await access();
 const observed=await admin.rpc('cmpri_ranker_observe_version',{p_hotel:HOTEL_ID,p_file:verified.file,p_version:verified.version});if(observed.error)throw Error('Version acknowledgement failed');
 for(const event of events){const ack=await admin.from('cmpri_ranker_watch_events').update({processed_at:new Date().toISOString()}).eq('channel_id',event.channel_id).eq('message_number',event.message_number);if(ack.error)throw Error('Watch receipt acknowledgement failed');}
 return {status:'processed',receipts:events.length};
 },false);
}
