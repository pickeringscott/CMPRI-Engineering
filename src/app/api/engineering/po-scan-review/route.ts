import {NextRequest,NextResponse} from 'next/server';
import {requireCapability} from '@/lib/server/auth';
import {isIntegrationsSafeMode} from '@/lib/server/integrations-safe-mode';
import {readPoReviewRequest,reviewPoMailboxBatch} from '@/lib/server/po-review-batch';
export async function POST(request:NextRequest){
 const auth=await requireCapability(request,'operate_integrations');if(!auth)return NextResponse.json({error:'Integration operator access required.'},{status:403});
 if(process.env.CMPRI_PO_REVIEW_SCAN_ENABLED!=='true'||isIntegrationsSafeMode())return NextResponse.json({error:'PO review scan is not enabled.'},{status:409});
 const account=process.env.CMPRI_GMAIL_ADDRESS?.trim().toLowerCase();if(!account)return NextResponse.json({error:'Configured mailbox identity is required.'},{status:409});
 let body;try{body=await readPoReviewRequest(request);}catch{return NextResponse.json({error:'Invalid review request.'},{status:400});}
 try{return NextResponse.json({...await reviewPoMailboxBatch(account,body.pageToken),scope:'Purchasing history including archived and recoverable Trash',readOnly:true,persisted:0},{headers:{'Cache-Control':'no-store'}});}
 catch{return NextResponse.json({error:'Mailbox review failed. No records were written.'},{status:502});}
}
