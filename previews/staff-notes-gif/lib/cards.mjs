export function safeGiphyUrl(value, media=false) {
  try { const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(media?u.hostname.endsWith('.giphy.com'):['giphy.com','www.giphy.com'].includes(u.hostname))?value:null; }catch{return null;}
}
export function externalCard(item) {
  if(item?.provider!=='giphy'||typeof item.id!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(item.id))return null;
  const canonicalUrl=safeGiphyUrl(item.canonicalUrl);if(!canonicalUrl)return null;
  return {kind:'external-link',provider:'giphy',id:item.id,title:String(item.title||'GIF').slice(0,200),canonicalUrl,attribution:'GIPHY'};
}
export function giphyResult(item) {
  const card=externalCard({provider:'giphy',id:item.id,title:item.title,canonicalUrl:item.url});const r=item.images?.fixed_width;
  const previewUrl=safeGiphyUrl(r?.url,true);if(!card||!previewUrl)throw Error('GIPHY returned an invalid result. Please retry.');
  return {...card,previewUrl,width:Number(r.width)||200,height:Number(r.height)||150};
}
// Runs in the browser: exact query, original order/URLs, no proxy or cache.
export async function searchGiphy({key,query,offset=0,signal,fetcher=fetch}) {
  if(!key)throw Error('GIPHY search needs an approved web API key.');
  const url=new URL('https://api.giphy.com/v1/gifs/search');url.search=new URLSearchParams({api_key:key,q:query,limit:'24',offset:String(offset),rating:'pg',lang:'en'}).toString();
  const response=await fetcher(url,{signal,cache:'no-store',credentials:'omit'});
  if(!response.ok)throw Error(response.status===429?'GIPHY search limit reached. Try again later.':'GIPHY search could not complete. Check access and retry.');
  const data=await response.json();if(!Array.isArray(data.data))throw Error('GIPHY returned an invalid response.');
  return {items:data.data.map(giphyResult),hasMore:offset+data.data.length<(data.pagination?.total_count||0)};
}


// Shared browser-direct transport for the supplied HTML designs.
export async function requestGiphy({key,path='/trending',params={},signal,fetcher=fetch}){
 if(!key)throw Error('GIPHY needs an approved web API key.');
 if(!/^\/(trending|search|[a-zA-Z0-9_-]{1,200})$/.test(path)&&path!=='')throw Error('Invalid GIPHY endpoint.');
 const url=new URL('https://api.giphy.com/v1/gifs'+path);
 url.search=new URLSearchParams({api_key:key,...params}).toString();
 const response=await fetcher(url,{signal,cache:'no-store',credentials:'omit'});
 if(!response.ok)throw Error(response.status===429?'GIPHY test limit reached. Please try again later.':'GIPHY is unavailable. Please try again.');
 const data=await response.json();
 if(!data.data)throw Error('GIPHY returned an invalid response.');
 return data;
}
