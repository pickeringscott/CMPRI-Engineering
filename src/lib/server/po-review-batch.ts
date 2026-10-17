import {createHash} from 'node:crypto';
import {fetchOperationalMessages} from '../integrations/email-provider';
import {parsePoSource} from '../po-source-parser';
import {planPoBatch} from '../po-evidence';
export async function readPoReviewRequest(request:Request){
 const reader=request.body?.getReader();if(!reader)return {};
 const chunks:Uint8Array[]=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8192){await reader.cancel();throw Error('Review request exceeds limit');}chunks.push(value);}
 const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body))throw Error('Invalid review request');
 if(body.pageToken!==undefined&&(typeof body.pageToken!=='string'||body.pageToken.length>2048))throw Error('Invalid continuation');return body;
}
/** A reviewed page can be committed independently; no full-mailbox replay in one request. */
export async function reviewPoMailboxBatch(account:string,pageToken?:string){
 const result=await fetchOperationalMessages({scope:'po-history',withPdfAttachments:true,pageToken});
 if(result.provider!=='gmail'||(result.truncated&&!result.nextPageToken))throw Error('Incomplete mailbox batch');
 const evidence=result.messages.map(m=>parsePoSource({...m,account})),plan=planPoBatch(evidence);
 const digest=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
 return {plan,evidence,digest,sourceCount:result.messages.length,pageToken:pageToken||null,nextPageToken:result.nextPageToken||null,complete:!result.nextPageToken};
}
