export type PoSourceLink={url:string;status:'not-retrieved';kind:'ibuy-offline-pdf'};
/** Evidence extraction only. Never requests, opens, or resolves the source URL.
 * Keep the exact decoded href, including its opaque document identity.
 */
export function offlinePoSourceLinks(source:{text:string;html?:string}):PoSourceLink[]{
 const decode=(value:string)=>value.replace(/&amp;|&#38;|&#x26;/gi,'&').replace(/&quot;/gi,'"');
 const hrefs=[...(source.html||'').matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)].map(m=>decode(m[2]));
 const urls=[...source.text.matchAll(/https:\/\/[^\s<>"]+/gi)].map(m=>decode(m[0]));
 return [...new Set([...hrefs,...urls])].filter(raw=>{
  if(/[\u0000-\u0020\u007f]/.test(raw))return false;
  try{
   const u=new URL(raw);
   return u.protocol==='https:'&&u.hostname==='www.ibuyefficient.com'&&!u.username&&!u.password&&!u.port&&!u.hash&&u.pathname==='/webhook/getemailpotransmission'&&u.searchParams.getAll('data').length===1&&!!u.searchParams.get('data')&&u.searchParams.getAll('token').length===1&&!!u.searchParams.get('token');
  }catch{return false;}
 }).map(url=>({url,status:'not-retrieved',kind:'ibuy-offline-pdf'}));
}
