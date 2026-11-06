import {createHash,createPublicKey,timingSafeEqual,verify,type JsonWebKey} from 'node:crypto';

export function secretEqual(a:unknown,b:string){return typeof a==='string'&&!!b&&timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());}
export async function readPushBody(request:Request){
 const reader=request.body?.getReader();if(!reader)throw Error('Missing body');
 const chunks:Uint8Array[]=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();throw Error('Body limit');}chunks.push(value);}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
type GoogleKey=JsonWebKey&{kid?:string};
let cached:{keys:GoogleKey[];until:number}|undefined;
/** Verify Google's signature AND the intended push service account/audience, never a decoded JWT alone. */
export async function verifyGooglePush(authorization:string|null,audience:string,email:string){
 if(!audience||!email||!authorization?.startsWith('Bearer ')||authorization.length>16384)return false;
 const parts=authorization.slice(7).split('.');if(parts.length!==3||parts.some(s=>!s||!/^[A-Za-z0-9_-]+$/.test(s)))return false;
 let head,claims;
 try{head=JSON.parse(Buffer.from(parts[0],'base64url').toString());claims=JSON.parse(Buffer.from(parts[1],'base64url').toString());}catch{return false;}
 if(!head||typeof head!=="object"||!claims||typeof claims!=="object")return false;
 const now=Date.now()/1000;
 if(head.alg!=='RS256'||typeof head.kid!=='string'||!['accounts.google.com','https://accounts.google.com'].includes(claims.iss)||claims.aud!==audience||claims.email!==email||claims.email_verified!==true||typeof claims.exp!=='number'||claims.exp<=now||typeof claims.iat!=='number'||claims.iat>now+60||now-claims.iat>7200||typeof claims.sub!=='string'||!claims.sub)return false;
 if(!cached||cached.until<Date.now()){
  const response=await fetch('https://www.googleapis.com/oauth2/v3/certs',{redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error('Push signature keys unavailable');
  const body=await readPushBody(new Request('https://offline.invalid',{method:'POST',body:response.body,duplex:'half'} as RequestInit));
  if(!Array.isArray(body.keys)||body.keys.length>20)throw Error('Invalid signature keys');
  cached={keys:body.keys,until:Date.now()+300000};
 }
 const key=cached.keys.find(k=>k.kid===head.kid&&k.kty==='RSA');if(!key)return false;
 try{return verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key,format:'jwk'}),Buffer.from(parts[2],'base64url'));}catch{return false;}
}
