import {importResponseBody} from '@/lib/server/import-response';
import {readImportUpload} from '@/lib/server/import-upload';
import {createHash} from 'node:crypto';
import {NextRequest,NextResponse} from 'next/server';
import {requireCapability} from '@/lib/server/auth';
import {isIntegrationsSafeMode} from '@/lib/server/integrations-safe-mode';
import {HOTEL_ID} from '@/lib/constants';
import {canonicalHistory,planPurchasingHistory} from '@/lib/purchasing-history';
const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(request:NextRequest){
 const auth=await requireCapability(request,'manage_assets');if(!auth)return reply({error:'Permission required'},403);
 if(process.env.CMPRI_PO_ENABLED!=='true')return reply({error:'Purchasing is not enabled'},409);
 const account=process.env.CMPRI_GMAIL_ADDRESS?.trim().toLowerCase();if(!account)return reply({error:'Mailbox identity required'},409);
 const page=Number(request.nextUrl.searchParams.get('page')||0);if(!Number.isInteger(page)||page<0||page>1000)return reply({error:'Invalid page'},400);
 let query=auth.admin.from('cmpri_purchasing_history_records').select('record',{count:'exact'}).eq('hotel_id',HOTEL_ID).eq('account',account);
 const record=request.nextUrl.searchParams.get('record');const kind=request.nextUrl.searchParams.get('kind');if(record)query=query.eq('record_key',record);else if(kind)query=query.eq('kind',kind);
 const result=await query.order('record_key').range(page*50,page*50+49);
 if(result.error)return reply({error:'Could not load purchasing history'},503);
 return reply({records:result.data.map(r=>r.record),total:result.count,page});
}
export async function POST(request:NextRequest){
 const auth=await requireCapability(request,'operate_integrations');if(!auth)return reply({error:'Integration-operator permission required'},403);
 if(process.env.CMPRI_PO_ENABLED!=='true')return reply({error:'Purchasing is not enabled'},409);
 const account=process.env.CMPRI_GMAIL_ADDRESS?.trim().toLowerCase();if(!account)return reply({error:'Mailbox identity required'},409);
 try{
  // Bound the stream itself, including requests without Content-Length.
  const reader=request.body?.getReader();if(!reader)return reply({error:'Missing bundle'},400);
  const chunks:Uint8Array[]=[];let length=0;while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>12*1024*1024){await reader.cancel();return reply({error:'Bundle exceeds 12 MiB'},413);}chunks.push(value);}
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(body.upload){const uploaded=await readImportUpload(auth.admin,auth.principal.hotelId,auth.principal.identity.id,body.upload,'purchasing-history');body.bundle=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(uploaded.bytes));}
  const plan=planPurchasingHistory(body.bundle),digest=createHash('sha256').update(canonicalHistory(plan)).digest('hex');
  const counts=Object.fromEntries([...new Set(plan.records.map(r=>r.kind))].map(kind=>[kind,plan.records.filter(r=>r.kind===kind).length]));
  if(body.action==='review')return reply(await importResponseBody(auth.admin,auth.principal.hotelId,auth.principal.identity.id,{digest,counts,sourceCount:plan.sources.length,records:plan.records,inventoryChanged:false}));
  if(body.action!=='import'||body.reviewed!==true||body.digest!==digest)return reply({error:'Review this exact bundle before importing'},409);
  if(process.env.CMPRI_PO_IMPORT_ENABLED!=='true'||isIntegrationsSafeMode())return reply({error:'Historical imports are not enabled'},409);
  const saved=await auth.admin.rpc('cmpri_import_purchasing_history',{p_hotel:HOTEL_ID,p_actor:auth.principal.identity.id,p_account:account,p_digest:digest,p_plan:plan});
  if(saved.error)return reply({error:'Import was not saved. A conflicting source or historical record requires reconciliation.'},409);
  return reply(saved.data);
 }catch{return reply({error:'Invalid or incomplete historical evidence bundle'},400);}
}
