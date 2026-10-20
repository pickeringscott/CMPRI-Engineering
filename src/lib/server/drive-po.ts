import {createHash,randomUUID} from 'node:crypto';
import type {SupabaseClient} from '@supabase/supabase-js';
import {HOTEL_ID} from '../constants';
import {inspectPoPdf} from '../po-pdf';
import type {OfflinePo} from '../po-offline-pdf';
import {isIntegrationsSafeMode} from './integrations-safe-mode';
import {DRIVE_PO_FOLDER as FOLDER,DRIVE_PO_ACCOUNT as ACCOUNT,DRIVE_PO_ACTOR as ACTOR,DRIVE_PO_CALLBACK,channelToken,secretEqual,diagnoseDriveAccess,existingDriveToken,inspectDriveAccess,listDrivePoFiles,readDrivePoPdf,driveRequest,DriveAccessError,type DrivePoFile} from './drive-po-api';
type Channel={id:string;folder_id:string;resource_id:string|null;expires_at:string;status:string;sync_received_at:string|null};
type Cached={file_id:string;version:string;document_sha256:string|null;metadata:DrivePoFile;document:OfflinePo|null;external_po:string|null;reason:string|null};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function drivePoEnabled(){return process.env.CMPRI_PO_ENABLED==='true'&&process.env.CMPRI_PO_IMPORT_ENABLED==='true'&&!isIntegrationsSafeMode();}
function safeError(e:unknown){return e instanceof DriveAccessError?e.message:e instanceof Error?e.message.slice(0,240):'Drive intake failed';}
async function state(admin:SupabaseClient){
 const r=await admin.from('cmpri_drive_po_state').select('*').eq('folder_id',FOLDER).single();if(r.error)throw Error('Drive state unavailable');return r.data;
}
async function cachedFiles(admin:SupabaseClient){
 const rows:Cached[]=[];for(let offset=0;;offset+=500){const r=await admin.from('cmpri_drive_po_files').select('*').eq('folder_id',FOLDER).order('file_id').range(offset,offset+499);if(r.error)throw Error('Drive cache unavailable');rows.push(...r.data);if(r.data.length<500)break;}return rows;
}
async function saveError(admin:SupabaseClient,e:unknown){await admin.from('cmpri_drive_po_state').update({last_error:safeError(e),last_run_at:new Date().toISOString()}).eq('folder_id',FOLDER);}
/** Authenticated channel headers are only a wake-up. No supplied URL/body is fetched. */
export async function receiveDriveNotification(admin:SupabaseClient,headers:Headers){
 const id=headers.get('x-goog-channel-id')||'',token=headers.get('x-goog-channel-token')||'',resource=headers.get('x-goog-resource-id')||'',number=headers.get('x-goog-message-number')||'',event=headers.get('x-goog-resource-state')||'';
 if(!/^[a-f0-9-]{36}$/i.test(id)||!/^[0-9]{1,20}$/.test(number)||!resource||resource.length>512||!secretEqual(token,channelToken(id)))return 403;
 const found=await admin.from('cmpri_drive_po_channels').select('*').eq('id',id).eq('folder_id',FOLDER).maybeSingle();
 if(found.error)throw Error('Channel registry unavailable');
 const c=found.data as Channel|null;
 if(!c||!['active','pending'].includes(c.status)||Date.parse(c.expires_at)<=Date.now())return 410;
 if(c.resource_id&&c.resource_id!==resource)return 403;
 if(!c.resource_id&&event!=='sync')return 503; // Google may send sync before watch response.
 const uri=headers.get('x-goog-resource-uri')||'';
 let u:URL;try{u=new URL(uri);}catch{return 403;}
 if(!['https://www.googleapis.com','https://drive.googleapis.com'].includes(u.origin)||u.pathname!==`/drive/v3/files/${FOLDER}`||u.username||u.password)return 403;
 if(!['sync','update','add','untrash','remove','trash'].includes(event))return 204;
 if(event==='sync'){
  const expiration=Date.parse(headers.get('x-goog-channel-expiration')||'');
  if(!Number.isFinite(expiration)||expiration<=Date.now()||expiration>Date.parse(c.expires_at)+60000)return 403;
  let update=admin.from('cmpri_drive_po_channels').update({status:'active',expires_at:new Date(expiration).toISOString(),sync_received_at:new Date().toISOString(),resource_id:resource}).eq('id',id);
  update=c.resource_id?update.eq('resource_id',c.resource_id):update.is('resource_id',null);
  const r=await update;
  if(r.error)throw Error('Could not record channel sync');
 }
 const r=await admin.from('cmpri_drive_po_events').upsert({channel_id:id,message_number:number,state:event},{onConflict:'channel_id,message_number',ignoreDuplicates:true});
 if(r.error)throw Error('Could not durably record notification');
 return 202;
}
export async function ensureDriveWatch(admin:SupabaseClient,activate=false){
 if(!drivePoEnabled())throw Error('PO integration is disabled or in safe mode');
 const current=await state(admin);if(!activate&&!current.enabled)return {status:'disabled'};
 const channels=await admin.from('cmpri_drive_po_channels').select('*').eq('folder_id',FOLDER).in('status',['active','pending']).gt('expires_at',new Date().toISOString()).order('expires_at',{ascending:false});
 if(channels.error)throw Error('Channel registry unavailable');
 const active=(channels.data as Channel[]).find(c=>c.status==='active'&&Date.parse(c.expires_at)>Date.now()+6*3600000);
 if(active)return {status:'active',channelId:active.id,expiresAt:active.expires_at,syncReceived:!!active.sync_received_at,account:ACCOUNT,folderId:FOLDER};
 // Never retry uncertain watch creation while the original could still be active.
 const pending=(channels.data as Channel[]).find(c=>c.status==='pending');
 if(pending)return {status:'pending-verification',channelId:pending.id,syncReceived:!!pending.sync_received_at};
 const token=await existingDriveToken(),access=await inspectDriveAccess(token);
 const owner=randomUUID();
 // The operator has authorized this folder; enabling does not grant Google access.
 if(activate){const r=await admin.from('cmpri_drive_po_state').update({enabled:true}).eq('folder_id',FOLDER);if(r.error)throw Error('Could not enable Drive intake');}
 const claim=await admin.rpc('cmpri_claim_drive_po',{p_owner:owner});if(claim.error)throw Error('Drive lease unavailable');if(!claim.data)return {status:'busy'};
 const id=randomUUID(),expiration=Date.now()+23*3600000;
 try{
  const recheck=await admin.from('cmpri_drive_po_channels').select('id,status,expires_at').eq('folder_id',FOLDER).in('status',['active','pending']).gt('expires_at',new Date(Date.now()+6*3600000).toISOString());
  if(recheck.error)throw Error('Channel recheck failed');
  if(recheck.data.length)return {status:recheck.data[0].status,channelId:recheck.data[0].id};
  const inserted=await admin.from('cmpri_drive_po_channels').insert({id,folder_id:FOLDER,status:'pending',expires_at:new Date(expiration).toISOString()});if(inserted.error)throw Error('Could not reserve watch identity');
  const response=await driveRequest<{id:string;resourceId:string;expiration:string}>(token,`files/${FOLDER}/watch`,{method:'POST',body:JSON.stringify({id,type:'web_hook',address:DRIVE_PO_CALLBACK,token:channelToken(id),expiration})});
  if(response.id!==id||!response.resourceId||!Number.isFinite(Number(response.expiration))||Number(response.expiration)<=Date.now()||Number(response.expiration)>expiration+60000)throw Error('Unverified watch response');
  const prior=await admin.from('cmpri_drive_po_channels').select('resource_id').eq('id',id).single();
  if(prior.error||(prior.data.resource_id&&prior.data.resource_id!==response.resourceId))throw Error('Watch response conflicts with sync');
  const saved=await admin.from('cmpri_drive_po_channels').update({status:'active',resource_id:response.resourceId,expires_at:new Date(Number(response.expiration)).toISOString()}).eq('id',id);
  if(saved.error)throw Error('Watch response not saved; outcome uncertain');
  // Old channels overlap safely and expire naturally; no stop request can interrupt the new watch.
  return {status:'active',channelId:id,expiresAt:new Date(Number(response.expiration)).toISOString(),...access};
 }catch(e){
  if(e instanceof DriveAccessError&&e.status>=400&&e.status<500)await admin.from('cmpri_drive_po_channels').update({status:'failed'}).eq('id',id);
  await saveError(admin,e);throw e;
 }finally{await admin.from('cmpri_drive_po_state').update({lease_owner:null,lease_until:null}).eq('folder_id',FOLDER).eq('lease_owner',owner);}
}
/** Only durable pending push notifications can trigger folder discovery. */
export async function processDriveEvents(admin:SupabaseClient){
 if(!drivePoEnabled())return {status:'disabled'};
 const pending=await admin.from('cmpri_drive_po_events').select('channel_id,message_number').is('processed_at',null).order('received_at').limit(500);
 if(pending.error)throw Error('Event queue unavailable');if(!pending.data.length)return {status:'idle'};
 const s=await state(admin);if(!s.enabled)return {status:'disabled'};
 const owner=randomUUID(),claim=await admin.rpc('cmpri_claim_drive_po',{p_owner:owner});
 if(claim.error)throw Error('Drive lease unavailable');if(!claim.data)return {status:'busy'};
 const started=Date.now();
 try{
  const token=await existingDriveToken();await inspectDriveAccess(token);
  const files=await listDrivePoFiles(token),cache=new Map((await cachedFiles(admin)).map(c=>[c.file_id,c]));
  for(let i=0;i<files.length;i+=4){
   if(Date.now()-started>210000)return {status:'pending',reason:'Continue saved event; acquisition time budget reached'};
   await Promise.all(files.slice(i,i+4).map(async f=>{
    if(cache.get(f.id)?.version===f.version)return;
    let document:OfflinePo|null=null,reason:string|null=null,externalPo:string|null=null,sha:string|null=null;
    const size=Number(f.size);
    const bytes=Number.isSafeInteger(size)&&size>0&&size<=10*1024*1024?await readDrivePoPdf(token,f):null;
    if(bytes)sha=createHash('sha256').update(bytes).digest('hex');
    try{if(!bytes)throw Error('PDF size exceeds limit');const parsed=await inspectPoPdf(bytes);document=parsed.offlineOrder;const ids=[...new Set([...parsed.pages.map(p=>p.text).join(' ').matchAll(/Purchase Order #(\d+)/g)].map(m=>m[1]))];externalPo=ids.length===1?ids[0]:null;if(!document)reason='Incomplete or unsupported source table';}
    catch{reason='Unreadable or unsupported PDF';}
    const value:Cached={file_id:f.id,version:f.version!,document_sha256:sha,metadata:f,document,external_po:externalPo,reason};
    const saved=await admin.from('cmpri_drive_po_files').upsert({...value,folder_id:FOLDER,updated_at:new Date().toISOString()},{onConflict:'file_id'});if(saved.error)throw Error('PDF inspection was not saved');cache.set(f.id,value);
   }));
  }
  const finalFiles=await listDrivePoFiles(token);
  const signature=(list:DrivePoFile[])=>JSON.stringify(list.map(f=>[f.id,f.version]).sort((a,b)=>a[0]!.localeCompare(b[0]!)));
  if(signature(files)!==signature(finalFiles))return {status:'pending',reason:'Folder changed during acquisition'};
  const held:{po?:string;fileId?:string;reason:string}[]=[],groups=new Map<string,Cached[]>(),results:{po:string;insertedLines:number}[]=[];
  for(const f of files){const c=cache.get(f.id)!;if(!c.external_po){held.push({fileId:f.id,reason:'Missing or ambiguous explicit PO'});continue;}const g=groups.get(c.external_po)||[];g.push(c);groups.set(c.external_po,g);}
  for(const [po,copies] of groups){
   if(Date.now()-started>270000)return {status:'pending',reason:'Continue saved event; processing time budget reached'};
   if(copies.some(c=>!c.document)){held.push({po,reason:'Incomplete document copy requires review'});continue;}
   if(new Set(copies.map(c=>JSON.stringify(c.document))).size!==1){held.push({po,reason:'Conflicting document copies'});continue;}
   const c=copies.sort((a,b)=>a.file_id.localeCompare(b.file_id))[0],order=c.document!;
   const found=await admin.from('cmpri_po_orders').select('id,supplier').eq('hotel_id',HOTEL_ID).eq('origin','ibuy').eq('external_reference',po);
   if(found.error)throw Error('PO matching unavailable');
   if(found.data.length!==1){held.push({po,reason:'No unique existing exact iBuy PO'});continue;}
   const existing=await admin.from('cmpri_po_lines').select('sku,description,ordered,uom,purchase_unit_price_cents').eq('hotel_id',HOTEL_ID).eq('order_id',found.data[0].id);
   if(existing.error)throw Error('PO lines unavailable');
   if(!['Supplier unresolved','OFFLINE SUPPLIER',order.supplier].includes(found.data[0].supplier)||new Set(existing.data.map(l=>l.sku)).size!==existing.data.length||existing.data.some(l=>{
    const line=order.lines.find(x=>x.sku===l.sku);return !line||line.description!==l.description||line.uom!==l.uom||line.quantity!==Number(l.ordered)||line.unitPriceCents!==Number(l.purchase_unit_price_cents);
   })){held.push({po,reason:'Existing supplier or line conflict'});continue;}
   if(existing.data.length===order.lines.length)continue;
   const url=`https://drive.google.com/file/d/${c.file_id}/view`;
   const document={account:ACCOUNT,sourceKind:'google-drive',folderId:FOLDER,fileId:c.file_id,sourceMessageId:c.file_id,sourceMessageAt:c.metadata.modifiedTime,sourceUrl:url,sourceUrlSha256:hash(url),documentSha256:c.document_sha256,order};
   const saved=await admin.rpc('cmpri_recover_drive_po_lines',{p_hotel:HOTEL_ID,p_actor:ACTOR,p_document:document});
   if(saved.error){held.push({po,reason:'Database rejected source conflict; review required'});continue;}
   results.push({po,insertedLines:Number(saved.data.insertedLines)});
  }
  const result={status:'processed',files:files.length,ordersEnriched:results.filter(r=>r.insertedLines>0).length,insertedLines:results.reduce((n,r)=>n+r.insertedLines,0),results,held,inventoryChanged:false,receiptsCreated:0};
  const saved=await admin.from('cmpri_drive_po_state').update({last_run_at:new Date().toISOString(),last_result:result,last_error:null}).eq('folder_id',FOLDER);if(saved.error)throw Error('Result not saved');
  // Acknowledge only this snapshot, never events received during processing.
  for(const e of pending.data){const ack=await admin.from('cmpri_drive_po_events').update({processed_at:new Date().toISOString()}).eq('channel_id',e.channel_id).eq('message_number',e.message_number);if(ack.error)throw Error('Event acknowledgement failed');}
  return result;
 }catch(e){await saveError(admin,e);throw e;}
 finally{await admin.from('cmpri_drive_po_state').update({lease_owner:null,lease_until:null}).eq('folder_id',FOLDER).eq('lease_owner',owner);}
}
export async function drivePoStatus(admin:SupabaseClient,checkAccess=false){
 const s=await state(admin),channels=await admin.from('cmpri_drive_po_channels').select('id,status,expires_at,sync_received_at').eq('folder_id',FOLDER).order('created_at',{ascending:false}).limit(10);
 const queue=await admin.from('cmpri_drive_po_events').select('*',{count:'exact',head:true}).is('processed_at',null);
 if(channels.error||queue.error)throw Error('Drive status unavailable');
 let access:unknown;
 if(checkAccess)access=await diagnoseDriveAccess();
 return {checkedAt:new Date().toISOString(),folderId:FOLDER,enabled:s.enabled,integrationEnabled:drivePoEnabled(),channels:channels.data,pendingEvents:queue.count,lastRun:s.last_run_at,lastResult:s.last_result,lastError:s.last_error,...(checkAccess?{access}:{}),commit:process.env.VERCEL_GIT_COMMIT_SHA||null};
}
