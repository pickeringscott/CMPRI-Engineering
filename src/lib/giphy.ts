export type GiphyImage={url:string;width:number;height:number};
export type GiphyGif={id:string;title:string;preview:GiphyImage;original:GiphyImage};
function image(value:unknown):GiphyImage|null {
 const v=value as Record<string,unknown>|null;
 if(!v||typeof v.url!=='string')return null;
 try{const url=new URL(v.url);if(url.protocol!=='https:'||url.username||url.password||url.port||!url.hostname.endsWith('.giphy.com'))return null}catch{return null}
 return {url:v.url,width:Number(v.width)||200,height:Number(v.height)||150};
}
export function giphyGif(value:unknown):GiphyGif|null {
 const v=value as {id?:unknown;title?:unknown;images?:{fixed_width?:unknown;original?:unknown}};
 if(!v||typeof v.id!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(v.id))return null;
 const preview=image(v.images?.fixed_width),original=image(v.images?.original);
 return preview&&original?{id:v.id,title:String(v.title||'GIPHY GIF').slice(0,200),preview,original}:null;
}
/** Browser-direct transport from the approved GIF preview. Persist IDs only. */
export async function requestGiphy(path:string,params:Record<string,string>,signal?:AbortSignal) {
 const key=process.env.NEXT_PUBLIC_GIPHY_API_KEY;
 if(!key)throw Error('GIPHY is not configured. You can attach a GIF file using Media.');
 if(!['','/trending','/search'].includes(path))throw Error('Invalid GIF request.');
 const url=new URL('https://api.giphy.com/v1/gifs'+path);url.search=new URLSearchParams({api_key:key,...params}).toString();
 const response=await fetch(url,{signal,cache:'no-store',credentials:'omit'});
 if(!response.ok)throw Error(response.status===429?'GIPHY limit reached. Try again later.':'GIPHY could not be loaded. Try again.');
 const result=await response.json();if(!Array.isArray(result.data))throw Error('GIPHY returned an invalid response.');
 const gifs:GiphyGif[]=(result.data as unknown[]).map(giphyGif).filter((g):g is GiphyGif=>g!==null);
 return {gifs,total:Number(result.pagination?.total_count)||result.data.length};
}
