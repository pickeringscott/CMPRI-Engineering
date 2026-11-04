import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {isAbsolute,resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {externalCard} from './cards.mjs';
export const MAX_MEDIA=100*1024*1024;
export class PreviewError extends Error {constructor(message,status=400){super(message);this.status=status;}}
export function assertLocal(request) {
  const url=new URL(request.url),directory=process.env.CMPRI_PREVIEW_LOCAL_DATA_DIR;
  if(process.env.VERCEL||!directory||!isAbsolute(directory)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new PreviewError('Saving is unavailable: no approved isolated hosted backend is configured.',503);
  const host=request.headers.get('host')||url.host;
  const incoming=new URL(`${url.protocol}//${host}`);
  if(!['127.0.0.1','localhost','[::1]'].includes(incoming.hostname))throw new PreviewError('Local requests only.',403);
  if(request.headers.get('origin')&&request.headers.get('origin')!==incoming.origin)throw new PreviewError('Cross-origin requests are not allowed.',403);
  if(request.headers.get('sec-fetch-site')==='cross-site')throw new PreviewError('Cross-site requests are not allowed.',403);
  return resolve(directory);
}
export function openStore(directory) {
  mkdirSync(directory,{recursive:true,mode:0o700});
  const db=new DatabaseSync(join(directory,'staff-notes.sqlite'),{timeout:5000});
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL,size INTEGER NOT NULL,bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at TEXT NOT NULL);`);
  return db;
}
export function listNotes(db){return db.prepare('SELECT payload FROM notes ORDER BY created_at,id').all().map(row=>JSON.parse(row.payload));}
export function saveNote(db,input){
  if(!input||!/^[a-zA-Z0-9-]{10,100}$/.test(input.requestId||'')||typeof input.body!=='string'||input.body.length>4000||!Array.isArray(input.attachments)||input.attachments.length>10||!Array.isArray(input.mediaIds)||input.mediaIds.length>10)throw new PreviewError('Invalid note.');
  const attachments=input.attachments.map(item=>{const card=externalCard(item);if(!card)throw new PreviewError('Invalid GIF link.');return card;});
  const local=input.mediaIds.map(id=>{if(typeof id!=='string')throw new PreviewError('Invalid media.');const row=db.prepare('SELECT id,name,type,size FROM media WHERE id=?').get(id);if(!row)throw new PreviewError('An attachment has not finished uploading.');return {...row,url:`/api/media/${row.id}`,saved:true};});
  const note={id:input.requestId,name:'You · isolated test',body:input.body,attachments,local};
  if(!note.body.trim()&&!attachments.length&&!local.length)throw new PreviewError('Enter a comment or attach media.');
  const prior=db.prepare('SELECT payload FROM notes WHERE id=?').get(input.requestId);
  if(prior){const existing=JSON.parse(prior.payload);const {createdAt,time,...base}=existing;if(JSON.stringify(base)!==JSON.stringify(note))throw new PreviewError('This request already saved a different note.',409);return existing;}
  note.createdAt=new Date().toISOString();note.time=new Date(note.createdAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
  db.prepare('INSERT INTO notes(id,payload,created_at) VALUES(?,?,?)').run(note.id,JSON.stringify(note),note.createdAt);return note;
}
export async function readLimited(request,limit){
  if(Number(request.headers.get('content-length'))>limit)throw new PreviewError('Upload exceeds its size limit.',413);
  const reader=request.body?.getReader();if(!reader)return Buffer.alloc(0);const chunks=[];let total=0;
  while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit){await reader.cancel();throw new PreviewError('Upload exceeds its size limit.',413);}chunks.push(Buffer.from(value));}return Buffer.concat(chunks);
}
export function mediaType(bytes){
  if(bytes.subarray(0,6).toString().match(/^GIF8[79]a$/))return 'image/gif';
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
  if(bytes.subarray(4,8).toString()==='ftyp')return 'video/mp4';
  if(bytes.subarray(0,4).equals(Buffer.from([26,69,223,163])))return 'video/webm';
  return 'application/octet-stream';
}
export function saveMedia(db,bytes,name){
  if(!bytes.length||bytes.length>MAX_MEDIA)throw new PreviewError('Choose a nonempty file up to 100 MB.',413);
  const id=randomUUID(),type=mediaType(bytes);name=String(name||'Attachment').replace(/[\r\n\x00-\x1f]/g,'').slice(0,200);
  db.prepare('INSERT INTO media(id,name,type,size,bytes) VALUES(?,?,?,?,?)').run(id,name,type,bytes.length,bytes);
  return {id,name,type,size:bytes.length,url:`/api/media/${id}`,saved:true};
}
export function apiError(error){return Response.json({error:error instanceof PreviewError?error.message:'The operation could not be confirmed. Retry safely.'},{status:error instanceof PreviewError?error.status:503,headers:{'Cache-Control':'private, no-store'}});}
