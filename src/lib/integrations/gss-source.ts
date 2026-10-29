import {configuredEmailProvider} from './email-provider';
type Json=Record<string,unknown>;
type MimePart={mimeType?:string;body?:{data?:string;attachmentId?:string};parts?:MimePart[];headers?:{name:string;value:string}[]};
async function jsonRequest(url:string,init:RequestInit,stage:string):Promise<Json>{
 const response=await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(25000)});
 if(!response.ok)throw Error('GSS source request unavailable ('+response.status+').');
 const reader=response.body?.getReader();if(!reader)throw Error('Missing GSS '+stage+' response');
 const chunks:Uint8Array[]=[];let size=0;while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>20*1024*1024){await reader.cancel();throw Error('GSS source response exceeds limit');}chunks.push(part.value);}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function accessToken(){
 const client_id=process.env.CMPRI_GMAIL_CLIENT_ID,client_secret=process.env.CMPRI_GMAIL_CLIENT_SECRET,refresh_token=process.env.CMPRI_GMAIL_REFRESH_TOKEN;
 if(!client_id||!client_secret||!refresh_token)throw Error('Existing GSS source credential unavailable');
 const response=await jsonRequest('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id,client_secret,refresh_token,grant_type:'refresh_token'})},'OAuth');
 if(typeof response.access_token!=='string')throw Error('GSS source token unavailable');return response.access_token;
}
/** Read the established GSS sender and inline source images using the existing mailbox grant. */
export async function fetchGssSource(cutoff: Date) {
 if (configuredEmailProvider() !== "gmail") throw new Error("The verified GSS source requires the configured Gmail mailbox.");
 const bearer = await accessToken(), headers = {authorization:`Bearer ${bearer}`};
 const base=`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(process.env.CMPRI_GMAIL_USER || "me")}`;
 const list=await jsonRequest(`${base}/messages?${new URLSearchParams({q:'from:taylor.johnson@hawkeyehotels.com subject:"Hawkeye Hotel Weekly GSS Update" newer_than:60d',maxResults:'20'})}`,{headers},"Gmail list");
 for(const candidate of (list.messages || []) as {id:string}[]) {
  const row=await jsonRequest(`${base}/messages/${encodeURIComponent(candidate.id)}?format=full`,{headers},"Gmail retrieval");
  if(Number(row.internalDate)>cutoff.getTime())continue;
  const payload=row.payload as MimePart & {headers?:{name:string;value:string}[]};
  const header=(name:string)=>payload.headers?.find(h=>h.name.toLowerCase()===name)?.value || "";
  if(!/^(?:"?Taylor Johnson"?\s*<)?taylor\.johnson@hawkeyehotels\.com>?$/i.test(header('from').trim()))continue;
  const matched=header('subject').match(/^Hawkeye Hotel Weekly GSS Update\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})$/i);if(!matched)continue;
  const date=`${matched[3]}-${matched[1].padStart(2,'0')}-${matched[2].padStart(2,'0')}`;
  if(!Number.isFinite(Date.parse(date))||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date||date>cutoff.toISOString().slice(0,10))continue;
  const parts:MimePart[]=[];const visit=(part:MimePart)=>{if(['image/png','image/jpeg'].includes(part.mimeType||''))parts.push(part);for(const child of part.parts||[])visit(child);};visit(payload);
  if(!parts.length||parts.length>20)throw new Error("GSS source image coverage is outside the supported bound.");
  let bytes=0;const images:string[]=[];
  for(const part of parts){
   const body=part.body?.data ? {data:part.body.data}:part.body?.attachmentId ? await jsonRequest(`${base}/messages/${encodeURIComponent(candidate.id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,{headers},"Gmail PDF attachment"):null;
   if(!body||typeof body.data!=='string')throw new Error("GSS image source is incomplete.");
   const image=Buffer.from(body.data,'base64url');bytes+=image.length;if(image.length>2*1024*1024||bytes>12*1024*1024)throw new Error("GSS source image limit exceeded.");
   images.push(`data:${part.mimeType};base64,${image.toString('base64')}`);
  }
  return {messageId:candidate.id,date,images};
 }
 return null;
}

