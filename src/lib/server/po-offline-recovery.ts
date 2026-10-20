import {createHash} from 'node:crypto';
import type {SupabaseClient} from '@supabase/supabase-js';
import {inspectPoPdf} from '../po-pdf';
import {offlinePoSourceLinks} from '../po-source-links';
import type {PoSource} from '../po-source-parser';
import type {OfflinePo} from '../po-offline-pdf';

export type BoundOfflineDocument={
 account:string;sourceMessageId:string;sourceMessageAt:string;
 sourceUrl:string;sourceUrlSha256:string;documentSha256:string;order:OfflinePo;
};
const hash=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
/** Only already-obtained bytes enter this function. There is deliberately no URL loader.
 * The caller supplies the original mailbox message and the exact acquisition link.
 */
export async function bindOfflinePoDocument(source:PoSource,bytes:Uint8Array,input:{sourceUrl:string;expectedPo:string;expectedSha256?:string}):Promise<BoundOfflineDocument>{
 if(!source?.account||!source.id||!Number.isFinite(Date.parse(source.messageAt)))throw Error('Original mailbox/message identity required.');
 if(!offlinePoSourceLinks(source).some(link=>link.url===input.sourceUrl))throw Error('Document link is not present in the original email.');
 if(!/^\d+$/.test(input.expectedPo))throw Error('Explicit target PO required.');
 const pdf=await inspectPoPdf(bytes);
 if(input.expectedSha256&&pdf.sha256!==input.expectedSha256)throw Error('Document bytes changed.');
 if(!pdf.offlineOrder)throw Error('Offline PO layout or totals require review.');
 if(pdf.offlineOrder.externalPo!==input.expectedPo)throw Error('Document PO does not match the recovery target.');
 return {account:source.account,sourceMessageId:source.id,sourceMessageAt:source.messageAt,sourceUrl:input.sourceUrl,sourceUrlSha256:hash(input.sourceUrl),documentSha256:pdf.sha256,order:pdf.offlineOrder};
}
export function offlineRecoveryDigest(documents:BoundOfflineDocument[]){return hash(JSON.stringify(documents));}
/** Server-only reviewed persistence boundary, independently callable by a future authorized
 * acquisition workflow. Existing mailbox scans do not invoke it or fetch source links.
 */
export async function persistReviewedOfflineRecovery(admin:SupabaseClient,hotelId:string,actorId:string,documents:BoundOfflineDocument[],reviewedDigest:string){
 if(!hotelId||!actorId||!documents.length||documents.length>1000||offlineRecoveryDigest(documents)!==reviewedDigest)throw Error('Review the exact recovery batch before saving.');
 for(const document of documents){
  if(hash(document.sourceUrl)!==document.sourceUrlSha256||!offlinePoSourceLinks({text:document.sourceUrl}).some(link=>link.url===document.sourceUrl)||!/^[a-f0-9]{64}$/.test(document.documentSha256))throw Error('Invalid document binding.');
 }
 const results=[];
 for(const document of documents){
  const result=await admin.rpc('cmpri_recover_offline_po_lines',{p_hotel:hotelId,p_actor:actorId,p_document:document});
  results.push({externalPo:document.order.externalPo,...(result.error?{error:result.error.message}:{result:result.data})});
 }
 return {results,inventoryChanged:false,receiptsCreated:0};
}
