import {NextResponse,type NextRequest} from 'next/server';
import {manualPreviewReadOnly} from './lib/server/manual-preview';

export function proxy(request:NextRequest){
  if(!manualPreviewReadOnly())return NextResponse.next();
  const path=request.nextUrl.pathname;
  if(path.startsWith('/api/') && (!['GET','HEAD','OPTIONS'].includes(request.method)
    || /^\/api\/(?:integrations|notifications\/dispatch|pool-status\/reconcile|mcp)(?:\/|$)/.test(path)
    || path==='/api/assets/documentation/ocr/dispatch'))return NextResponse.json({error:'This preview is read-only. No live record was changed.'},{status:403});
  const response=NextResponse.next();response.headers.set('X-CMPRI-Preview','read-only');return response;
}
export const config={matcher:['/api/:path*']};
