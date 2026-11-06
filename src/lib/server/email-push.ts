import {randomUUID} from 'node:crypto';
import type {SupabaseClient} from '@supabase/supabase-js';
import {HOTEL_ID,CANONICAL_APP_URL} from '../constants';
import {configuredEmailProvider,fetchOperationalMessages,mailboxPushRequest,type EmailProvider} from '../integrations/email-provider';
import {saveOperationalRecord} from './email-ingest';
import {isIntegrationsSafeMode} from './integrations-safe-mode';
import {secretEqual,verifyGooglePush} from './email-push-auth';

type State={provider:EmailProvider;mailbox:string;enabled:boolean;subscription_id:string|null;history_id:string|null;page_token:string|null;expires_at:string|null;watch_status:string;last_received_at:string|null;last_processed_at:string|null;last_error:string|null};
type PushEvent={id:number;message_id:string|null;history_id:string|null};
const CALLBACK=CANONICAL_APP_URL+'/api/integrations/email/push';
export function emailPushEnabled(){return process.env.CMPRI_EMAIL_PUSH_ENABLED==='true'&&!isIntegrationsSafeMode();}
function configuration(){
 const provider=configuredEmailProvider();if(!provider)throw Error('Mailbox provider is not configured');
 const mailbox=(provider==='gmail'?process.env.CMPRI_GMAIL_ADDRESS:process.env.CMPRI_MS_MAILBOX)?.trim().toLowerCase();
 if(!mailbox)throw Error('Mailbox identity is required');
 if(provider==='gmail'&&(!/^projects\/[^/]+\/topics\/[^/]+$/.test(process.env.CMPRI_GMAIL_PUSH_TOPIC||'')||!/^projects\/[^/]+\/subscriptions\/[^/]+$/.test(process.env.CMPRI_GMAIL_PUSH_SUBSCRIPTION||'')||!process.env.CMPRI_GMAIL_PUSH_SERVICE_ACCOUNT))throw Error('Gmail Pub/Sub topic, subscription and push service account are required');
 if(provider==='microsoft365'&&(!process.env.CMPRI_MS_TENANT_ID||(process.env.CMPRI_MS_PUSH_CLIENT_STATE||'').length<32))throw Error('Microsoft tenant and push client state (at least 32 characters) are required');
 return {provider,mailbox};
}
async function state(admin:SupabaseClient,provider:EmailProvider){const r=await admin.from('cmpri_email_push_state').select('*').eq('hotel_id',HOTEL_ID).eq('provider',provider).maybeSingle();if(r.error)throw Error('Email push registry unavailable');return r.data as State|null;}
async function update(admin:SupabaseClient,provider:EmailProvider,values:Record<string,unknown>,owner?:string){let q=admin.from('cmpri_email_push_state').update(values).eq('hotel_id',HOTEL_ID).eq('provider',provider);if(owner)q=q.eq('lease_owner',owner);const r=await q.select('provider');if(r.error||!r.data?.length)throw Error('Email push checkpoint failed');}
async function claim(admin:SupabaseClient,provider:EmailProvider,owner:string){const r=await admin.rpc('cmpri_claim_email_push',{p_hotel:HOTEL_ID,p_provider:provider,p_owner:owner});if(r.error)throw Error('Email push lease unavailable');return r.data===true;}

/** Accept only the registered provider/mailbox. Notification payloads never supply fetch URLs. */
export async function receiveEmailPush(admin:SupabaseClient,headers:Headers,body:unknown){
 const config=configuration(),s=await state(admin,config.provider);
 if(!s?.enabled||s.mailbox!==config.mailbox)return 503;
 const events:Array<Record<string,unknown>>=[];
 const envelope=body as {subscription?:unknown;message?:{messageId?:unknown;data?:unknown};value?:unknown};
 if(!envelope||typeof envelope!=='object')return 400;
 if(config.provider==='gmail'){
  if(!await verifyGooglePush(headers.get('authorization'),CALLBACK,process.env.CMPRI_GMAIL_PUSH_SERVICE_ACCOUNT!))return 403;
  const message=envelope.message;
  if(envelope.subscription!==process.env.CMPRI_GMAIL_PUSH_SUBSCRIPTION||!message||typeof message.messageId!=='string'||!/^[0-9]{1,100}$/.test(message.messageId)||typeof message.data!=='string'||message.data.length>8192)return 400;
  let data;try{data=JSON.parse(Buffer.from(message.data,'base64').toString('utf8'));}catch{return 400;}
  if(!data||typeof data!=='object')return 400;
  if(typeof data.emailAddress!=='string'||data.emailAddress.toLowerCase()!==config.mailbox||typeof data.historyId!=='string'||!/^\d{1,30}$/.test(data.historyId))return 403;
  events.push({event_key:message.messageId,history_id:data.historyId});
 }else{
  if(!Array.isArray(envelope.value)||!envelope.value.length||envelope.value.length>100)return 400;
  for(const item of envelope.value){
   if(!item||!secretEqual(item.clientState,process.env.CMPRI_MS_PUSH_CLIENT_STATE!)||item.subscriptionId!==s.subscription_id||!s.subscription_id||item.tenantId!==process.env.CMPRI_MS_TENANT_ID)return 403;
   if(!['created','updated'].includes(item.changeType)||typeof item.resourceData?.id!=='string'||!/^[A-Za-z0-9_+=/-]{1,1024}$/.test(item.resourceData.id))return 400;
   // Graph basic notifications have no reliable unique change ID. Queue each delivery;
   // downstream message persistence is idempotent. Never discard a later update for the same message.
   events.push({event_key:randomUUID(),message_id:item.resourceData.id});
  }
 }
 const inserted=await admin.from('cmpri_email_push_events').upsert(events.map(e=>({...e,hotel_id:HOTEL_ID,provider:config.provider})),{onConflict:'hotel_id,provider,event_key',ignoreDuplicates:true});
 if(inserted.error)throw Error('Could not durably queue email push');
 await update(admin,config.provider,{last_received_at:new Date().toISOString()});
 return 202;
}

/** Serialized imports retain existing deduplication and PO/receiving review boundaries. */
export async function processEmailPush(admin:SupabaseClient){
 if(!emailPushEnabled())return {status:'disabled'};
 const {provider,mailbox}=configuration(),owner=randomUUID();
 if(!await claim(admin,provider,owner))return {status:'busy'};
 try{
  const s=await state(admin,provider);if(!s?.enabled||s.mailbox!==mailbox)return {status:'disabled'};
  const queue=await admin.from('cmpri_email_push_events').select('id,message_id,history_id').eq('hotel_id',HOTEL_ID).eq('provider',provider).is('processed_at',null).order('id').limit(100);
  if(queue.error)throw Error('Email push queue unavailable');
  const events=queue.data as PushEvent[];if(!events.length)return {status:'idle'};
  let ids:string[]=[],next:string|null=null,history:string|null=null;
  if(provider==='gmail'){
   if(!s.history_id)throw Error('Gmail history cursor needs enrollment');
   const query=new URLSearchParams({startHistoryId:s.history_id,maxResults:'25'});if(s.page_token)query.set('pageToken',s.page_token);
   const page=await mailboxPushRequest(provider,'history',{query});
   if(!Array.isArray(page.history)&&page.history!==undefined)throw Error('Invalid Gmail history');
   for(const entry of (page.history||[]) as Array<{messagesAdded?:Array<{message?:{id?:string}}> ;labelsAdded?:Array<{message?:{id?:string}}>}>)for(const change of [...entry.messagesAdded||[],...entry.labelsAdded||[]])if(change.message?.id)ids.push(change.message.id);
   if(typeof page.historyId!=='string'||!/^\d{1,30}$/.test(page.historyId))throw Error('Invalid Gmail history checkpoint');
   if(BigInt(page.historyId)<BigInt(s.history_id))throw Error('Gmail history checkpoint regressed');
   history=page.historyId;next=typeof page.nextPageToken==='string'?page.nextPageToken:null;
  }else ids=events.flatMap(e=>e.message_id?[e.message_id]:[]);
  ids=[...new Set(ids)];
  if(ids.length>1000)throw Error('Email history page exceeds safe import batch; operator recovery required');
  for(let offset=0;offset<ids.length;offset+=100){
   const result=await fetchOperationalMessages({messageIds:ids.slice(offset,offset+100)});
   if(result.provider!==provider||result.truncated)throw Error('Incomplete push message retrieval');
   for(const message of result.messages)await saveOperationalRecord(admin,message);
  }
  // On failure no page checkpoint is advanced. Retries replay safely through the existing message ledger.
  await update(admin,provider,{...(provider==='gmail'?{page_token:next,...(!next?{history_id:history}:{})}:{}),last_processed_at:new Date().toISOString(),last_error:null},owner);
  const acknowledged=provider==='gmail'?events.filter(event=>event.history_id&&BigInt(event.history_id)<=BigInt(history!)):events;
  if(!next&&acknowledged.length){const r=await admin.from('cmpri_email_push_events').update({processed_at:new Date().toISOString()}).eq('hotel_id',HOTEL_ID).eq('provider',provider).in('id',acknowledged.map(e=>e.id));if(r.error)throw Error('Email event acknowledgement failed');}
  return {status:next?'more-pending':'processed',messages:ids.length};
 }catch(error){
  // Provider errors may contain sanitized OAuth diagnostics; do not store credentials or message contents.
  await update(admin,provider,{last_error:error instanceof Error&&error.message.includes('404')?'Provider cursor or subscription expired; operator recovery required':'Email push processing failed; pending events retained'},owner);
  throw error;
 }finally{await update(admin,provider,{lease_owner:null,lease_until:null},owner);}
}

/** Explicit operator enrollment; maintenance only renews a previously enabled watch. */
export async function ensureEmailWatch(admin:SupabaseClient,activate=false){
 if(!emailPushEnabled())return {status:'disabled'};
 const {provider,mailbox}=configuration();let s=await state(admin,provider);
 if(!s){if(!activate)return {status:'not-enrolled'};const r=await admin.from('cmpri_email_push_state').upsert({hotel_id:HOTEL_ID,provider,mailbox},{onConflict:'hotel_id,provider',ignoreDuplicates:true});if(r.error)throw Error('Cannot reserve email watch');s=await state(admin,provider);}
 if(!s||s.mailbox!==mailbox)throw Error('Mailbox changed; explicit registry migration required');
 if(!activate&&!s.enabled)return {status:'not-enrolled'};
 const owner=randomUUID();if(!await claim(admin,provider,owner))return {status:'busy'};
 try{
  s=(await state(admin,provider))!;
  if(s.watch_status==='pending')return {status:'pending-verification'};
  if(s.expires_at&&Date.parse(s.expires_at)>Date.now()+86400000)return {status:'registered',verifiedDelivery:!!s.last_received_at};
  await update(admin,provider,{enabled:true,watch_status:'pending'},owner);
  let result:Record<string,unknown>;
  if(provider==='gmail'){
   result=await mailboxPushRequest(provider,'watch',{body:{topicName:process.env.CMPRI_GMAIL_PUSH_TOPIC!}});
   if(typeof result.historyId!=='string'||!/^\d{1,30}$/.test(result.historyId)||!Number.isFinite(Number(result.expiration))||Number(result.expiration)<=Date.now())throw Error('Unverified Gmail watch response');
   await update(admin,provider,{watch_status:'registered',expires_at:new Date(Number(result.expiration)).toISOString(),...(!s.history_id?{history_id:result.historyId}:{}),last_error:null},owner);
  }else{
   const expirationDateTime=new Date(Date.now()+2*86400000).toISOString();
   result=await mailboxPushRequest(provider,'subscription',{...(s.subscription_id?{id:s.subscription_id}:{}),body:s.subscription_id?{expirationDateTime}:{changeType:'created,updated',notificationUrl:CALLBACK,resource:`users/${mailbox}/messages`,expirationDateTime,clientState:process.env.CMPRI_MS_PUSH_CLIENT_STATE!}});
   if(typeof result.id!=='string'||!(/^[a-f0-9-]{36}$/i.test(result.id))||typeof result.expirationDateTime!=='string'||!(Date.parse(result.expirationDateTime)>Date.now())||(s.subscription_id&&result.id!==s.subscription_id))throw Error('Unverified Microsoft subscription response');
   await update(admin,provider,{subscription_id:result.id,watch_status:'registered',expires_at:result.expirationDateTime,last_error:null},owner);
  }
  return {status:'registered',verifiedDelivery:!!s.last_received_at};
 }catch(error){await update(admin,provider,{last_error:'Watch enrollment or renewal outcome requires verification'},owner);throw error;}
 finally{await update(admin,provider,{lease_owner:null,lease_until:null},owner);}
}

export async function emailPushStatus(admin:SupabaseClient){const provider=configuredEmailProvider();if(!provider)return {enabled:false,provider:null};const s=await state(admin,provider);const q=await admin.from('cmpri_email_push_events').select('id',{head:true,count:'exact'}).eq('hotel_id',HOTEL_ID).eq('provider',provider).is('processed_at',null);if(q.error)throw Error('Email queue status unavailable');return {enabled:emailPushEnabled()&&!!s?.enabled,provider,watchStatus:s?.watch_status||'not-enrolled',expiresAt:s?.expires_at||null,deliveryVerified:!!s?.last_received_at,lastReceivedAt:s?.last_received_at||null,lastProcessedAt:s?.last_processed_at||null,lastError:s?.last_error||null,pending:q.count};}
