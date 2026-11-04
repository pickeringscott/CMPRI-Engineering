import designs from '../../../lib/designs.json';
export async function GET(request,{params}){
 const {layout}=await params;
 if(!['desktop','mobile'].includes(layout))return new Response('Not found',{status:404});
 const key=JSON.stringify(process.env.NEXT_PUBLIC_GIPHY_API_KEY||'').replaceAll('<','\\u003c');
 // The key is intentionally client-side for direct GIPHY API calls.
 const escaped=key.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll("'",'&#x27;');
 return new Response(designs[layout].replace('&quot;__RUNTIME_KEY__&quot;',escaped),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
}
