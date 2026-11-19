import {NextResponse,type NextRequest} from 'next/server';
import {manualPreviewReadOnly} from './lib/server/manual-preview';

export function proxy(request:NextRequest){
  const path=request.nextUrl.pathname;
  // Static review files bypass the app shell and are never served in production.
  if(path==='/previews'||path.startsWith('/previews/')){
    const response=process.env.VERCEL_ENV==='production'
      ?new Response('Not found.',{status:404})
      :NextResponse.next();
    response.headers.set('Cache-Control','no-store');
    response.headers.set('X-Robots-Tag','noindex, nofollow');
    return response;
  }
  if(!manualPreviewReadOnly())return NextResponse.next();
  if(path.startsWith('/api/') && (!['GET','HEAD','OPTIONS'].includes(request.method)
    || /^\/api\/(?:integrations|notifications\/dispatch|pool-status\/reconcile|mcp)(?:\/|$)/.test(path)
    || path==='/api/assets/documentation/ocr/dispatch'))return NextResponse.json({error:'This preview is read-only. No live record was changed.'},{status:403});
  const response=NextResponse.next();response.headers.set('X-CMPRI-Preview','read-only');return response;
}
export const config={matcher:['/api/:path*','/previews/:path*']};
