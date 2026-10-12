import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const out=new URL('../../.sandbox/',import.meta.url);
export function localSecrets(){
 const secrets=[];
 for(const name of ['local-keys.json','synthetic-users.json']){
  const path=new URL(name,out);if(!existsSync(path))continue;
  const data=JSON.parse(readFileSync(path));
  if(Array.isArray(data))for(const user of data)secrets.push(user.password,user.email);
  else for(const [name,value] of Object.entries(data))if(/key|secret|password|token/i.test(name))secrets.push(value);
 }
 return secrets.filter(s=>typeof s==='string'&&s.length);
}
export function redact(value,secrets=localSecrets()){
 let text=String(value);
 for(const secret of secrets)text=text.replaceAll(secret,'[redacted]');
 return text.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g,'[redacted JWT]')
  .replace(/(bearer\s+)[^\s"'<>]+/gi,'$1[redacted]')
  .replace(/sb_(?:secret|publishable)_[\w-]+/g,'[redacted key]')
  .replace(/([?&](?:access_token|refresh_token|token|apikey|api_key|password)=)[^&\s"'<>]+/gi,'$1[redacted]')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted email]');
}
export function describeResponse({path,method,status,contentType,body},secrets=[]){
 const result={route:new URL(path,'http://127.0.0.1').pathname,method,status,contentType,bodyBytes:Buffer.byteLength(body),bodySha256:createHash('sha256').update(body).digest('hex')};
 // Never retain HTML, headers, request bodies or response payloads. Only Next's
 // structured exception fields are useful for a failed route compilation/runtime.
 const match=body.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
 if(match){try{const err=JSON.parse(match[1]).err;if(err)result.serverException={name:redact(err.name??'',secrets),message:redact(err.message??'',secrets).slice(0,2000),stack:redact(err.stack??'',secrets).split('\n').filter((line,i)=>i===0||/^\s*at /.test(line)).slice(0,10)};}catch{}}
 return result;
}
export async function readJsonResponse(response,path,method='GET'){
 const body=await response.text(),contentType=response.headers.get('content-type')??'';
 try{return JSON.parse(body);}catch{
  const detail=describeResponse({path,method,status:response.status,contentType,body},localSecrets());
  const dest=new URL('http-diagnostics.json',out);
  const prior=existsSync(dest)?JSON.parse(readFileSync(dest)):[];
  if(existsSync(out))writeFileSync(dest,JSON.stringify([...prior,detail],null,2));
  console.log(JSON.stringify({phase:'non-JSON HTTP response',...detail}));
  throw Error('Non-JSON HTTP response: '+JSON.stringify(detail));
 }
}
