import {NextRequest,NextResponse} from 'next/server';
import {requireCapability} from '@/lib/server/auth';
import {isIntegrationsSafeMode} from '@/lib/server/integrations-safe-mode';
import {readPoReviewRequest,reviewPoMailboxBatch} from '@/lib/server/po-review-batch';
import {historyFromMailboxReview} from '@/lib/purchasing-history';
import {persistReviewedPoPlan} from '@/lib/server/po-import';
import {HOTEL_ID} from '@/lib/constants';
/** Explicit reviewed import: verified PO identities plus history; never stock or receipts. */
export async function POST(request:NextRequest){
 const auth=await requireCapability(request,'operate_integrations');if(!auth)return NextResponse.json({error:'Integration-operator permission required.'},{status:403});
 if(process.env.CMPRI_PO_ENABLED!=='true'||process.env.CMPRI_PO_IMPORT_ENABLED!=='true'||isIntegrationsSafeMode())return NextResponse.json({error:'Reviewed PO imports are not enabled.'},{status:409});
 const account=process.env.CMPRI_GMAIL_ADDRESS?.trim().toLowerCase();if(!account)return NextResponse.json({error:'Configured mailbox identity required.'},{status:409});
 let body;try{body=await readPoReviewRequest(request);}catch{return NextResponse.json({error:'Invalid review request.'},{status:400});}
 if(body.importReviewed!==true||typeof body.digest!=='string'||!/^[a-f0-9]{64}$/.test(body.digest))return NextResponse.json({error:'Review this source batch before importing.'},{status:400});
 try{
  const batch=await reviewPoMailboxBatch(account,body.pageToken);if(batch.digest!==body.digest)return NextResponse.json({error:'Source batch changed. Review it again before import.'},{status:409});
  const history=historyFromMailboxReview(batch.plan);
  const saved=await auth.admin.rpc('cmpri_import_purchasing_history',{p_hotel:HOTEL_ID,p_actor:auth.principal.identity.id,p_account:account,p_digest:batch.digest,p_plan:history});
  if(saved.error)return NextResponse.json({error:'Source conflict requires reconciliation. This batch was not saved.'},{status:409});
  const active=await persistReviewedPoPlan(auth.admin,HOTEL_ID,auth.principal.identity.id,batch.plan);
  return NextResponse.json({activeOrders:active.orders,held:active.held,recordsSaved:history.records.length,sourceCount:history.sources.length,nextPageToken:batch.nextPageToken,complete:batch.complete,inventoryChanged:false,receiptsCreated:0},{headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:'Batch import could not be confirmed. Retrying the reviewed batch is idempotent.'},{status:502});}
}
