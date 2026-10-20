import {createHmac,timingSafeEqual} from 'node:crypto';
export const DRIVE_PO_FOLDER='18V2KjCHw2o0uQCVFzu2GGxJ9PghGS7AD';
export const DRIVE_PO_ACCOUNT='maint.cmpri@hawkeyehotels.com';
export const DRIVE_PO_ACTOR='750f77bf-7d5d-4ca6-8421-e025edea87ba';
export const DRIVE_PO_CALLBACK='https://www.cmpri-engineering.com/api/integrations/drive-po/notify';
export type DrivePoFile={id:string;name:string;mimeType:string;parents?:string[];trashed?:boolean;size?:string;version?:string;modifiedTime?:string;md5Checksum?:string};
const API='https://www.googleapis.com/drive/v3/';
export class DriveAccessError extends Error{
 stage:string;status:number;
 constructor(stage:string,status:number){super(`Drive ${stage} failed (${status}); no access grant was changed.`);this.stage=stage;this.status=status;}
}
export function channelToken(id:string,secret=process.env.CRON_SECRET){
 if(!secret)throw Error('Existing CRON_SECRET required');
 return createHmac('sha256',secret).update(`cmpri-drive-po:${DRIVE_PO_FOLDER}:${id}`).digest('hex');
}
export function secretEqual(a:string,b:string){
 const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);
}
/** Refresh only the existing grant. No scope parameter, consent, credentials or permissions are created. */
export async function existingDriveToken(){
 const client_id=process.env.CMPRI_GMAIL_CLIENT_ID,client_secret=process.env.CMPRI_GMAIL_CLIENT_SECRET,refresh_token=process.env.CMPRI_GMAIL_REFRESH_TOKEN;
 if(!client_id||!client_secret||!refresh_token)throw new DriveAccessError('existing OAuth configuration',503);
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000),
  headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id,client_secret,refresh_token,grant_type:'refresh_token'})});
 if(!response.ok)throw new DriveAccessError('existing OAuth refresh',response.status);
 const result=await response.json();
 if(typeof result.access_token!=='string'||!result.access_token)throw new DriveAccessError('existing OAuth response',502);
 return result.access_token as string;
}
export async function driveRequest<T>(token:string,path:string,init:RequestInit={}):Promise<T>{
 if(!/^(about\?|files(?:\?|\/[A-Za-z0-9_-]+(?:\?|\/watch))|channels\/stop$)/.test(path))throw Error('Unexpected Drive operation');
 const response=await fetch(API+path,{...init,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...init.headers},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(25000)});
 if(!response.ok)throw new DriveAccessError('API request',response.status);
 if(response.status===204)return undefined as T;
 return response.json() as Promise<T>;
}
export async function inspectDriveAccess(token:string){
 const about=await driveRequest<{user:{emailAddress:string}}>(token,'about?fields=user(emailAddress)');
 if(about.user?.emailAddress?.toLowerCase()!==DRIVE_PO_ACCOUNT)throw new DriveAccessError('account identity mismatch',403);
 const folder=await driveRequest<DrivePoFile>(token,`files/${DRIVE_PO_FOLDER}?fields=id,name,mimeType,trashed&supportsAllDrives=true`);
 if(folder.id!==DRIVE_PO_FOLDER||folder.trashed||folder.mimeType!=='application/vnd.google-apps.folder')throw Error('Configured PO folder unavailable');
 return {account:about.user.emailAddress,folderId:folder.id,folderName:folder.name};
}
export async function listDrivePoFiles(token:string){
 const files:DrivePoFile[]=[],seen=new Set<string>();let pageToken='';
 do{
  const q=new URLSearchParams({q:`'${DRIVE_PO_FOLDER}' in parents and trashed = false and mimeType = 'application/pdf'`,
   fields:'nextPageToken,incompleteSearch,files(id,name,mimeType,parents,trashed,size,version,modifiedTime,md5Checksum)',pageSize:'100',supportsAllDrives:'true',includeItemsFromAllDrives:'true'});
  if(pageToken)q.set('pageToken',pageToken);
  const page=await driveRequest<{files:DrivePoFile[];nextPageToken?:string;incompleteSearch?:boolean}>(token,'files?'+q);
  if(page.incompleteSearch||!Array.isArray(page.files))throw Error('Incomplete Drive inventory');
  for(const f of page.files){if(!/^[A-Za-z0-9_-]+$/.test(f.id)||!f.version||!f.parents?.includes(DRIVE_PO_FOLDER)||f.trashed||f.mimeType!=='application/pdf'||seen.has(f.id))throw Error('Unverified folder inventory');seen.add(f.id);files.push(f);}
  if(files.length>2000)throw Error('PO folder exceeds reviewed intake limit');
  const next=page.nextPageToken||'';if(next&&next===pageToken)throw Error('Drive pagination repeated');pageToken=next;
 }while(pageToken);
 return files;
}
export async function readDrivePoPdf(token:string,file:DrivePoFile){
 if(!file.parents?.includes(DRIVE_PO_FOLDER)||file.mimeType!=='application/pdf'||file.trashed||!/^[A-Za-z0-9_-]+$/.test(file.id)||!file.version)throw Error('Verified PDF identity required');
 const size=Number(file.size);if(!Number.isSafeInteger(size)||size<=0||size>10*1024*1024)throw Error('PDF size exceeds limit');
 const response=await fetch(`${API}files/${file.id}?alt=media&supportsAllDrives=true`,{headers:{Authorization:`Bearer ${token}`},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(25000)});
 if(!response.ok)throw new DriveAccessError('PDF read',response.status);
 const reader=response.body?.getReader();if(!reader)throw Error('Missing PDF body');
 const parts:Uint8Array[]=[];let length=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>10*1024*1024)throw Error('PDF body exceeds limit');parts.push(value);}}finally{await reader.cancel();}
 if(length!==size)throw Error('PDF size changed during acquisition');
 const current=await driveRequest<DrivePoFile>(token,`files/${file.id}?fields=id,version,parents,trashed,mimeType&supportsAllDrives=true`);
 if(current.version!==file.version||current.trashed||!current.parents?.includes(DRIVE_PO_FOLDER)||current.mimeType!=='application/pdf')throw Error('PDF changed or left the folder during acquisition');
 return new Uint8Array(Buffer.concat(parts));
}
